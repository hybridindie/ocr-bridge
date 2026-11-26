#!/usr/bin/env bash
# OpenCodeReview review job entrypoint.
#
# Expects: GIT_TOKEN, REPO, PR_NUMBER, BASE_REF, HEAD_SHA,
#          OCR_LLM_URL, OCR_LLM_MODEL, OCR_LLM_TOKEN.
# Optional: OCR_USE_ANTHROPIC, OCR_LLM_PROTOCOL, OCR_LLM_EXTRA_BODY,
#           OCR_LLM_TIMEOUT, OCR_CONCURRENCY, OCR_LANGUAGE, OCR_BACKGROUND,
#           OCR_EFFORT, OCR_TASK_TIMEOUT, OCR_MAX_TOKENS_BUDGET, OCR_MAX_TOKENS,
#           OCR_MAX_TOOLS, OCR_EXCLUDE, OCR_ROUTE_SEVERITY_BELOW, OCR_ROUTE_CATEGORIES,
#           OCR_RESOLVE_OUTDATED, OCR_CHECKPOINT, CHECKPOINT_SHA, CHECKPOINT_BASE_SHA,
#           OCR_SKIP_UNCHANGED_REBASE, OCR_SEVERITY_RUBRIC, OCR_NITS_FIRST_ROUND_ONLY,
#           OCR_DEMOTE_UNQUOTED_IMPORTANT, OCR_ALLOW_GIT_METADATA_CHANGES,
#           OCR_TMPDIR, OCR_WORKDIR, OCR_POSTER.
set -uo pipefail

log() { printf '[ocr-job] %s\n' "$*" >&2; }

: "${GIT_TOKEN:?}" "${REPO:?}" "${PR_NUMBER:?}" "${BASE_REF:?}" "${HEAD_SHA:?}"
: "${OCR_LLM_URL:?}" "${OCR_LLM_MODEL:?}" "${OCR_LLM_TOKEN:?}"

# Scratch paths. The defaults are the Job's; the overrides exist for
# run-review.test.mjs, which runs this script against a local origin.
TMPD="${OCR_TMPDIR:-/tmp}"
POSTER="${OCR_POSTER:-/usr/local/bin/post-review.mjs}"
export OCR_TMPDIR="$TMPD"

# ocr config set writes under $HOME; keep it writable and ephemeral.
export HOME="$TMPD/ocr-home"
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

WORK="${OCR_WORKDIR:-/workspace}"
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
BASE_SHA="$(git rev-parse "origin/${BASE_REF}")"

# Pin the review to the head the webhook announced. `refs/pull/<n>/head` can
# already point at a newer commit when a force-push lands between delivery and
# fetch, and reviewing that would attach a different snapshot to this Job's SHA
# and to the checkpoint written into its summary (a newer push has its own Job).
# The superseded commit normally stays fetchable by id after a force-push; if it
# does not, this Job is a no-op rather than a review of the wrong commit.
if ! git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  git fetch -q --no-tags origin "${HEAD_SHA}" >/dev/null 2>&1 || true
fi
if ! git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  log "head moved: ${HEAD_SHA:0:7} is no longer fetchable; a newer delivery owns this review"
  exit 0
fi
REVIEWED_HEAD="$(git rev-parse "${HEAD_SHA}^{commit}")"
git checkout -q --detach "$REVIEWED_HEAD"
export OCR_BASE_SHA="$BASE_SHA"
export OCR_REVIEWED_HEAD="$REVIEWED_HEAD"

is_off() { case "${1:-}" in false|0|no|FALSE|False) return 0 ;; *) return 1 ;; esac; }
is_on() { case "${1:-}" in true|1|yes|TRUE|True) return 0 ;; *) return 1 ;; esac; }

# A criss-cross history has more than one merge base and `git diff base...head`
# silently picks one, so the reviewed patch would not be the PR's. Refuse rather
# than review an ambiguous range.
MERGE_BASES="$(git merge-base --all "$BASE_SHA" "$REVIEWED_HEAD" | wc -l | tr -d ' ')"
if [ "$MERGE_BASES" != "1" ]; then
  log "refusing: ${BASE_SHA:0:7}..${REVIEWED_HEAD:0:7} has ${MERGE_BASES} merge bases; the patch is ambiguous"
  exit 1
fi

# A PR that changes git's diff policy can hide its own changes: `.gitattributes`
# can mark a file binary or attach a diff driver, and `.gitmodules` can replace a
# directory with a pointer the review cannot see into. Refuse unless explicitly
# allowed. `.gitignore` only affects untracked files, so it is a warning.
GIT_META="$(git diff --name-only --no-renames "${BASE_SHA}...${REVIEWED_HEAD}" -- \
  .gitattributes ':(glob)**/.gitattributes' .gitmodules 2>/dev/null || true)"
if [ -n "$GIT_META" ] && ! is_on "${OCR_ALLOW_GIT_METADATA_CHANGES:-false}"; then
  log "refusing: the PR changes git diff policy: $(printf '%s' "$GIT_META" | tr '\n' ' ')"
  log "set OCR_ALLOW_GIT_METADATA_CHANGES=true to review it anyway"
  exit 1
fi
GIT_IGNORE="$(git diff --name-only --no-renames "${BASE_SHA}...${REVIEWED_HEAD}" -- .gitignore 2>/dev/null || true)"
if [ -n "$GIT_IGNORE" ]; then
  log "warning: the PR changes .gitignore; untracked files are not reviewed"
fi

# The patch a PR proposes: base...head (merge-base to head) through
# `git patch-id --stable`, which ignores commit ids, messages, line numbers and
# file order. Empty output for an empty diff.
patch_id() {
  git diff --no-color --no-ext-diff "$1...$2" 2>/dev/null | git patch-id --stable | awk '{print $1}'
}

ensure_commit() {
  git cat-file -e "$1^{commit}" 2>/dev/null \
    || git fetch -q --no-tags origin "$1" >/dev/null 2>&1 || true
  git cat-file -e "$1^{commit}" 2>/dev/null
}

# Skip unchanged rebases. A push that only rebased the PR (onto a newer base,
# or a stacked PR retargeted onto main after its lower PR squash-merged)
# proposes the same patch as the head the last complete review covered. Then
# re-running the model only re-files old findings, so move the checkpoint to the
# new head and stop. Any doubt (no checkpoint, unfetchable commits, an empty or
# different patch, a failed summary update) falls through to a normal review.
if ! is_off "${OCR_SKIP_UNCHANGED_REBASE:-true}" \
  && [ -n "${CHECKPOINT_SHA:-}" ] && [ -n "${CHECKPOINT_BASE_SHA:-}" ] \
  && [ "$REVIEWED_HEAD" = "$HEAD_SHA" ] && [ "$CHECKPOINT_SHA" != "$REVIEWED_HEAD" ]; then
  if ensure_commit "$CHECKPOINT_SHA" && ensure_commit "$CHECKPOINT_BASE_SHA"; then
    OLD_PATCH="$(patch_id "$CHECKPOINT_BASE_SHA" "$CHECKPOINT_SHA")"
    NEW_PATCH="$(patch_id "$BASE_SHA" "$REVIEWED_HEAD")"
    if [ -n "$NEW_PATCH" ] && [ "$OLD_PATCH" = "$NEW_PATCH" ]; then
      log "rebased, patch unchanged (patch-id ${NEW_PATCH:0:12}); carrying review of ${CHECKPOINT_SHA:0:7} forward"
      if CHECKPOINT_SHA="$CHECKPOINT_SHA" node "$POSTER" --carry-forward; then
        exit 0
      fi
      log "carry-forward failed; reviewing instead"
    else
      log "patch changed since ${CHECKPOINT_SHA:0:7} (patch-id ${OLD_PATCH:0:12} -> ${NEW_PATCH:0:12})"
    fi
  else
    log "checkpoint commits unavailable; cannot compare patches"
  fi
fi

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

log "reviewing ${REPO}#${PR_NUMBER} (${FROM_REF}...${REVIEWED_HEAD})"

# Rule policy:
#  - use the *base* ref's .opencodereview/rule.json, never the PR head, so a PR
#    cannot weaken the rules (PR-Agent reads .pr_agent.toml from the base too);
#  - append one broad rule for a manual `/review <instruction>` command, keeping
#    the built-in system rules. The PR title/description is *not* a rule: it goes
#    through `--background` (OCR's documented channel for requirement context).
if git cat-file -e "origin/${BASE_REF}:.opencodereview/rule.json" 2>/dev/null; then
  git show "origin/${BASE_REF}:.opencodereview/rule.json" > "$TMPD/base-rule.json"
else
  printf '{"rules":[]}' > "$TMPD/base-rule.json"
fi
OCR_INSTRUCTION="${OCR_INSTRUCTION:-}" OCR_SEVERITY_RUBRIC="${OCR_SEVERITY_RUBRIC:-true}" node -e '
const fs = require("fs");
let base = { rules: [] };
try {
  base = JSON.parse(fs.readFileSync(process.env.OCR_TMPDIR + "/base-rule.json", "utf8"));
} catch (err) {
  console.error("ignoring invalid base rule.json: " + err.message);
}
// Severity rubric. The OCR CLI defines no meaning for its severity enum, and the
// poster maps high/critical to "Important" threads that must be answered before
// merge. Without a bar the model files speculative findings as Important.
// "false" disables it; any other non-boolean value replaces the default text.
const DEFAULT_RUBRIC = [
  "Severity rubric (applies to every finding).",
  "Use severity high or critical only for a defect you can demonstrate: name the concrete input, state or call sequence that triggers it, state the wrong result it produces (a wrong value, crash, hang, data loss or security exposure), and quote the code path that produces it in backticks.",
  "A finding that lacks any of the three is severity medium or low. So are style, naming, duplication, comments and documentation, test structure, missing tests, and risks phrased as could, might or consider.",
  "When unsure, choose medium.",
].join(" ");
const rubricSetting = (process.env.OCR_SEVERITY_RUBRIC || "true").trim();
const rubric = /^(false|0|no)$/i.test(rubricSetting)
  ? ""
  : (/^(true|1|yes)$/i.test(rubricSetting) ? DEFAULT_RUBRIC : rubricSetting);
// OCR applies the first rule whose path matches a file, so text meant for
// every file (the rubric, a manual `/review <instruction>`) is appended to each
// rule and to a trailing catch-all for files no rule covers.
const shared = [rubric, (process.env.OCR_INSTRUCTION || "").trim()].filter(Boolean).join("\n\n");
const rules = (Array.isArray(base.rules) ? base.rules : []).map((entry) => (
  shared && entry && typeof entry === "object"
    ? { ...entry, rule: [entry.rule, shared].filter(Boolean).join("\n\n") }
    : entry
));
if (shared) {
  rules.push({ path: "**", merge_system_rule: true, rule: shared });
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
fs.writeFileSync(process.env.OCR_TMPDIR + "/rule.json", JSON.stringify(merged));
'
RULE_ARGS=(--rule "$TMPD/rule.json")

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
    --to "${REVIEWED_HEAD}" \
    --format json \
    --audience agent \
    --output "$TMPD/result.json" \
    --concurrency "${OCR_CONCURRENCY:-8}" \
    "${TUNING_ARGS[@]}" \
    "${BACKGROUND_ARGS[@]}" \
    "${RULE_ARGS[@]}" \
    >"$TMPD/ocr.stdout" 2>"$TMPD/ocr.stderr"
}

set +e
do_review
rc=$?
if [ "${rc}" -ne 0 ] || [ ! -s "$TMPD/result.json" ]; then
  if [ -n "${OCR_LLM_FALLBACK_MODEL:-}" ]; then
    log "primary review failed (rc=${rc}); retrying with ${OCR_LLM_FALLBACK_MODEL}"
    ocr config set llm.model "${OCR_LLM_FALLBACK_MODEL}"
    do_review
    rc=$?
  fi
fi
set -e

tail -n 40 "$TMPD/ocr.stderr" >&2 || true

if [ ! -s "$TMPD/result.json" ]; then
  log "no result JSON produced (ocr rc=${rc})"
  exit "${rc:-1}"
fi

log "posting review (ocr rc=${rc})"
node "$POSTER" "$TMPD/result.json"
