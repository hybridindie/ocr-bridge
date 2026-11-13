// Post an OpenCodeReview JSON result back to a GitHub or Gitea pull request.
//
// Policy parity with PR-Agent:
//  - severity prefixes (Important / Nit), Important first, max N nits inline;
//  - one finding per root cause (path + category + snippet);
//  - generated/lockfile/vendor paths dropped;
//  - incremental inline dedupe against existing bot review comments;
//  - sticky summary comment (updated in place) + failed/deferred findings.
//
// Node stdlib only. GIT_PROVIDER selects GitHub (default) or Gitea; the inline
// comment shape differs (`line`/`side` vs `new_position`).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_API = 'https://api.github.com';
export const MARKER = '<!-- ocr-summary -->';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const DEFAULT_SKIP = [
  String.raw`(^|/)(node_modules|vendor|dist|build|out|target|\.venv|venv|__pycache__)/`,
  String.raw`(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock|Gemfile\.lock)$`,
  String.raw`\.(min\.js|min\.css|map|pb\.go|generated\.(go|ts|js))$`,
  String.raw`(^|/)\.?generated/`,
];

export const severityRank = (severity) =>
  SEVERITY_RANK[String(severity || '').toLowerCase()] ?? 0;

export const severityPrefix = (severity) => {
  const rank = severityRank(severity);
  if (rank >= 3) return 'Important — ';
  if (rank >= 1) return 'Nit — ';
  return '';
};

export const shouldSkipPath = (path, patterns = DEFAULT_SKIP) =>
  patterns.some((pattern) => new RegExp(pattern).test(String(path)));

const findingKey = (finding) =>
  `${finding.path}|${finding.category || ''}|${String(
    finding.existing_code || finding.content || '',
  ).trim().slice(0, 120)}`;

export const dedupeFindings = (findings) => {
  const seen = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const previous = seen.get(key);
    if (!previous || severityRank(finding.severity) > severityRank(previous.severity)) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
};

export const normalizeFindings = (findings, { maxNits = 3, skipPatterns = DEFAULT_SKIP } = {}) => {
  const relevant = findings.filter(
    (finding) => finding && finding.path && !shouldSkipPath(finding.path, skipPatterns),
  );
  const unique = dedupeFindings(relevant).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const important = unique.filter((finding) => severityRank(finding.severity) >= 3);
  const nits = unique.filter((finding) => severityRank(finding.severity) < 3);
  return {
    inline: [...important, ...nits.slice(0, maxNits)],
    deferred: nits.slice(maxNits),
  };
};

export const commentBody = (finding) => {
  const text = `${severityPrefix(finding.severity)}${String(
    finding.content || finding.message || '',
  ).trim()}`;
  const suggestion = finding.suggestion_code
    ? `\n\n\`\`\`suggestion\n${finding.suggestion_code}\n\`\`\``
    : '';
  return text + suggestion;
};

export const toInlineComments = (findings, { provider = 'github' } = {}) => {
  const comments = [];
  for (const finding of findings) {
    if (!finding.path) continue;
    const end = Number(finding.end_line ?? finding.start_line);
    const start = Number(finding.start_line ?? finding.end_line);
    if (!Number.isFinite(end) || end <= 0) continue;
    const body = commentBody(finding);
    if (!body) continue;
    // GitHub anchors on the new-file line with a side; Gitea takes a single
    // new-file position (no multi-line ranges).
    const comment = provider === 'gitea'
      ? { path: finding.path, new_position: end, body }
      : { path: finding.path, line: end, side: 'RIGHT', body };
    if (provider !== 'gitea' && Number.isFinite(start) && start > 0 && start < end) {
      comment.start_line = start;
      comment.start_side = 'RIGHT';
    }
    comments.push(comment);
  }
  return comments;
};

export const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const interval = (comment) => {
  const start = Number(comment.start_line ?? comment.line);
  const end = Number(comment.line ?? comment.start_line);
  return [Math.min(start, end), Math.max(start, end)];
};

export const overlaps = (a, b) => {
  if (a.path !== b.path) return false;
  const [as, ae] = interval(a);
  const [bs, be] = interval(b);
  if (!Number.isFinite(as) || !Number.isFinite(bs) || as <= 0 || bs <= 0) return false;
  return as <= be && bs <= ae;
};

export const filterIncremental = (comments, existing) =>
  comments.filter((comment) => !existing.some((previous) => overlaps(comment, previous)));

export const buildSummary = ({ data, posted, total, failed, deferred }) => {
  const summary = data.summary || {};
  const model = data.llm?.model || '';
  const lines = [
    MARKER,
    '### 🤖 OpenCodeReview',
    '',
    data.message
      ? String(data.message)
      : `Reviewed ${summary.files_reviewed ?? '?'} file(s): **${total}** finding(s)` +
        ` (${posted} inline${failed.length ? `, ${failed.length} in this summary` : ''}` +
        `${deferred.length ? `, ${deferred.length} lower-severity not shown` : ''}).`,
  ];
  if (model) {
    lines.push(
      '',
      `<sub>model \`${model}\` · ${summary.total_tokens ?? '?'} tokens · ${summary.elapsed ?? '?'}</sub>`,
    );
  }
  if (failed.length > 0) {
    lines.push('', '<details><summary>Findings the reviewer could not place inline</summary>', '');
    for (const item of failed) {
      lines.push(`- \`${item.path}:${item.line}\` — ${item.body.split('\n')[0]}`);
    }
    lines.push('', '</details>');
  }
  if (deferred.length > 0) {
    lines.push('', '<details><summary>Additional lower-severity findings</summary>', '');
    for (const finding of deferred) {
      lines.push(
        `- \`${finding.path}\` — ${String(finding.content || finding.message || '').trim()}`,
      );
    }
    lines.push('', '</details>');
  }
  return lines.join('\n');
};

const apiRequest = async (api, provider, token, path, opts = {}) => {
  const auth = provider === 'gitea'
    ? { Authorization: `token ${token}`, Accept: 'application/json' }
    : {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  const res = await fetch(`${api}${path}`, {
    ...opts,
    headers: { ...auth, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
};

// Gitea has no `/pulls/{n}/comments` collection: review comments hang off each
// review. Walk the reviews (optionally only the bot's) to collect them.
const giteaReviewComments = async (api, token, repo, pr, botLogin) => {
  const reviews = await apiRequest(api, 'gitea', token, `/repos/${repo}/pulls/${pr}/reviews`);
  const comments = [];
  for (const review of reviews || []) {
    if (botLogin && review.user?.login && review.user.login !== botLogin) continue;
    try {
      const list = await apiRequest(
        api,
        'gitea',
        token,
        `/repos/${repo}/pulls/${pr}/reviews/${review.id}/comments`,
      );
      comments.push(...(list || []));
    } catch (err) {
      console.error(`gitea review ${review.id} comments failed (${err.message})`);
    }
  }
  return comments;
};

const existingComments = async (api, provider, token, repo, pr) => {
  if (provider !== 'gitea') {
    const list = await apiRequest(api, provider, token, `/repos/${repo}/pulls/${pr}/comments?per_page=100`);
    return (list || []).filter((comment) => comment.user?.type === 'Bot');
  }
  const list = await giteaReviewComments(api, token, repo, pr, process.env.GITEA_BOT_LOGIN || '');
  return (list || []).map((comment) => ({
    path: comment.path,
    line: comment.position ?? comment.original_position,
    start_line: comment.start_position ?? comment.original_start_position,
    body: comment.body,
  }));
};

// Gitea's positions are diff offsets, not file lines, so compare the rendered
// body per path instead of an interval.
export const filterIncrementalByBody = (comments, existing) =>
  comments.filter((comment) => !existing.some(
    (previous) => previous.path === comment.path
      && String(previous.body || '').trim() === String(comment.body || '').trim(),
  ));

export async function main() {
  const provider = process.env.GIT_PROVIDER || 'github';
  const api = provider === 'gitea'
    ? (process.env.GITEA_API_URL || '').replace(/\/$/, '')
    : (process.env.GITHUB_API_URL || DEFAULT_API);
  const token = process.env.GIT_TOKEN;
  const repo = process.env.REPO;
  const pr = process.env.PR_NUMBER;
  const sha = process.env.HEAD_SHA;

  if (!token || !repo || !pr || !sha || !api) {
    console.error(`post-review: missing token/REPO/PR_NUMBER/HEAD_SHA/api (provider=${provider})`);
    process.exit(1);
  }

  const resultPath = process.argv[2] || '/tmp/result.json';
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const findings = Array.isArray(data.comments) ? data.comments : [];

  const { inline: selected, deferred } = normalizeFindings(findings, {
    maxNits: Number(process.env.OCR_MAX_NITS || 3),
  });
  let inline = toInlineComments(selected, { provider });

  if (String(process.env.OCR_INCREMENTAL || 'true') !== 'false') {
    try {
      const botComments = await existingComments(api, provider, token, repo, pr);
      const before = inline.length;
      inline = provider === 'gitea'
        ? filterIncrementalByBody(inline, botComments)
        : filterIncremental(inline, botComments);
      if (inline.length !== before) {
        console.error(`incremental: skipped ${before - inline.length} already-posted finding(s)`);
      }
    } catch (err) {
      console.error(`incremental lookup failed (${err.message}); posting all`);
    }
  }

  const postReview = (comments) => apiRequest(api, provider, token, `/repos/${repo}/pulls/${pr}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit_id: sha, event: 'COMMENT', body: '', comments }),
  });

  const failed = [];
  let posted = 0;
  for (const batch of chunk(inline, 50)) {
    try {
      await postReview(batch);
      posted += batch.length;
    } catch (err) {
      console.error(`batch of ${batch.length} failed (${err.message}); retrying one by one`);
      for (const item of batch) {
        try {
          await postReview([item]);
          posted += 1;
        } catch (singleErr) {
          console.error(`inline failed for ${item.path}:${item.line}: ${singleErr.message}`);
          failed.push(item);
        }
      }
    }
  }

  const summaryBody = buildSummary({ data, posted, total: findings.length, failed, deferred });
  const issueComments = await apiRequest(api, provider, token, `/repos/${repo}/issues/${pr}/comments?per_page=100`);
  const sticky = (issueComments || []).find((comment) => String(comment.body || '').includes(MARKER));
  if (sticky) {
    await apiRequest(api, provider, token, `/repos/${repo}/issues/comments/${sticky.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: summaryBody }),
    });
  } else {
    await apiRequest(api, provider, token, `/repos/${repo}/issues/${pr}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: summaryBody }),
    });
  }

  const receiver = process.env.OCR_RECEIVER_URL;
  if (receiver) {
    try {
      await fetch(`${receiver.replace(/\/$/, '')}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo,
          pr: Number(pr),
          status: data.status || 'success',
          tokens: data.summary?.total_tokens,
          elapsed: data.summary?.elapsed,
          findings: findings.length,
          posted,
        }),
      });
    } catch (err) {
      console.error(`report failed: ${err.message}`);
    }
  }

  console.error(
    `posted ${posted}/${inline.length} inline comments; summary ${sticky ? 'updated' : 'created'}`,
  );
  if (inline.length > 0 && posted === 0) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
