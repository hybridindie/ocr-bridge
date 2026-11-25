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
  buildSummary,
  checkpointFrom,
  resolveOutdated,
  previousRound,
  quotesCode,
  demoteUnquoted,
  carryForwardSummary,
  MARKER,
} from './post-review.mjs';
import { parseCheckpoint } from './receiver.mjs';

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
        content: '`load()` with an empty path returns the parent directory',
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
      content: '`parse("")` raises IndexError',
    }],
  }));

  try {
    await run(process.execPath, ['post-review.mjs', result], {
      cwd: here,
      env: {
        ...process.env,
        GIT_PROVIDER: 'gitea',
        GITEA_API_URL: `http://127.0.0.1:${port}/api/v1`,
        GITEA_BOT_LOGIN: 'alice',
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

test('routing: severity threshold and categories move findings to the summary', () => {
  const findings = [
    { path: 'a.py', severity: 'high', category: 'bug', content: 'high bug' },
    { path: 'a.py', severity: 'medium', category: 'bug', content: 'medium bug' },
    { path: 'a.py', severity: 'low', category: 'style', content: 'low style' },
    { path: 'a.py', severity: 'low', category: 'documentation', content: 'low doc' },
  ];
  const routed = normalizeFindings(findings, { routeSeverityBelow: 'low' });
  assert.deepEqual(routed.inline.map((f) => f.content), ['high bug', 'medium bug']);
  assert.deepEqual(
    routed.deferred.map((f) => f.content),
    ['low style', 'low doc'],
  );

  const byCategory = normalizeFindings(findings, { routeCategories: ['style', 'BUG'] });
  assert.deepEqual(byCategory.inline.map((f) => f.content), ['low doc']);
  assert.deepEqual(
    byCategory.deferred.map((f) => f.content),
    ['high bug', 'medium bug', 'low style'],
  );
});

test('checkpoint gating: only a fully covered run may advance it', () => {
  const env = { OCR_REVIEWED_HEAD: 'abc1234', OCR_BASE_SHA: 'def5678' };
  const complete = { status: 'complete', manifest: { coverage: { failed: [] } } };
  assert.deepEqual(checkpointFrom(complete, env), { head: 'abc1234', base: 'def5678' });
  assert.equal(checkpointFrom(complete, { ...env, OCR_CHECKPOINT: 'false' }), null);
  assert.equal(checkpointFrom(complete, { OCR_REVIEWED_HEAD: 'abc1234' }), null);
  assert.equal(
    checkpointFrom({ ...complete, status: 'partial' }, env),
    null,
  );
  assert.equal(
    checkpointFrom({ status: 'complete', manifest: { coverage: { failed: [{ path: 'a.py' }] } } }, env),
    null,
  );
  assert.equal(checkpointFrom({ status: 'skipped' }, env), null);
});

test('resolve_outdated: only the bot\'s own uncovered outdated threads', async () => {
  const bot = 'ocr-app[bot]';
  // GraphQL reports the App's login without the `[bot]` suffix REST uses.
  const comment = (login, line) => ({
    author: { login: login.replace(/\[bot\]$/, '') }, path: 'a.py', line, originalLine: line,
  });
  const threads = [
    { id: 'stale', isResolved: false, isOutdated: true, comments: { nodes: [comment(bot, 5)] } },
    { id: 'done', isResolved: true, isOutdated: true, comments: { nodes: [comment(bot, 6)] } },
    { id: 'current', isResolved: false, isOutdated: false, comments: { nodes: [comment(bot, 7)] } },
    {
      id: 'replied',
      isResolved: false,
      isOutdated: true,
      comments: { nodes: [comment(bot, 8), comment('alice', 8)] },
    },
    { id: 'covered', isResolved: false, isOutdated: true, comments: { nodes: [comment(bot, 20)] } },
  ];
  const mutations = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (query.includes('resolveReviewThread')) {
        mutations.push(variables.id);
        return res.end(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
      }
      return res.end(JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GITHUB_GRAPHQL_URL = `http://127.0.0.1:${server.address().port}/graphql`;
  const args = {
    provider: 'github',
    token: 't',
    repo: 'o/r',
    pr: 1,
    botLogin: bot,
    findings: [{ path: 'a.py', line: 21, start_line: 19 }],
  };
  try {
    assert.deepEqual(
      await resolveOutdated({ ...args, mode: 'report' }),
      { resolved: 0, wouldResolve: 1, skipped: 2 },
    );
    assert.deepEqual(mutations, [], 'report mode mutates nothing');

    assert.deepEqual(
      await resolveOutdated({ ...args, mode: 'true' }),
      { resolved: 1, wouldResolve: 0, skipped: 2 },
    );
    assert.deepEqual(mutations, ['stale']);

    // Off, Gitea, or an unknown bot login: no GraphQL call at all.
    for (const extra of [{ mode: 'false' }, { mode: 'true', provider: 'gitea' }, { mode: 'true', botLogin: '' }]) {
      assert.deepEqual(
        await resolveOutdated({ ...args, ...extra }),
        { resolved: 0, wouldResolve: 0, skipped: 0 },
      );
    }
    assert.deepEqual(mutations, ['stale']);
  } finally {
    delete process.env.GITHUB_GRAPHQL_URL;
    server.close();
  }
});

test('summary embeds the cross-push checkpoint only when given', () => {
  const base = {
    data: { status: 'complete', llm: { model: 'm' }, summary: {}, comments: [] },
    posted: 0,
    total: 0,
    failed: [],
    deferred: [],
  };
  const withCp = buildSummary({ ...base, checkpoint: { head: 'abc1234', base: 'def5678' } });
  assert.match(withCp, /<!-- ocr-checkpoint: abc1234 base=def5678 -->/);
  assert.doesNotMatch(buildSummary(base), /ocr-checkpoint/);
});

test('summary surfaces coverage failures, warnings and cached tokens', () => {
  const text = buildSummary({
    data: {
      status: 'partial',
      message: 'Review partially complete: 2 finding(s); 1 of 3 selected item(s) failed.',
      llm: { model: 'test-model' },
      summary: {
        files_reviewed: 2, total_tokens: 1000, cache_read_tokens: 400, elapsed: '1m0s',
      },
      comments: [],
      warnings: [{ file: 'a.py', message: 'subtask timed out', type: 'warning' }],
      manifest: {
        coverage: {
          failed: [{ path: 'b.py', classification: 'timeout', reason: 'task deadline exceeded' }],
        },
      },
    },
    posted: 0,
    total: 2,
    failed: [],
    deferred: [],
  });
  assert.match(text, /1m0s/);
  assert.match(text, /1000 tokens \(400 cached\)/);
  assert.match(text, /Not reviewed/);
  assert.match(text, /`b\.py` — timeout: task deadline exceeded/);
  assert.match(text, /Reviewer warnings/);
  assert.match(text, /`a\.py` — subtask timed out/);
});

test('skip summary explains that nothing was reviewable', () => {
  const text = buildSummary({
    data: { message: 'Review skipped: no items were selected.', llm: { model: 'SGLang' } },
    posted: 0,
    total: 0,
    failed: [],
    deferred: [],
  });
  assert.match(text, /No reviewable code changes/);
  assert.doesNotMatch(text, /model `SGLang`/);
});

test('previous round: the marker wins, a legacy summary counts once, a skip counts zero', () => {
  assert.equal(previousRound(undefined), 0);
  assert.equal(previousRound('unrelated comment'), 0);
  assert.equal(previousRound(`${MARKER}\nReviewed 3 file(s)`), 1);
  assert.equal(previousRound(`${MARKER}\nNo reviewable code changes — docs only`), 0);
  assert.equal(previousRound(`${MARKER}\nReviewed\n<!-- ocr-round: 4 -->`), 4);
  const text = buildSummary({
    data: { llm: { model: 'm' }, summary: {} }, posted: 0, total: 0, failed: [], deferred: [], round: 2,
  });
  assert.equal(previousRound(text), 2);
});

test('an Important finding that quotes no code is demoted to a nit', () => {
  assert.equal(quotesCode({ content: '`foo(0)` returns -1' }), true);
  assert.equal(quotesCode({ content: 'this might be wrong' }), false);
  const findings = [
    { path: 'a.rs', severity: 'high', content: 'could race under load' },
    { path: 'a.rs', severity: 'critical', content: '`split(",")` drops the last field' },
    { path: 'a.rs', severity: 'low', content: 'naming' },
  ];
  const demoted = demoteUnquoted(findings);
  assert.equal(demoted[0].severity, 'medium');
  assert.equal(demoted[0].demoted_from, 'high');
  assert.equal(demoted[1].severity, 'critical');
  assert.equal(demoted[2], findings[2]);
  const { inline } = normalizeFindings(findings, { maxNits: 0, demote: true });
  assert.deepEqual(inline.map((f) => f.content), ['`split(",")` drops the last field']);
  assert.equal(normalizeFindings(findings, { maxNits: 0 }).inline.length, 2, 'off without demote');
});

test('carry-forward moves the checkpoint, keeps the review and replaces an earlier note', () => {
  const original = buildSummary({
    data: { status: 'complete', llm: { model: 'm' }, summary: { files_reviewed: 2 } },
    posted: 1,
    total: 1,
    failed: [],
    deferred: [],
    round: 1,
    checkpoint: { head: 'a'.repeat(40), base: 'b'.repeat(40) },
  });
  const once = carryForwardSummary(original, {
    head: 'c'.repeat(40), base: 'd'.repeat(40), previousHead: 'a'.repeat(40),
  });
  assert.deepEqual(parseCheckpoint(once), { head: 'c'.repeat(40), base: 'd'.repeat(40) });
  assert.equal((once.match(/ocr-checkpoint/g) || []).length, 1);
  assert.match(once, /Rebased, patch unchanged; previous review carried forward/);
  assert.match(once, /`aaaaaaa` → `ccccccc`/);
  assert.match(once, /Reviewed 2 file\(s\)/);
  assert.equal(previousRound(once), 1, 'a carry is not a new round');

  const twice = carryForwardSummary(once, {
    head: 'e'.repeat(40), base: 'f'.repeat(40), previousHead: 'c'.repeat(40),
  });
  assert.equal((twice.match(/carried forward/g) || []).length, 1);
  assert.deepEqual(parseCheckpoint(twice), { head: 'e'.repeat(40), base: 'f'.repeat(40) });
});

// A mock GitHub API whose PR already has a sticky summary from `round` reviews.
const mockGithub = async (stickyBody) => {
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
      if (req.method === 'GET' && req.url.includes('/issues/1/comments')) {
        return json(200, stickyBody ? [{ id: 9, body: stickyBody, user: { login: 'bot[bot]' } }] : []);
      }
      if (req.method === 'POST' && req.url.includes('/pulls/1/reviews')) return json(200, { id: 2 });
      if (req.method === 'PATCH' && req.url.includes('/issues/comments/9')) return json(200, { id: 9 });
      if (req.method === 'POST' && req.url.includes('/issues/1/comments')) return json(200, { id: 3 });
      if (req.url.includes('/graphql')) return json(200, { data: {} });
      return json(404, { message: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, server, url: `http://127.0.0.1:${server.address().port}` };
};

const findingsResult = (dir) => {
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(result, JSON.stringify({
    status: 'complete',
    llm: { model: 'm' },
    summary: { files_reviewed: 1 },
    manifest: { coverage: { failed: [] } },
    comments: [
      { path: 'src/a.py', start_line: 3, end_line: 3, severity: 'high', content: '`f(None)` raises TypeError' },
      { path: 'src/a.py', start_line: 9, end_line: 9, severity: 'low', content: 'rename tmp' },
      { path: 'src/b.py', start_line: 1, end_line: 1, severity: 'medium', content: 'add a docstring' },
    ],
  }));
  return result;
};

const postWith = async (url, result, extra = {}) => run(process.execPath, ['post-review.mjs', ...result], {
  cwd: here,
  env: {
    ...process.env,
    GITHUB_API_URL: url,
    GITHUB_GRAPHQL_URL: `${url}/graphql`,
    GIT_TOKEN: 't',
    REPO: 'o/r',
    PR_NUMBER: '1',
    HEAD_SHA: 'abc1234',
    OCR_INCREMENTAL: 'true',
    OCR_RECEIVER_URL: '',
    OCR_REVIEWED_HEAD: 'c'.repeat(40),
    OCR_BASE_SHA: 'd'.repeat(40),
    ...extra,
  },
});

test('nits once: the first review posts nits inline, later reviews keep them in the summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rounds-'));
  const result = findingsResult(dir);
  const inlineOf = (received) => received
    .filter((r) => r.method === 'POST' && r.url.includes('/reviews'))
    .flatMap((r) => JSON.parse(r.body).comments.map((c) => c.body));
  const summaryOf = (received) => JSON.parse(received
    .find((r) => (r.method === 'PATCH' || r.method === 'POST') && r.url.includes('/issues/')).body).body;

  const first = await mockGithub(null);
  try {
    await postWith(first.url, [result]);
  } finally {
    first.server.close();
  }
  assert.equal(inlineOf(first.received).length, 3);
  assert.match(summaryOf(first.received), /<!-- ocr-round: 1 -->/);

  const later = await mockGithub(`${MARKER}\nReviewed\n<!-- ocr-round: 1 -->`);
  try {
    await postWith(later.url, [result]);
  } finally {
    later.server.close();
  }
  assert.deepEqual(inlineOf(later.received), ['Important — `f(None)` raises TypeError']);
  const summary = summaryOf(later.received);
  assert.match(summary, /<!-- ocr-round: 2 -->/);
  assert.match(summary, /<details><summary>Nits \(listed here only/);
  assert.match(summary, /`src\/a\.py` — rename tmp/);
  assert.match(summary, /`src\/b\.py` — add a docstring/);

  const off = await mockGithub(`${MARKER}\nReviewed\n<!-- ocr-round: 1 -->`);
  try {
    await postWith(off.url, [result], { OCR_NITS_FIRST_ROUND_ONLY: 'false' });
  } finally {
    off.server.close();
  }
  assert.equal(inlineOf(off.received).length, 3);
});

test('demoting unquoted Important findings is opt-in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-demote-'));
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(result, JSON.stringify({
    status: 'complete',
    llm: { model: 'm' },
    summary: { files_reviewed: 1 },
    manifest: { coverage: { failed: [] } },
    comments: [
      { path: 'docs/a.md', start_line: 2, end_line: 2, severity: 'high', content: 'The install step is wrong' },
    ],
  }));
  const inlineOf = (received) => received
    .filter((r) => r.method === 'POST' && r.url.includes('/reviews'))
    .flatMap((r) => JSON.parse(r.body).comments.map((c) => c.body));

  const byDefault = await mockGithub(null);
  try {
    await postWith(byDefault.url, [result]);
  } finally {
    byDefault.server.close();
  }
  assert.deepEqual(inlineOf(byDefault.received), ['Important — The install step is wrong']);

  const enabled = await mockGithub(null);
  try {
    await postWith(enabled.url, [result], { OCR_DEMOTE_UNQUOTED_IMPORTANT: 'true' });
  } finally {
    enabled.server.close();
  }
  assert.deepEqual(inlineOf(enabled.received), ['Nit — The install step is wrong']);
});

test('--carry-forward patches the sticky summary and posts no review', async () => {
  const sticky = `${MARKER}\n### 🤖 OpenCodeReview\n\nReviewed 2 file(s)\n\n<!-- ocr-round: 1 -->\n\n`
    + `<!-- ocr-checkpoint: ${'a'.repeat(40)} base=${'b'.repeat(40)} -->`;
  const api = await mockGithub(sticky);
  try {
    await postWith(api.url, ['--carry-forward'], { CHECKPOINT_SHA: 'a'.repeat(40) });
  } finally {
    api.server.close();
  }
  assert.equal(api.received.some((r) => r.url.includes('/reviews')), false);
  const patch = api.received.find((r) => r.method === 'PATCH');
  const body = JSON.parse(patch.body).body;
  assert.deepEqual(parseCheckpoint(body), { head: 'c'.repeat(40), base: 'd'.repeat(40) });
  assert.match(body, /carried forward/);

  const empty = await mockGithub(null);
  try {
    await assert.rejects(
      postWith(empty.url, ['--carry-forward'], { CHECKPOINT_SHA: 'a'.repeat(40) }),
      /no sticky summary/,
    );
  } finally {
    empty.server.close();
  }
  assert.equal(empty.received.some((r) => r.method === 'POST'), false);
});
