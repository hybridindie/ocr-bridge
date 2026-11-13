import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  verifySignature,
  verifyGiteaSignature,
  parseCommand,
  buildJob,
  slug,
  renderMetrics,
  resetMetrics,
  resetSecrets,
  createServer,
  parseGithubApp,
} from './receiver.mjs';

test('webhook signature verification', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"action":"opened"}');
  const good = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.ok(verifySignature(secret, body, good));
  assert.ok(!verifySignature(secret, body, 'sha256=deadbeef'));
  assert.ok(!verifySignature(secret, body, undefined));
  assert.ok(!verifySignature('other', body, good));
});

test('gitea signature verification accepts hex and prefixed forms', () => {
  const secret = 'g3cret';
  const body = Buffer.from('{"action":"opened"}');
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(verifyGiteaSignature(secret, body, hex));
  assert.ok(verifyGiteaSignature(secret, body, `sha256=${hex}`));
  assert.ok(!verifyGiteaSignature(secret, body, 'deadbeef'));
  assert.ok(!verifyGiteaSignature('other', body, hex));
  assert.ok(!verifyGiteaSignature(secret, body, undefined));
});

test('command parsing and instructions', () => {
  assert.deepEqual(parseCommand('/review', ['/review', '/ocr']), {
    command: '/review',
    instruction: '',
  });
  assert.deepEqual(parseCommand('/review focus on auth', ['/review']), {
    command: '/review',
    instruction: 'focus on auth',
  });
  assert.deepEqual(parseCommand('/ocr\nplease check', ['/ocr']), {
    command: '/ocr',
    instruction: 'please check',
  });
  assert.equal(parseCommand('please review', ['/review']), null);
  assert.equal(parseCommand('@open-code-review look', ['/review']).instruction, 'look');
});

test('slug', () => {
  assert.equal(slug('hybridindie/foo_bar'), 'hybridindie-foo-bar');
  assert.equal(slug('A/B'), 'a-b');
});

test('parses the PR-Agent .secrets.toml for reuse', () => {
  const toml = `[github]
deployment_type = "app"
app_id = 4070314
webhook_secret = "whsec"
private_key = """
-----BEGIN RSA PRIVATE KEY-----
redacted
-----END RSA PRIVATE KEY-----
"""

[gitea]
webhook_secret = "other"
`;
  assert.deepEqual(parseGithubApp(toml), { appId: '4070314', webhookSecret: 'whsec' });
});

test('job spec: webhook dedupe name vs manual suffix, env contract', () => {
  const cfg = {
    namespace: 'ocr',
    jobImage: 'img',
    jobServiceAccount: 'ocr-job',
    llmUrl: 'http://gw/v1',
    llmModel: 'openai/SGLang',
    llmSecretName: 'ocr-llm',
    llmSecretKey: 'token',
    extraBody: '',
    concurrency: '8',
    fallbackModel: 'openai/GLM-5.3-Flash',
    maxNits: '3',
    incremental: 'true',
    receiverUrl: 'http://r',
    language: 'English',
    deadlineSeconds: 1800,
  };
  const base = { repo: 'o/r', pr: 7, base: 'main', head: 'abcdef1234', token: 't', cfg };

  const webhook = buildJob({ ...base, now: 1000 });
  assert.equal(webhook.metadata.name, 'ocr-o-r-7-abcdef1');
  assert.equal(webhook.metadata.namespace, 'ocr');
  assert.equal(webhook.spec.backoffLimit, 0);

  const manual = buildJob({
    ...base,
    manual: true,
    instruction: 'focus',
    prBody: 'Closes #1',
    now: 1000,
  });
  assert.match(manual.metadata.name, /^ocr-o-r-7-abcdef1-/);

  const env = Object.fromEntries(
    manual.spec.template.spec.containers[0].env.map((item) => [item.name, item.value]),
  );
  assert.equal(env.OCR_INSTRUCTION, 'focus');
  assert.equal(env.OCR_PR_BODY, 'Closes #1');
  assert.equal(env.OCR_LLM_FALLBACK_MODEL, 'openai/GLM-5.3-Flash');
  assert.equal(env.OCR_MAX_NITS, '3');
  assert.equal(env.OCR_INCREMENTAL, 'true');
  const tokenRef = manual.spec.template.spec.containers[0].env
    .find((item) => item.name === 'OCR_LLM_TOKEN');
  assert.deepEqual(tokenRef.valueFrom.secretKeyRef, { name: 'ocr-llm', key: 'token' });
});

test('job spec: gitea provider wires clone host and api env', () => {
  const cfg = {
    namespace: 'ocr',
    jobImage: 'img',
    jobServiceAccount: 'ocr-job',
    llmUrl: 'http://gw/v1',
    llmModel: 'SGLang',
    llmSecretName: 'ocr-llm',
    llmSecretKey: 'token',
    extraBody: '',
    concurrency: '8',
    fallbackModel: '',
    maxNits: '3',
    incremental: 'true',
    receiverUrl: '',
    language: 'English',
    deadlineSeconds: 1800,
    giteaApiUrl: 'http://gitea-http.gitea.svc.cluster.local:3000/api/v1',
    giteaWebUrl: 'https://git.johndstudios.net',
    giteaBotLogin: 'johnd',
  };
  const job = buildJob({
    repo: 'johnd/brix', pr: 3, base: 'main', head: 'abcdef1234',
    token: 'pat', provider: 'gitea', cfg, now: 1000,
  });
  const env = Object.fromEntries(
    job.spec.template.spec.containers[0].env.map((item) => [item.name, item.value]),
  );
  assert.equal(env.GIT_PROVIDER, 'gitea');
  assert.equal(env.GIT_SCHEME, 'http');
  assert.equal(env.GIT_HOST, 'gitea-http.gitea.svc.cluster.local:3000');
  assert.equal(env.GIT_AUTH_USER, 'oauth2');
  assert.equal(env.GITEA_API_URL, cfg.giteaApiUrl);
  assert.equal(env.GITEA_BOT_LOGIN, 'johnd');
  assert.equal(env.GIT_TOKEN, 'pat');
});

test('gitea webhook -> Job (pull_request_sync + issue_comment gating)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gitea-'));
  const tokenPath = path.join(dir, 'token');
  fs.writeFileSync(tokenPath, 'sa-token');

  const jobs = [];
  const gitea = http.createServer((req, res) => {
    const json = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url.includes('/collaborators/') && req.url.endsWith('/permission')) {
      const permission = req.url.includes('/collaborators/johnd/') ? 'owner' : 'read';
      return json(200, { permission, role_name: permission });
    }
    if (req.url.includes('/pulls/9')) {
      return json(200, { number: 9, base: { ref: 'main' }, head: { sha: 'beef1234' }, body: 'Closes #8' });
    }
    return json(404, { message: 'not found' });
  });
  const k8s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      jobs.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => gitea.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => k8s.listen(0, '127.0.0.1', resolve));

  Object.assign(process.env, {
    GITEA_API_URL: `http://127.0.0.1:${gitea.address().port}/api/v1`,
    GITEA_TOKEN: 'pat',
    GITEA_WEBHOOK_SECRET: 'gwhsec',
    GITEA_BOT_LOGIN: 'johnd',
    OCR_PROVIDERS: 'github,gitea',
    KUBERNETES_API_URL: `http://127.0.0.1:${k8s.address().port}`,
    KUBERNETES_TOKEN_PATH: tokenPath,
    OCR_NAMESPACE: 'ocr',
    OCR_JOB_IMAGE: 'img',
    OCR_LLM_URL: 'http://gw/v1',
    OCR_LLM_MODEL: 'SGLang',
    OCR_COMMANDS: '/review,/ocr',
    OCR_RECEIVER_URL: '',
    OCR_LANGUAGE: 'English',
  });
  resetSecrets();
  resetMetrics();

  const receiver = createServer();
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const send = async (event, payload) => {
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', 'gwhsec').update(raw).digest('hex');
    return fetch(`http://127.0.0.1:${receiver.address().port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-event': event,
        'x-gitea-signature': signature,
        'x-hub-signature-256': `sha256=${signature}`,
      },
      body: raw,
    });
  };

  // push-to-PR arrives as its own event with action `synchronized`
  const synced = await send('pull_request_sync', {
    action: 'synchronized',
    number: 9,
    repository: { full_name: 'johnd/brix' },
    pull_request: { base: { ref: 'main' }, head: { sha: 'beef1234' }, body: 'x', draft: false },
  });
  assert.equal(synced.status, 202);

  // untrusted user is ignored, trusted user creates a manual job
  await send('issue_comment', {
    action: 'created',
    is_pull: true,
    issue: { number: 9 },
    repository: { full_name: 'johnd/brix' },
    comment: { body: '/review', user: { login: 'outsider' } },
  });
  await send('issue_comment', {
    action: 'created',
    is_pull: true,
    issue: { number: 9 },
    repository: { full_name: 'johnd/brix' },
    comment: { body: '/review', user: { login: 'johnd' } },
  });

  for (let i = 0; i < 100 && jobs.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  receiver.close();
  gitea.close();
  k8s.close();

  assert.equal(jobs.length, 2, 'one sync job + one trusted manual job');
  assert.equal(jobs[0].metadata.name, 'ocr-johnd-brix-9-beef123');
  const env = Object.fromEntries(
    jobs[1].spec.template.spec.containers[0].env.map((item) => [item.name, item.value]),
  );
  assert.equal(env.GIT_PROVIDER, 'gitea');
  assert.equal(env.GIT_TOKEN, 'pat');
  assert.equal(env.OCR_PR_BODY, 'Closes #8');
});

test('metrics render', () => {
  resetMetrics();
  const text = renderMetrics();
  assert.match(text, /ocr_jobs_created_total 0/);
  assert.match(text, /# TYPE ocr_reviews_total counter/);
});

test('webhook -> Job end to end (mock GitHub + mock Kubernetes)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-recv-'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(dir, 'key.pem');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const tokenPath = path.join(dir, 'token');
  fs.writeFileSync(tokenPath, 'sa-token');

  const jobs = [];
  const github = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url.endsWith('/installation')) return json(200, { id: 123 });
      if (req.url.includes('/access_tokens')) return json(201, { token: 'inst-token' });
      return json(404, { message: 'not found' });
    });
  });
  const k8s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      jobs.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => k8s.listen(0, '127.0.0.1', resolve));

  Object.assign(process.env, {
    GITHUB_APP_ID: '1',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`,
    KUBERNETES_API_URL: `http://127.0.0.1:${k8s.address().port}`,
    KUBERNETES_TOKEN_PATH: tokenPath,
    OCR_NAMESPACE: 'ocr',
    OCR_JOB_IMAGE: 'img',
    OCR_LLM_URL: 'http://gw/v1',
    OCR_LLM_MODEL: 'openai/SGLang',
    OCR_COMMANDS: '/review,/ocr',
    OCR_ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
    OCR_LLM_FALLBACK_MODEL: '',
    OCR_MAX_NITS: '3',
    OCR_INCREMENTAL: 'true',
    OCR_RECEIVER_URL: '',
    OCR_LANGUAGE: 'English',
  });
  resetSecrets();
  resetMetrics();

  const receiver = createServer();
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

  const payload = JSON.stringify({
    action: 'opened',
    number: 7,
    repository: { full_name: 'o/r' },
    pull_request: {
      base: { ref: 'main' },
      head: { sha: 'abcdef1234' },
      body: 'Closes #1',
      draft: false,
    },
  });
  const signature = `sha256=${crypto.createHmac('sha256', 'whsec').update(payload).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${receiver.address().port}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': signature,
    },
    body: payload,
  });
  assert.equal(response.status, 202);

  for (let i = 0; i < 100 && jobs.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  receiver.close();
  github.close();
  k8s.close();

  assert.equal(jobs.length, 1, 'created exactly one Job');
  const job = jobs[0];
  assert.equal(job.metadata.name, 'ocr-o-r-7-abcdef1');
  const env = Object.fromEntries(
    job.spec.template.spec.containers[0].env.map((item) => [item.name, item.value]),
  );
  assert.equal(env.GIT_TOKEN, 'inst-token');
  assert.equal(env.REPO, 'o/r');
  assert.equal(env.PR_NUMBER, '7');
  assert.equal(env.BASE_REF, 'main');
  assert.equal(env.HEAD_SHA, 'abcdef1234');
  assert.equal(env.OCR_PR_BODY, 'Closes #1');
});

