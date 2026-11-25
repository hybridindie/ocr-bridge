// Post an OpenCodeReview JSON result back to a GitHub or Gitea pull request.
//
// Policy parity with PR-Agent:
//  - severity prefixes (Important / Nit), Important first, max N nits inline
//    on the first review and none on later ones (OCR_NITS_FIRST_ROUND_ONLY);
//  - optionally, an Important finding that quotes no code is demoted to a nit
//    (OCR_DEMOTE_UNQUOTED_IMPORTANT, off by default);
//  - `--carry-forward` moves the checkpoint to a rebased, patch-identical head
//    without a review (run-review.sh decides; OCR_SKIP_UNCHANGED_REBASE);
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
// Machine-readable cross-push checkpoint embedded in the sticky summary.
export const CHECKPOINT_PREFIX = '<!-- ocr-checkpoint:';
const CHECKPOINT_LINE_RE = /^<!--\s*ocr-checkpoint:[^>]*-->\s*$/gm;
// How many reviews of this PR actually ran the model. Round 1 may post nits
// inline; later rounds keep them in the summary (OCR_NITS_FIRST_ROUND_ONLY).
export const ROUND_RE = /<!--\s*ocr-round:\s*(\d+)\s*-->/;
// A rebase that left the patch unchanged carries the previous review forward
// instead of re-running the model; this line says so in the summary.
const CARRIED_MARKER = '<!-- ocr-carried -->';
const CARRIED_LINE_RE = /^<!-- ocr-carried -->.*$\n?/gm;
const SKIP_TEXT = 'No reviewable code changes';

// Cap every "details" list in the sticky summary so one pathological run cannot
// turn the comment into hundreds of lines.
const MAX_DETAILS = 10;

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

// An Important finding must quote the code path it is about (the severity
// rubric in run-review.sh asks for that). One whose text carries no inline code
// span is demoted to a nit (`medium`), so speculative "could be" findings stop
// opening must-answer threads. Opt-in (OCR_DEMOTE_UNQUOTED_IMPORTANT).
export const quotesCode = (finding) =>
  /`[^`\n]+`/.test(String(finding?.content || finding?.message || ''));

export const demoteUnquoted = (findings) => findings.map((finding) => (
  finding && severityRank(finding.severity) >= 3 && !quotesCode(finding)
    ? { ...finding, severity: 'medium', demoted_from: finding.severity }
    : finding
));

export const normalizeFindings = (
  findings,
  {
    maxNits = 3,
    skipPatterns = DEFAULT_SKIP,
    routeSeverityBelow = '',
    routeCategories = [],
    demote = false,
  } = {},
) => {
  const relevant = (demote ? demoteUnquoted(findings) : findings).filter(
    (finding) => finding && finding.path && !shouldSkipPath(finding.path, skipPatterns),
  );
  const unique = dedupeFindings(relevant).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  // Routing mirrors the Action's route_severity_below/route_categories: the
  // findings move to the summary instead of being dropped, and findings with an
  // empty/unknown severity or category are never routed.
  const threshold = severityRank(routeSeverityBelow);
  const categories = new Set(
    (routeCategories || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean),
  );
  const routed = (finding) => {
    const rank = severityRank(finding.severity);
    if (threshold > 0 && rank > 0 && rank <= threshold) return true;
    return categories.has(String(finding.category || '').trim().toLowerCase());
  };
  const keepInline = unique.filter((finding) => !routed(finding));
  const important = keepInline.filter((finding) => severityRank(finding.severity) >= 3);
  const nits = keepInline.filter((finding) => severityRank(finding.severity) < 3);
  return {
    inline: [...important, ...nits.slice(0, maxNits)],
    deferred: [...nits.slice(maxNits), ...unique.filter(routed)],
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

// Reviews of this PR that ran before, read from the sticky summary. A sticky
// written before the round marker existed counts as one review unless it was
// the "nothing reviewable" summary.
export const previousRound = (body) => {
  const text = String(body || '');
  if (!text.includes(MARKER)) return 0;
  const match = ROUND_RE.exec(text);
  if (match) return Number(match[1]);
  return text.includes(SKIP_TEXT) ? 0 : 1;
};

export const buildSummary = ({
  data, posted, total, failed, deferred, checkpoint, round = 0, nitsSummaryOnly = false,
}) => {
  const summary = data.summary || {};
  const model = data.llm?.model || '';
  const skipped = /no items were selected/i.test(String(data.message || ''));
  const lines = [
    MARKER,
    '### 🤖 OpenCodeReview',
    '',
  ];
  if (skipped) {
    lines.push(
      `${SKIP_TEXT} — this PR only touches docs, generated files, `
      + 'or file types OCR does not review.',
    );
  } else if (data.message) {
    lines.push(String(data.message));
  } else {
    lines.push(
      `Reviewed ${summary.files_reviewed ?? '?'} file(s): **${total}** finding(s)` +
      ` (${posted} inline${failed.length ? `, ${failed.length} in this summary` : ''}` +
      `${deferred.length ? `, ${deferred.length} additional in this summary` : ''}).`,
    );
  }
  if (model && !skipped) {
    const cached = Number(summary.cache_read_tokens || 0);
    lines.push(
      '',
      `<sub>model \`${model}\` · ${summary.total_tokens ?? '?'} tokens`
      + `${cached ? ` (${cached} cached)` : ''} · ${summary.elapsed ?? '?'}</sub>`,
    );
  }
  // OCR only exits non-zero for operational failures; a partial run still
  // exits 0 and reports the affected files under manifest.coverage.failed.
  // Surface them so "partially complete" is actionable instead of a mystery.
  const incomplete = Array.isArray(data.manifest?.coverage?.failed)
    ? data.manifest.coverage.failed
    : [];
  if (incomplete.length > 0) {
    lines.push('', '<details><summary>Not reviewed</summary>', '');
    for (const item of incomplete.slice(0, MAX_DETAILS)) {
      const why = [item.classification, item.reason].filter(Boolean).join(': ');
      lines.push(`- \`${item.path}\`${why ? ` — ${why}` : ''}`);
    }
    if (incomplete.length > MAX_DETAILS) {
      lines.push(`- …and ${incomplete.length - MAX_DETAILS} more`);
    }
    lines.push('', '</details>');
  }
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.length > 0) {
    lines.push('', '<details><summary>Reviewer warnings</summary>', '');
    for (const warning of warnings.slice(0, MAX_DETAILS)) {
      const where = warning.file ? `\`${warning.file}\` — ` : '';
      lines.push(`- ${where}${warning.message || 'unknown warning'}`);
    }
    if (warnings.length > MAX_DETAILS) {
      lines.push(`- …and ${warnings.length - MAX_DETAILS} more`);
    }
    lines.push('', '</details>');
  }
  if (failed.length > 0) {
    lines.push('', '<details><summary>Findings the reviewer could not place inline</summary>', '');
    for (const item of failed) {
      lines.push(`- \`${item.path}:${item.line}\` — ${item.body.split('\n')[0]}`);
    }
    lines.push('', '</details>');
  }
  if (deferred.length > 0) {
    const title = nitsSummaryOnly
      ? 'Nits (listed here only: inline threads are opened for nits on the first review)'
      : 'Additional findings';
    lines.push('', `<details><summary>${title}</summary>`, '');
    for (const finding of deferred) {
      lines.push(
        `- \`${finding.path}\` — ${String(finding.content || finding.message || '').trim()}`,
      );
    }
    lines.push('', '</details>');
  }
  // Cross-push checkpoint. Written only when the run reviewed everything it
  // selected, so the next push can review <checkpoint>..<head> instead of the
  // whole merge-base range. Absent => next run falls back to the full range.
  if (round > 0) lines.push('', `<!-- ocr-round: ${round} -->`);
  if (checkpoint?.head && checkpoint?.base) {
    lines.push('', `${CHECKPOINT_PREFIX} ${checkpoint.head} base=${checkpoint.base} -->`);
  }
  return lines.join('\n');
};

// Carry a previous review forward to a rebased head whose patch is unchanged
// (run-review.sh compared `git patch-id --stable` of base...head): move the
// checkpoint to the new head/base and say why no review ran. Everything else in
// the summary, including the round marker, is kept.
export const carryForwardSummary = (body, { head, base, previousHead }) => {
  const short = (sha) => String(sha || '').slice(0, 7);
  const note = `${CARRIED_MARKER} _Rebased, patch unchanged; previous review carried forward_`
    + ` (\`${short(previousHead)}\` → \`${short(head)}\`, base \`${short(base)}\`).`;
  const lines = String(body || '')
    .replace(CHECKPOINT_LINE_RE, '')
    .replace(CARRIED_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .split('\n');
  const header = lines.findIndex((line) => line.startsWith('### '));
  lines.splice(header >= 0 ? header + 1 : lines.length, 0, '', note);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n\n${CHECKPOINT_PREFIX} ${head} base=${base} -->`;
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

// Resolve this reviewer's own outdated inline threads (GitHub only). A thread
// is eligible when it is unresolved, marked outdated by GitHub (its lines no
// longer exist), authored entirely by the bot (any human reply opts it out), and
// not covered by a finding from the current run. mode: false | report | true.
// REST names an App's comments `<slug>[bot]`; GraphQL's Bot.login omits the
// suffix. Compare without it so the sticky's author matches thread authors.
const sameLogin = (a, b) => {
  const bare = (login) => String(login || '').replace(/\[bot\]$/, '');
  return Boolean(a) && bare(a) === bare(b);
};

export async function resolveOutdated({ provider, token, repo, pr, findings, botLogin, mode }) {
  const result = { resolved: 0, wouldResolve: 0, skipped: 0 };
  if (provider !== 'github' || !botLogin || !mode || mode === 'false') return result;

  const gql = async (query, variables) => {
    const res = await fetch(process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) {
      throw new Error(`${res.status} ${JSON.stringify(json.errors || json)}`);
    }
    return json.data;
  };

  const [owner, name] = String(repo).split('/');
  const data = await gql(
    `query($owner: String!, $name: String!, $num: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $num) {
           reviewThreads(first: 100) {
             nodes {
               id isResolved isOutdated
               comments(first: 20) {
                 nodes { author { login } path line originalLine startLine originalStartLine }
               }
             }
           }
         }
       }
     }`,
    { owner, name, num: Number(pr) },
  );

  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const covered = (thread) => (thread.comments?.nodes || []).some((comment) => {
    const path = comment.path;
    const a = Number(comment.startLine ?? comment.line ?? comment.originalStartLine ?? comment.originalLine);
    const b = Number(comment.line ?? comment.originalLine ?? comment.startLine ?? comment.originalStartLine);
    if (!path || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    const probe = { path, line: Math.max(a, b), start_line: Math.min(a, b) };
    return findings.some((finding) => overlaps(probe, finding));
  });

  for (const thread of threads) {
    if (thread.isResolved || !thread.isOutdated) continue;
    const authors = (thread.comments?.nodes || []).map((comment) => comment.author?.login);
    const ours = authors.length > 0 && authors.every((login) => sameLogin(login, botLogin));
    if (!ours || covered(thread)) {
      result.skipped += 1;
      continue;
    }
    if (mode === 'report') {
      result.wouldResolve += 1;
      console.error(`resolve_outdated: would resolve thread ${thread.id}`);
      continue;
    }
    try {
      await gql(
        'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }',
        { id: thread.id },
      );
      result.resolved += 1;
    } catch (err) {
      console.error(`resolve_outdated: failed for ${thread.id}: ${err.message}`);
    }
  }
  if (result.resolved || result.wouldResolve) {
    console.error(
      `resolve_outdated: resolved ${result.resolved}, would resolve ${result.wouldResolve}, `
      + `skipped ${result.skipped}`,
    );
  }
  return result;
}

// Decide whether this run may advance the cross-push checkpoint. Only a run
// that reviewed everything it selected may: any failed item or a partial status
// means the next push must re-review the full range.
export const checkpointFrom = (data, env = process.env) => {
  const coverage = data?.manifest?.coverage;
  const failed = Array.isArray(coverage?.failed) ? coverage.failed : [];
  const status = String(data?.status || '');
  const complete = Boolean(coverage) && failed.length === 0 && status !== 'partial' && status !== 'failed';
  if (!complete || String(env.OCR_CHECKPOINT || 'true') === 'false') return null;
  if (!env.OCR_REVIEWED_HEAD || !env.OCR_BASE_SHA) return null;
  return { head: env.OCR_REVIEWED_HEAD, base: env.OCR_BASE_SHA };
};

const flag = (env, name, fallback = true) => {
  const value = String(env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return value !== 'false' && value !== '0' && value !== 'no';
};

const findSticky = async (api, provider, token, repo, pr) => {
  const issueComments = await apiRequest(api, provider, token, `/repos/${repo}/issues/${pr}/comments?per_page=100`);
  return (issueComments || []).find((comment) => String(comment.body || '').includes(MARKER));
};

const writeSticky = async (api, provider, token, repo, pr, sticky, body) => {
  if (sticky) {
    await apiRequest(api, provider, token, `/repos/${repo}/issues/comments/${sticky.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await apiRequest(api, provider, token, `/repos/${repo}/issues/${pr}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
};

const sendReport = async (payload) => {
  const receiver = process.env.OCR_RECEIVER_URL;
  if (!receiver) return;
  try {
    await fetch(`${receiver.replace(/\/$/, '')}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`report failed: ${err.message}`);
  }
};

// `post-review.mjs --carry-forward`: the head was rebased without changing its
// patch. Update the existing sticky summary instead of posting a review; exit
// non-zero when there is no summary to carry, so run-review.sh reviews instead.
async function carryForward({ api, provider, token, repo, pr }) {
  const head = process.env.OCR_REVIEWED_HEAD;
  const base = process.env.OCR_BASE_SHA;
  const previousHead = process.env.CHECKPOINT_SHA;
  if (!head || !base) {
    console.error('carry-forward: missing OCR_REVIEWED_HEAD/OCR_BASE_SHA');
    process.exit(1);
  }
  const sticky = await findSticky(api, provider, token, repo, pr);
  if (!sticky) {
    console.error('carry-forward: no sticky summary to carry forward');
    process.exit(1);
  }
  const body = carryForwardSummary(sticky.body, { head, base, previousHead });
  await writeSticky(api, provider, token, repo, pr, sticky, body);
  await sendReport({ repo, pr: Number(pr), status: 'carried', tokens: 0, findings: 0, posted: 0 });
  console.error(`carry-forward: summary checkpoint moved ${String(previousHead).slice(0, 7)} -> ${head.slice(0, 7)}`);
}

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

  if (process.argv[2] === '--carry-forward') {
    await carryForward({ api, provider, token, repo, pr });
    return;
  }

  const resultPath = process.argv[2] || '/tmp/result.json';
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const findings = Array.isArray(data.comments) ? data.comments : [];

  // Nits once: the first review of a PR may open nit threads; every later one
  // (any push after a summary exists) opens threads only for Important findings
  // and lists its nits in the summary. Otherwise each fix commit draws a fresh
  // round of up to OCR_MAX_NITS threads and the review never converges.
  let sticky = null;
  try {
    sticky = await findSticky(api, provider, token, repo, pr);
  } catch (err) {
    console.error(`sticky lookup failed (${err.message}); treating as the first review`);
  }
  const prior = previousRound(sticky?.body);
  const ranModel = !/no items were selected/i.test(String(data.message || ''));
  const round = ranModel ? prior + 1 : prior;
  const nitsSummaryOnly = prior >= 1 && flag(process.env, 'OCR_NITS_FIRST_ROUND_ONLY');
  if (nitsSummaryOnly) console.error(`round ${round}: nits go to the summary only`);

  const { inline: selected, deferred } = normalizeFindings(findings, {
    maxNits: nitsSummaryOnly ? 0 : Number(process.env.OCR_MAX_NITS || 3),
    // Off by default: on prose-heavy repos and doc reviews a correct Important
    // finding often quotes no code, so the heuristic would demote it.
    demote: flag(process.env, 'OCR_DEMOTE_UNQUOTED_IMPORTANT', false),
    routeSeverityBelow: process.env.OCR_ROUTE_SEVERITY_BELOW || '',
    routeCategories: (process.env.OCR_ROUTE_CATEGORIES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
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

  const checkpoint = checkpointFrom(data);

  const summaryBody = buildSummary({
    data, posted, total: findings.length, failed, deferred, checkpoint, round, nitsSummaryOnly,
  });
  // Re-read: the sticky may have been created since the lookup above (two jobs
  // for one PR), and a failed lookup must not create a second summary.
  const current = await findSticky(api, provider, token, repo, pr);
  await writeSticky(api, provider, token, repo, pr, current, summaryBody);
  sticky = current;

  try {
    let botLogin = sticky?.user?.login;
    if (!botLogin) {
      const after = await apiRequest(api, provider, token, `/repos/${repo}/issues/${pr}/comments?per_page=100`);
      botLogin = (after || []).find((comment) => String(comment.body || '').includes(MARKER))
        ?.user?.login;
    }
    await resolveOutdated({
      provider,
      token,
      repo,
      pr,
      findings: toInlineComments([...selected, ...deferred], { provider }),
      botLogin,
      mode: process.env.OCR_RESOLVE_OUTDATED || 'false',
    });
  } catch (err) {
    console.error(`resolve_outdated skipped: ${err.message}`);
  }

  await sendReport({
    repo,
    pr: Number(pr),
    status: data.status || 'success',
    tokens: data.summary?.total_tokens,
    elapsed: data.summary?.elapsed,
    findings: findings.length,
    posted,
  });

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
