import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  severityRank,
  severityPrefix,
  shouldSkipPath,
  dedupeFindings,
  normalizeFindings,
  toInlineComments,
  overlaps,
  filterIncremental,
  filterIncrementalByBody,
} from './post-review.mjs';

const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);

test('severity mapping', () => {
  assert.equal(severityPrefix('critical'), 'Important — ');
  assert.equal(severityPrefix('high'), 'Important — ');
  assert.equal(severityPrefix('medium'), 'Nit — ');
  assert.equal(severityPrefix('low'), 'Nit — ');
  assert.equal(severityPrefix(''), '');
  assert.ok(severityRank('critical') > severityRank('low'));
});

test('skips generated/lockfile paths', () => {
  assert.ok(shouldSkipPath('web/package-lock.json'));
  assert.ok(shouldSkipPath('node_modules/x/index.js'));
  assert.ok(shouldSkipPath('src/foo.pb.go'));
  assert.ok(!shouldSkipPath('src/app.py'));
});

test('dedupes one finding per root cause, keeping the highest severity', () => {
  const findings = [
    { path: 'a.py', category: 'bug', existing_code: 'x=1', severity: 'medium', content: 'low' },
    { path: 'a.py', category: 'bug', existing_code: 'x=1', severity: 'high', content: 'high' },
    { path: 'a.py', category: 'bug', existing_code: 'y=2', severity: 'low', content: 'other' },
  ];
  const out = dedupeFindings(findings);
  assert.equal(out.length, 2);
  assert.equal(out.find((f) => f.content === 'high').severity, 'high');
});

test('normalizes: filters paths, Important first, caps nits', () => {
  const findings = [
    { path: 'src/a.py', severity: 'low', content: 'n1', existing_code: '1' },
    { path: 'src/a.py', severity: 'low', content: 'n2', existing_code: '2' },
    { path: 'src/a.py', severity: 'low', content: 'n3', existing_code: '3' },
    { path: 'src/a.py', severity: 'low', content: 'n4', existing_code: '4' },
    { path: 'src/a.py', severity: 'critical', content: 'big' },
    { path: 'web/package-lock.json', severity: 'critical', content: 'skip' },
  ];
  const { inline, deferred } = normalizeFindings(findings, { maxNits: 3 });
  assert.equal(inline.length, 4);
  assert.equal(inline[0].content, 'big');
  assert.equal(deferred.length, 1);
});

test('builds inline comments with start/end and suggestions', () => {
  const [comment] = toInlineComments([{
    path: 'a.py',
    start_line: 3,
    end_line: 5,
    severity: 'high',
    content: 'bad',
    suggestion_code: 'fixed',
  }]);
  assert.equal(comment.line, 5);
  assert.equal(comment.start_line, 3);
  assert.match(comment.body, /^Important — bad/);
  assert.match(comment.body, /```suggestion\nfixed\n```/);
});

test('incremental overlap', () => {
  const existing = [{ path: 'a.py', line: 10, start_line: 8 }];
  assert.ok(overlaps({ path: 'a.py', line: 9 }, existing[0]));
  assert.ok(!overlaps({ path: 'b.py', line: 9 }, existing[0]));
  const filtered = filterIncremental(
    [
      { path: 'a.py', line: 9, body: 'x' },
      { path: 'a.py', line: 20, body: 'y' },
    ],
    existing,
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].line, 20);
});

test('gitea inline shape uses new_position', () => {
  const [comment] = toInlineComments([{
    path: 'a.py',
    start_line: 3,
    end_line: 5,
    severity: 'high',
    content: 'bad',
  }], { provider: 'gitea' });
  assert.equal(comment.new_position, 5);
  assert.equal(comment.path, 'a.py');
  assert.equal(comment.line, undefined);
  assert.equal(comment.side, undefined);
});

test('gitea incremental dedupe matches path + body', () => {
  const existing = [{ path: 'a.py', body: 'Nit — same' }];
  const filtered = filterIncrementalByBody(
    [
      { path: 'a.py', body: 'Nit — same' },
      { path: 'a.py', body: 'Nit — other' },
      { path: 'b.py', body: 'Nit — same' },
    ],
    existing,
  );
  assert.equal(filtered.length, 2);
});

test('end-to-end poster against a mock GitHub API', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url.includes('/pulls/1/comments')) return json(200, []);
      if (req.method === 'GET' && req.url.includes('/issues/1/comments')) return json(200, []);
      if (req.method === 'POST' && req.url.includes('/pulls/1/reviews')) return json(200, { id: 2 });
      if (req.method === 'POST' && req.url.includes('/issues/1/comments')) return json(200, { id: 3 });
      return json(404, { message: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-'));
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(result, JSON.stringify({
    status: 'success',
    llm: { model: 'openai/SGLang' },
    summary: { files_reviewed: 2, total_tokens: 100, elapsed: '12s' },
    comments: [
      {
        path: 'src/a.py',
        start_line: 3,
        end_line: 4,
        severity: 'high',
        content: 'bad',
        suggestion_code: 'ok',
      },
      {
        path: 'web/package-lock.json',
        start_line: 1,
        end_line: 1,
        severity: 'critical',
        content: 'skip',
      },
    ],
  }));

  try {
    await run(process.execPath, ['post-review.mjs', result], {
      cwd: here,
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GIT_TOKEN: 't',
        REPO: 'o/r',
        PR_NUMBER: '1',
        HEAD_SHA: 'abc1234',
        OCR_INCREMENTAL: 'true',
      },
    });
  } finally {
    server.close();
  }

  const review = received.find((r) => r.method === 'POST' && r.url.includes('/reviews'));
  assert.ok(review, 'posted a review');
  const payload = JSON.parse(review.body);
  assert.equal(payload.comments.length, 1, 'lockfile finding was filtered');
  assert.match(payload.comments[0].body, /^Important — /);

  const summary = received.find(
    (r) => r.method === 'POST' && r.url.includes('/issues/1/comments'),
  );
  assert.ok(summary, 'posted the sticky summary');
  assert.match(JSON.parse(summary.body).body, /ocr-summary/);
});

test('end-to-end poster against a mock Gitea API', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        body,
        auth: req.headers.authorization,
      });
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url.includes('/pulls/1/reviews')) return json(200, []);
      if (req.method === 'POST' && req.url.includes('/pulls/1/reviews')) return json(200, { id: 2 });
      if (req.method === 'GET' && req.url.includes('/issues/1/comments')) return json(200, []);
      if (req.method === 'POST' && req.url.includes('/issues/1/comments')) return json(200, { id: 3 });
      return json(404, { message: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gitea-post-'));
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(result, JSON.stringify({
    status: 'success',
    llm: { model: 'SGLang' },
    summary: { files_reviewed: 1, total_tokens: 10, elapsed: '3s' },
    comments: [{
      path: 'src/a.py',
      start_line: 3,
      end_line: 4,
      severity: 'high',
      content: 'bad',
    }],
  }));

  try {
    await run(process.execPath, ['post-review.mjs', result], {
      cwd: here,
      env: {
        ...process.env,
        GIT_PROVIDER: 'gitea',
        GITEA_API_URL: `http://127.0.0.1:${port}/api/v1`,
        GITEA_BOT_LOGIN: 'johnd',
        GIT_TOKEN: 'pat',
        REPO: 'o/r',
        PR_NUMBER: '1',
        HEAD_SHA: 'abc1234',
        OCR_INCREMENTAL: 'true',
      },
    });
  } finally {
    server.close();
  }

  const review = received.find((r) => r.method === 'POST' && r.url.includes('/reviews'));
  assert.ok(review, 'posted a gitea review');
  assert.equal(review.auth, 'token pat', 'gitea uses the token auth scheme');
  const payload = JSON.parse(review.body);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments[0].new_position, 4);
  assert.equal(payload.comments[0].line, undefined);

  const summary = received.find(
    (r) => r.method === 'POST' && r.url.includes('/issues/1/comments'),
  );
  assert.ok(summary, 'posted the gitea sticky summary');
  assert.match(JSON.parse(summary.body).body, /ocr-summary/);
});
