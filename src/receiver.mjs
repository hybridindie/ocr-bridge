// OpenCodeReview webhook receiver.
//
// GitHub App or Gitea webhook -> HMAC verify -> provider token -> create an
// ephemeral Kubernetes Job that runs `ocr review` and posts the result.
//
// The provider is detected per delivery: Gitea sets `X-Gitea-Event` (it also
// sends the GitHub-compatible `X-Hub-Signature-256`), everything else is
// treated as a GitHub App webhook.
//
// Node stdlib only. GITHUB_API_URL / GITEA_API_URL / KUBERNETES_API_URL are
// overridable so the module can be unit-tested against mock servers.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_COMMANDS = ['/review', '/ocr', '/open-code-review'];
const DEFAULT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

let cachedPrivateKey;
let cachedSaToken;
let cachedApp;

const config = () => {
  const app = loadApp();
  return {
    appId: app.appId,
    webhookSecret: app.webhookSecret,
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || '/secrets/private-key.pem',
    namespace: process.env.OCR_NAMESPACE || 'ocr',
    jobImage: process.env.OCR_JOB_IMAGE,
    jobServiceAccount: process.env.OCR_JOB_SERVICE_ACCOUNT || 'ocr-job',
    llmUrl: process.env.OCR_LLM_URL,
    llmModel: process.env.OCR_LLM_MODEL,
    llmSecretName: process.env.OCR_LLM_SECRET_NAME || 'ocr-llm',
    llmSecretKey: process.env.OCR_LLM_SECRET_KEY || 'token',
    extraBody: process.env.OCR_LLM_EXTRA_BODY || '',
    concurrency: process.env.OCR_CONCURRENCY || '8',
    fallbackModel: process.env.OCR_LLM_FALLBACK_MODEL || '',
    maxNits: process.env.OCR_MAX_NITS || '3',
    incremental: process.env.OCR_INCREMENTAL || 'true',
    receiverUrl: process.env.OCR_RECEIVER_URL || '',
    language: process.env.OCR_LANGUAGE || 'English',
    deadlineSeconds: Number(process.env.OCR_JOB_DEADLINE_SECONDS || 1800),
    commands: (process.env.OCR_COMMANDS || DEFAULT_COMMANDS.join(','))
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedAssociations: (process.env.OCR_ALLOWED_ASSOCIATIONS || DEFAULT_ASSOCIATIONS.join(','))
      .split(',').map((s) => s.trim()).filter(Boolean),
    gh: process.env.GITHUB_API_URL || 'https://api.github.com',
    giteaApiUrl: (process.env.GITEA_API_URL || '').replace(/\/$/, ''),
    giteaToken: process.env.GITEA_TOKEN || '',
    giteaWebhookSecret: process.env.GITEA_WEBHOOK_SECRET || '',
    giteaWebUrl: process.env.GITEA_WEB_URL || '',
    giteaBotLogin: process.env.GITEA_BOT_LOGIN || '',
    providers: (process.env.OCR_PROVIDERS || 'github,gitea')
      .split(',').map((s) => s.trim()).filter(Boolean),
    k8s: process.env.KUBERNETES_API_URL || 'https://kubernetes.default.svc',
  };
};

const parseHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return { scheme: url.protocol.replace(':', ''), host: url.host };
  } catch {
    return {};
  }
};

// Parse the PR-Agent-style `.secrets.toml` so the existing App secret can be
// copied verbatim into the ocr namespace.
export function parseGithubApp(toml) {
  const appId = (toml.match(/^app_id\s*=\s*"?([0-9]+)"?/m) || [])[1];
  const section = String(toml).split(/^\[/m).find((part) => part.startsWith('github]'));
  const webhookSecret = section
    ? (section.match(/^webhook_secret\s*=\s*"?([^"\n]+)"?/m) || [])[1]
    : undefined;
  return { appId, webhookSecret };
}

const loadApp = () => {
  if (cachedApp) return cachedApp;
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_WEBHOOK_SECRET) {
    cachedApp = {
      appId: process.env.GITHUB_APP_ID,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    };
    return cachedApp;
  }
  try {
    const toml = fs.readFileSync(
      process.env.GITHUB_APP_SECRETS_PATH || '/secrets/.secrets.toml',
      'utf8',
    );
    cachedApp = parseGithubApp(toml);
  } catch {
    cachedApp = {};
  }
  return cachedApp;
};

const log = (...args) => console.error(new Date().toISOString(), ...args);

const b64url = (input) => Buffer.from(input).toString('base64url');

const getPrivateKey = () => {
  if (!cachedPrivateKey) cachedPrivateKey = fs.readFileSync(config().privateKeyPath, 'utf8');
  return cachedPrivateKey;
};

const getSaToken = () => {
  if (!cachedSaToken) {
    cachedSaToken = fs
      .readFileSync(
        process.env.KUBERNETES_TOKEN_PATH
          || '/var/run/secrets/kubernetes.io/serviceaccount/token',
        'utf8',
      )
      .trim();
  }
  return cachedSaToken;
};

export const resetSecrets = () => {
  cachedPrivateKey = undefined;
  cachedSaToken = undefined;
  cachedApp = undefined;
};

export function verifySignature(secret, body, header) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return typeof header === 'string'
    && header.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// Gitea sends the digest without the `sha256=` prefix in `X-Gitea-Signature*`
// and the prefixed form in `X-Hub-Signature-256`. Accept either.
export function verifyGiteaSignature(secret, body, header) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const actual = String(header || '').replace(/^sha256=/, '');
  return actual.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function parseCommand(body, commands = DEFAULT_COMMANDS) {
  const text = String(body || '').trim();
  const command = commands.find(
    (c) => text === c || text.startsWith(`${c} `) || text.startsWith(`${c}\n`),
  );
  if (command) return { command, instruction: text.slice(command.length).trim() };
  if (text.startsWith('@open-code-review')) {
    return {
      command: '@open-code-review',
      instruction: text.replace(/^@open-code-review\s*/, '').trim(),
    };
  }
  return null;
}

export function slug(value) {
  return String(value).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const appJwt = (appId) => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(getPrivateKey(), 'base64url')}`;
};

const gh = async (base, path, token, opts = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${opts.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
};

export async function installationToken(repo, cfg = config()) {
  const jwt = appJwt(cfg.appId);
  const installation = await gh(cfg.gh, `/repos/${repo}/installation`, jwt);
  const result = await gh(cfg.gh, `/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST',
  });
  return result.token;
}

// Provider-neutral REST helper. GitHub uses Bearer + the versioned media type;
// Gitea uses its `token` scheme and plain JSON.
export async function providerFetch(cfg, provider, token, path, opts = {}) {
  const base = provider === 'gitea' ? cfg.giteaApiUrl : cfg.gh;
  const auth = provider === 'gitea'
    ? { Authorization: `token ${token}`, Accept: 'application/json' }
    : {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { ...auth, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`${provider} ${opts.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Gitea has no author_association. Treat the repo owner and anyone with write
// access as trusted, mirroring the GitHub OWNER/MEMBER/COLLABORATOR list.
export async function giteaCanReview(cfg, repo, login) {
  if (!cfg.giteaApiUrl || !cfg.giteaToken || !login) return false;
  try {
    const result = await providerFetch(
      cfg,
      'gitea',
      cfg.giteaToken,
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const permission = String(result?.permission || result?.role_name || '').toLowerCase();
    return ['owner', 'admin', 'write', 'maintain'].includes(permission);
  } catch (err) {
    log('gitea permission lookup failed', String(err));
    return false;
  }
}

export function buildJob({
  repo, pr, base, head, token, provider = 'github',
  manual = false, instruction, prBody, cfg = config(), now = Date.now(),
}) {
  const stem = `ocr-${slug(repo.replace('/', '-'))}-${pr}-${head.slice(0, 7)}`;
  const name = (manual ? `${stem}-${now.toString(36)}` : stem).slice(0, 63);

  const giteaUrl = parseHttpUrl(cfg.giteaApiUrl);
  const git = provider === 'gitea'
    ? { scheme: 'http', host: giteaUrl.host || '', authUser: 'oauth2' }
    : { scheme: 'https', host: 'github.com', authUser: 'x-access-token' };

  const env = [
    { name: 'GIT_TOKEN', value: token },
    { name: 'GIT_PROVIDER', value: provider },
    { name: 'GIT_SCHEME', value: git.scheme },
    { name: 'GIT_HOST', value: git.host },
    { name: 'GIT_AUTH_USER', value: git.authUser },
    { name: 'REPO', value: repo },
    { name: 'PR_NUMBER', value: String(pr) },
    { name: 'BASE_REF', value: base },
    { name: 'HEAD_SHA', value: head },
    { name: 'OCR_LLM_URL', value: cfg.llmUrl },
    { name: 'OCR_LLM_MODEL', value: cfg.llmModel },
    { name: 'OCR_USE_ANTHROPIC', value: process.env.OCR_USE_ANTHROPIC || 'false' },
    { name: 'OCR_LLM_PROTOCOL', value: process.env.OCR_LLM_PROTOCOL || 'openai' },
    { name: 'OCR_CONCURRENCY', value: cfg.concurrency },
    { name: 'OCR_MAX_NITS', value: cfg.maxNits },
    { name: 'OCR_INCREMENTAL', value: cfg.incremental },
    { name: 'OCR_LANGUAGE', value: cfg.language },
    {
      name: 'OCR_LLM_TOKEN',
      valueFrom: { secretKeyRef: { name: cfg.llmSecretName, key: cfg.llmSecretKey } },
    },
  ];
  if (cfg.extraBody) env.push({ name: 'OCR_LLM_EXTRA_BODY', value: cfg.extraBody });
  if (cfg.fallbackModel) env.push({ name: 'OCR_LLM_FALLBACK_MODEL', value: cfg.fallbackModel });
  if (cfg.receiverUrl) env.push({ name: 'OCR_RECEIVER_URL', value: cfg.receiverUrl });
  if (provider === 'gitea') {
    env.push({ name: 'GITEA_API_URL', value: cfg.giteaApiUrl });
    if (cfg.giteaWebUrl) env.push({ name: 'GITEA_WEB_URL', value: cfg.giteaWebUrl });
    if (cfg.giteaBotLogin) env.push({ name: 'GITEA_BOT_LOGIN', value: cfg.giteaBotLogin });
  }
  if (process.env.OCR_LLM_TIMEOUT) {
    env.push({ name: 'OCR_LLM_TIMEOUT', value: process.env.OCR_LLM_TIMEOUT });
  }
  if (instruction) env.push({ name: 'OCR_INSTRUCTION', value: instruction });
  if (prBody) env.push({ name: 'OCR_PR_BODY', value: String(prBody).slice(0, 6000) });

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: cfg.namespace,
      labels: {
        'app.kubernetes.io/name': 'ocr-job',
        'ocr/repo': slug(repo),
        'ocr/pr': String(pr),
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      activeDeadlineSeconds: cfg.deadlineSeconds,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'ocr-job' } },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: cfg.jobServiceAccount,
          automountServiceAccountToken: false,
          containers: [{
            name: 'review',
            image: cfg.jobImage,
            imagePullPolicy: 'IfNotPresent',
            env,
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1', memory: '2Gi' },
            },
          }],
        },
      },
    },
  };
}

const k8sCreateJob = async (job, cfg = config()) => {
  const res = await fetch(`${cfg.k8s}/apis/batch/v1/namespaces/${cfg.namespace}/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getSaToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!res.ok) throw new Error(`k8s create job -> ${res.status} ${await res.text()}`);
  return res.json();
};

const metrics = {
  webhooks: new Map(),
  jobsCreated: 0,
  jobErrors: 0,
  ignored: 0,
  reviews: new Map(),
  tokens: new Map(),
  findings: new Map(),
  durationSum: new Map(),
  durationCount: new Map(),
};

export const resetMetrics = () => {
  metrics.webhooks.clear();
  metrics.jobsCreated = 0;
  metrics.jobErrors = 0;
  metrics.ignored = 0;
  metrics.reviews.clear();
  metrics.tokens.clear();
  metrics.findings.clear();
  metrics.durationSum.clear();
  metrics.durationCount.clear();
};

const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

export function renderMetrics() {
  const lines = [];
  lines.push('# HELP ocr_webhooks_total Webhook deliveries by provider, event and action.');
  lines.push('# TYPE ocr_webhooks_total counter');
  for (const [key, value] of metrics.webhooks) {
    const [provider, event, action] = key.split('|');
    lines.push(`ocr_webhooks_total{provider="${provider}",event="${event}",action="${action}"} ${value}`);
  }
  lines.push('# HELP ocr_jobs_created_total Review Jobs created.');
  lines.push('# TYPE ocr_jobs_created_total counter');
  lines.push(`ocr_jobs_created_total ${metrics.jobsCreated}`);
  lines.push('# HELP ocr_jobs_create_errors_total Review Job creation failures.');
  lines.push('# TYPE ocr_jobs_create_errors_total counter');
  lines.push(`ocr_jobs_create_errors_total ${metrics.jobErrors}`);
  lines.push('# HELP ocr_commands_ignored_total Commands ignored (untrusted/non-command).');
  lines.push('# TYPE ocr_commands_ignored_total counter');
  lines.push(`ocr_commands_ignored_total ${metrics.ignored}`);
  lines.push('# HELP ocr_reviews_total Completed reviews by repo and status.');
  lines.push('# TYPE ocr_reviews_total counter');
  for (const [key, value] of metrics.reviews) {
    const [repo, status] = key.split('|');
    lines.push(`ocr_reviews_total{repo="${repo}",status="${status}"} ${value}`);
  }
  lines.push('# HELP ocr_review_tokens_total Tokens consumed by reviews.');
  lines.push('# TYPE ocr_review_tokens_total counter');
  for (const [repo, value] of metrics.tokens) {
    lines.push(`ocr_review_tokens_total{repo="${repo}"} ${value}`);
  }
  lines.push('# HELP ocr_review_findings_total Findings produced by reviews.');
  lines.push('# TYPE ocr_review_findings_total counter');
  for (const [repo, value] of metrics.findings) {
    lines.push(`ocr_review_findings_total{repo="${repo}"} ${value}`);
  }
  lines.push('# HELP ocr_review_duration_seconds Review wall-clock seconds (summary).');
  lines.push('# TYPE ocr_review_duration_seconds summary');
  for (const [repo, count] of metrics.durationCount) {
    lines.push(`ocr_review_duration_seconds_sum{repo="${repo}"} ${metrics.durationSum.get(repo) || 0}`);
    lines.push(`ocr_review_duration_seconds_count{repo="${repo}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

const recordReview = ({ repo, status, tokens, elapsed, findings }) => {
  inc(metrics.reviews, `${repo}|${status || 'unknown'}`);
  if (Number.isFinite(Number(tokens))) inc(metrics.tokens, repo, Number(tokens));
  if (Number.isFinite(Number(findings))) inc(metrics.findings, repo, Number(findings));
  const seconds = Number(elapsed);
  if (Number.isFinite(seconds) && seconds > 0) {
    inc(metrics.durationSum, repo, seconds);
    inc(metrics.durationCount, repo, 1);
  }
};

async function createJob(args) {
  const cfg = config();
  const job = buildJob({ ...args, cfg });
  try {
    await k8sCreateJob(job, cfg);
    metrics.jobsCreated += 1;
    log('created job', job.metadata.name, `${args.repo}#${args.pr}`);
  } catch (err) {
    if (String(err).includes('409') || String(err).includes('AlreadyExists')) {
      log('job already exists', job.metadata.name);
      return;
    }
    metrics.jobErrors += 1;
    throw err;
  }
}

async function handle(provider, event, payload) {
  const cfg = config();
  const repo = payload.repository?.full_name;
  if (!repo) return;
  const isGitea = provider === 'gitea';

  // Gitea delivers push-to-PR as its own `pull_request_sync` event whose action
  // is `synchronized`; GitHub folds it into `pull_request`/`synchronize`.
  const pullEvent = event === 'pull_request' || event === 'pull_request_sync';
  if (pullEvent) {
    const actions = isGitea
      ? ['opened', 'synchronized', 'reopened']
      : ['opened', 'synchronize', 'reopened'];
    if (!actions.includes(payload.action)) return;
    if (payload.pull_request?.draft) return;
    const pr = payload.number ?? payload.pull_request?.number;
    if (!pr) return;
    await createJob({
      provider,
      repo,
      pr,
      base: payload.pull_request?.base?.ref,
      head: payload.pull_request?.head?.sha,
      token: isGitea ? cfg.giteaToken : await installationToken(repo, cfg),
      prBody: payload.pull_request?.body,
    });
    return;
  }

  if (event === 'issue_comment') {
    if (payload.action !== 'created') return;
    const isPr = isGitea
      ? (payload.is_pull === true
        || Boolean(payload.pull_request)
        || Boolean(payload.issue?.pull_request))
      : Boolean(payload.issue?.pull_request);
    if (!isPr) return;
    const login = payload.comment?.user?.login || '';
    if (payload.comment?.user?.type === 'Bot' || /\[bot\]$/i.test(login)) return;
    if (isGitea) {
      if (!(await giteaCanReview(cfg, repo, login))) {
        metrics.ignored += 1;
        log('ignoring command from untrusted gitea user', login);
        return;
      }
    } else if (cfg.allowedAssociations.length > 0
      && !cfg.allowedAssociations.includes(payload.comment?.author_association || '')) {
      metrics.ignored += 1;
      log('ignoring command from untrusted association', payload.comment?.author_association);
      return;
    }
    const parsed = parseCommand(payload.comment?.body, cfg.commands);
    if (!parsed) return;
    const number = payload.issue?.number ?? payload.pull_request?.number;
    if (!number) return;
    const token = isGitea ? cfg.giteaToken : await installationToken(repo, cfg);
    const pr = await providerFetch(cfg, provider, token, `/repos/${repo}/pulls/${number}`);
    await createJob({
      provider,
      repo,
      pr: number,
      base: pr.base.ref,
      head: pr.head.sha,
      token,
      manual: true,
      instruction: parsed.instruction || undefined,
      prBody: pr.body,
    });
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderMetrics());
      return;
    }
    if (req.method === 'POST' && req.url === '/report') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          recordReview(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(204);
          res.end();
        } catch (err) {
          log('bad report', String(err));
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const cfg = config();
      // Gitea always sets X-Gitea-Event (plus the GitHub-compatible headers), so
      // its presence is the discriminator.
      const giteaEvent = req.headers['x-gitea-event'];
      const provider = giteaEvent ? 'gitea' : 'github';
      if (!cfg.providers.includes(provider)) {
        res.writeHead(404);
        res.end('provider disabled');
        return;
      }
      const secret = provider === 'gitea' ? cfg.giteaWebhookSecret : cfg.webhookSecret;
      const githubSignature = req.headers['x-hub-signature-256'];
      const giteaSignature = req.headers['x-gitea-signature'];
      const valid = provider === 'gitea'
        ? (verifySignature(secret, body, githubSignature)
          || verifyGiteaSignature(secret, body, giteaSignature))
        : verifySignature(secret, body, githubSignature);
      if (!valid) {
        res.writeHead(401);
        res.end('bad signature');
        return;
      }
      res.writeHead(202);
      res.end('accepted');

      try {
        const event = String(giteaEvent || req.headers['x-github-event'] || 'unknown');
        const payload = JSON.parse(body.toString('utf8'));
        inc(metrics.webhooks, `${provider}|${event}|${payload.action || '-'}`);
        handle(provider, event, payload).catch((err) => log('handler error', String(err)));
      } catch (err) {
        log('bad payload', String(err));
      }
    });
  });
}

export function main() {
  const cfg = config();
  const required = {
    OCR_JOB_IMAGE: cfg.jobImage,
    OCR_LLM_URL: cfg.llmUrl,
    OCR_LLM_MODEL: cfg.llmModel,
  };
  if (cfg.providers.includes('github')) {
    required.GITHUB_APP_ID = cfg.appId;
    required.GITHUB_WEBHOOK_SECRET = cfg.webhookSecret;
  }
  if (cfg.providers.includes('gitea')) {
    required.GITEA_API_URL = cfg.giteaApiUrl;
    required.GITEA_TOKEN = cfg.giteaToken;
    required.GITEA_WEBHOOK_SECRET = cfg.giteaWebhookSecret;
  }
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      console.error(`fatal: missing ${key}`);
      process.exit(1);
    }
  }
  const port = Number(process.env.PORT || 8080);
  createServer().listen(port, () => log(`listening on :${port}`));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
