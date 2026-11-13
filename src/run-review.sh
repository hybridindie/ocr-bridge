#!/usr/bin/env bash
# OpenCodeReview review job entrypoint.
#
# Expects: GIT_TOKEN, REPO, PR_NUMBER, BASE_REF, HEAD_SHA,
#          OCR_LLM_URL, OCR_LLM_MODEL, OCR_LLM_TOKEN.
# Optional: OCR_USE_ANTHROPIC, OCR_LLM_PROTOCOL, OCR_LLM_EXTRA_BODY,
#           OCR_LLM_TIMEOUT, OCR_CONCURRENCY, OCR_LANGUAGE.
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

log "reviewing ${REPO}#${PR_NUMBER} (${BASE_REF}...${HEAD_SHA})"

# Rule policy:
#  - use the *base* ref's .opencodereview/rule.json, never the PR head, so a PR
#    cannot weaken the rules (PR-Agent reads .pr_agent.toml from the base too);
#  - append one broad rule built from the PR description (ticket compliance)
#    and/or the manual command text, keeping the built-in system rules.
if git cat-file -e "origin/${BASE_REF}:.opencodereview/rule.json" 2>/dev/null; then
  git show "origin/${BASE_REF}:.opencodereview/rule.json" > /tmp/base-rule.json
else
  printf '{"rules":[]}' > /tmp/base-rule.json
fi
OCR_PR_BODY="${OCR_PR_BODY:-}" OCR_INSTRUCTION="${OCR_INSTRUCTION:-}" node -e '
const fs = require("fs");
let base = { rules: [] };
try {
  base = JSON.parse(fs.readFileSync("/tmp/base-rule.json", "utf8"));
} catch (err) {
  console.error("ignoring invalid base rule.json: " + err.message);
}
const rules = Array.isArray(base.rules) ? base.rules : [];
const extra = [process.env.OCR_PR_BODY, process.env.OCR_INSTRUCTION]
  .map((value) => (value || "").trim())
  .filter(Boolean)
  .join("\n\n");
if (extra) {
  rules.push({ path: "**", merge_system_rule: true, rule: extra });
}
fs.writeFileSync("/tmp/rule.json", JSON.stringify({ ...base, rules }));
'
RULE_ARGS=(--rule /tmp/rule.json)

do_review() {
  ocr review \
    --from "origin/${BASE_REF}" \
    --to "origin/pr-${PR_NUMBER}" \
    --format json \
    --audience agent \
    --output /tmp/result.json \
    --concurrency "${OCR_CONCURRENCY:-8}" \
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
