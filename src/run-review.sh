#!/usr/bin/env bash
# OpenCodeReview review job entrypoint.
#
# Expects: GIT_TOKEN, REPO, PR_NUMBER, BASE_REF, HEAD_SHA,
#          OCR_LLM_URL, OCR_LLM_MODEL, OCR_LLM_TOKEN.
# Optional: OCR_USE_ANTHROPIC, OCR_LLM_PROTOCOL, OCR_LLM_EXTRA_BODY,
#           OCR_LLM_TIMEOUT, OCR_CONCURRENCY, OCR_LANGUAGE, OCR_BACKGROUND,
#           OCR_EFFORT, OCR_TASK_TIMEOUT, OCR_MAX_TOKENS_BUDGET, OCR_MAX_TOKENS,
#           OCR_MAX_TOOLS, OCR_EXCLUDE, OCR_ROUTE_SEVERITY_BELOW, OCR_ROUTE_CATEGORIES,
#           OCR_RESOLVE_OUTDATED, OCR_CHECKPOINT, CHECKPOINT_SHA, CHECKPOINT_BASE_SHA.
set -uo pipefail

log() { printf '[ocr-job] %s\n' "$*" >&2; }

: "${GIT_TOKEN:?}" "${REPO:?}" "${PR_NUMBER:?}" "${BASE_REF:?}" "${HEAD_SHA:?}"
: "${OCR_LLM_URL:?}" "${OCR_LLM_MODEL:?}" "${OCR_LLM_TOKEN:?}"

# ocr config set writes under $HOME; keep it writable and ephemeral.
export HOME=/tmp/ocr-home
mkdir -p "$HOME/.opencodereview"

ocr config set llm.url "$OCR_LLM_URL"
ocr config set llm.model "$OCR_LLM_MODEL"
ocr config set llm.use_anthropic "${OCR_USE_ANTHROPIC:-false}"
ocr config set llm.protocol "${OCR_LLM_PROTOCOL:-openai}"
ocr config set llm.auth_header "${OCR_LLM_AUTH_HEADER:-Authorization}"
ocr config set llm.auth_token_cmd 'printf "%s" "$OCR_LLM_TOKEN"'
ocr config set language "${OCR_LANGUAGE:-English}"
if [ -n "${OCR_LLM_EXTRA_BODY:-}" ]; then
  ocr config set llm.extra_body "$OCR_LLM_EXTRA_BODY"
fi
if [ -n "${OCR_LLM_TIMEOUT:-}" ]; then
  ocr config set llm.timeout_sec "$OCR_LLM_TIMEOUT"
fi

WORK=/workspace
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

# GitHub authenticates git with a token as the password (`x-access-token`);
# Gitea accepts its access token the same way under the `oauth2` user.
PROVIDER="${GIT_PROVIDER:-github}"
case "$PROVIDER" in
  gitea)
    GIT_SCHEME="${GIT_SCHEME:-http}"
    GIT_HOST="${GIT_HOST:?GIT_HOST is required for gitea}"
    GIT_AUTH_USER="${GIT_AUTH_USER:-oauth2}"
    ;;
  *)
    PROVIDER=github
    GIT_SCHEME="${GIT_SCHEME:-https}"
    GIT_HOST="${GIT_HOST:-github.com}"
    GIT_AUTH_USER="${GIT_AUTH_USER:-x-access-token}"
    ;;
esac

git config --global safe.directory '*'
git init -q
git remote add origin "${GIT_SCHEME}://${GIT_AUTH_USER}:${GIT_TOKEN}@${GIT_HOST}/${REPO}.git"

log "provider ${PROVIDER} (${GIT_SCHEME}://${GIT_HOST})"
log "fetching ${REPO} ${BASE_REF} and PR #${PR_NUMBER}"
if ! git fetch -q --no-tags origin "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"; then
  log "failed to fetch base ref ${BASE_REF}"
  exit 1
fi
if ! git fetch -q --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr-${PR_NUMBER}"; then
  log "failed to fetch refs/pull/${PR_NUMBER}/head"
  exit 1
fi
git checkout -q "refs/remotes/origin/pr-${PR_NUMBER}"

BASE_SHA="$(git rev-parse "origin/${BASE_REF}")"
REVIEWED_HEAD="$(git rev-parse "refs/remotes/origin/pr-${PR_NUMBER}")"
export OCR_BASE_SHA="$BASE_SHA"
export OCR_REVIEWED_HEAD="$REVIEWED_HEAD"

# Cross-push checkpoint: the previous run left the head it fully covered in the
# sticky summary. Review only checkpoint..head when the repo state still proves
# that range is complete: the base has not moved, the webhook head is what we
# fetched, and the checkpoint is an ancestor. Anything else falls back to the
# full merge-base range (fail-closed).
FROM_REF="origin/${BASE_REF}"
if [ -n "${CHECKPOINT_SHA:-}" ] && [ -n "${CHECKPOINT_BASE_SHA:-}" ] \
  && [ "$BASE_SHA" = "${CHECKPOINT_BASE_SHA}" ] && [ "$REVIEWED_HEAD" = "$HEAD_SHA" ]; then
  if ! git cat-file -e "${CHECKPOINT_SHA}^{commit}" 2>/dev/null; then
    git fetch -q --no-tags origin "${CHECKPOINT_SHA}" >/dev/null 2>&1 || true
  fi
  if git cat-file -e "${CHECKPOINT_SHA}^{commit}" 2>/dev/null \
    && git merge-base --is-ancestor "${CHECKPOINT_SHA}" "$REVIEWED_HEAD" 2>/dev/null; then
    FROM_REF="${CHECKPOINT_SHA}"
    log "incremental review from checkpoint ${CHECKPOINT_SHA}"
  else
    log "checkpoint ${CHECKPOINT_SHA} unusable; reviewing the full range"
  fi
fi

log "reviewing ${REPO}#${PR_NUMBER} (${FROM_REF}...${HEAD_SHA})"

# Rule policy:
#  - use the *base* ref's .opencodereview/rule.json, never the PR head, so a PR
#    cannot weaken the rules (PR-Agent reads .pr_agent.toml from the base too);
#  - append one broad rule for a manual `/review <instruction>` command, keeping
#    the built-in system rules. The PR title/description is *not* a rule: it goes
#    through `--background` (OCR's documented channel for requirement context).
if git cat-file -e "origin/${BASE_REF}:.opencodereview/rule.json" 2>/dev/null; then
  git show "origin/${BASE_REF}:.opencodereview/rule.json" > /tmp/base-rule.json
else
  printf '{"rules":[]}' > /tmp/base-rule.json
fi
OCR_INSTRUCTION="${OCR_INSTRUCTION:-}" node -e '
const fs = require("fs");
let base = { rules: [] };
try {
  base = JSON.parse(fs.readFileSync("/tmp/base-rule.json", "utf8"));
} catch (err) {
  console.error("ignoring invalid base rule.json: " + err.message);
}
const rules = Array.isArray(base.rules) ? base.rules : [];
const extra = (process.env.OCR_INSTRUCTION || "").trim();
if (extra) {
  rules.push({ path: "**", merge_system_rule: true, rule: extra });
}
// The OCR allowlist rejects some extensions outright (e.g. .gd). An include
// pattern bypasses the unsupported_ext/default_path gates, so operators can opt
// extra file types in without forking the CLI. Excludes are merged the same way:
// the base rule file list is kept and OCR_EXCLUDE adds to it (user excludes are
// the highest-precedence filter, so this is how noisy paths are dropped without
// touching the repositories).
const patterns = (name) => (process.env[name] || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const include = patterns("OCR_INCLUDE");
const exclude = patterns("OCR_EXCLUDE");
const merged = { ...base, rules };
if (include.length > 0) {
  merged.include = [...new Set([...(Array.isArray(base.include) ? base.include : []), ...include])];
}
if (exclude.length > 0) {
  merged.exclude = [...new Set([...(Array.isArray(base.exclude) ? base.exclude : []), ...exclude])];
}
fs.writeFileSync("/tmp/rule.json", JSON.stringify(merged));
'
RULE_ARGS=(--rule /tmp/rule.json)

# Requirement/business context (PR title + description) goes through
# `--background`, which OCR injects into the plan and main prompts. The receiver
# already trims it to the recommended 2000 characters; clamp again here so a
# stale receiver cannot push a description large enough to hurt review quality.
BACKGROUND_ARGS=()
if [ -n "${OCR_BACKGROUND:-}" ]; then
  BACKGROUND_ARGS=(--background "${OCR_BACKGROUND:0:2000}")
fi

# Optional review tuning. Every value is passed only when set, so the CLI/template
# defaults still apply otherwise (effort=medium, task timeout=15 min scaled by
# effort, no token budget, template tool-round cap).
TUNING_ARGS=()
[ -n "${OCR_EFFORT:-}" ] && TUNING_ARGS+=(--effort "${OCR_EFFORT}")
[ -n "${OCR_TASK_TIMEOUT:-}" ] && TUNING_ARGS+=(--timeout "${OCR_TASK_TIMEOUT}")
[ -n "${OCR_MAX_TOKENS_BUDGET:-}" ] && TUNING_ARGS+=(--max-tokens-budget "${OCR_MAX_TOKENS_BUDGET}")
[ -n "${OCR_MAX_TOKENS:-}" ] && TUNING_ARGS+=(--max-tokens "${OCR_MAX_TOKENS}")
[ -n "${OCR_MAX_TOOLS:-}" ] && TUNING_ARGS+=(--max-tools "${OCR_MAX_TOOLS}")

do_review() {
  ocr review \
    --from "${FROM_REF}" \
    --to "origin/pr-${PR_NUMBER}" \
    --format json \
    --audience agent \
    --output /tmp/result.json \
    --concurrency "${OCR_CONCURRENCY:-8}" \
    "${TUNING_ARGS[@]}" \
    "${BACKGROUND_ARGS[@]}" \
    "${RULE_ARGS[@]}" \
    >/tmp/ocr.stdout 2>/tmp/ocr.stderr
}

set +e
do_review
rc=$?
if [ "${rc}" -ne 0 ] || [ ! -s /tmp/result.json ]; then
  if [ -n "${OCR_LLM_FALLBACK_MODEL:-}" ]; then
    log "primary review failed (rc=${rc}); retrying with ${OCR_LLM_FALLBACK_MODEL}"
    ocr config set llm.model "${OCR_LLM_FALLBACK_MODEL}"
    do_review
    rc=$?
  fi
fi
set -e

tail -n 40 /tmp/ocr.stderr >&2 || true

if [ ! -s /tmp/result.json ]; then
  log "no result JSON produced (ocr rc=${rc})"
  exit "${rc:-1}"
fi

log "posting review (ocr rc=${rc})"
node /usr/local/bin/post-review.mjs /tmp/result.json
