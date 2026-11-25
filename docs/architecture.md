# Architecture

## Delivery → Job

1. **Receive.** `receiver.mjs` accepts `POST /webhook` and reads the raw body
   before parsing.
2. **Authenticate.** Provider is chosen by header (`X-Gitea-Event` ⇒ Gitea, else
   GitHub App). The HMAC-SHA256 signature is compared in constant time
   (`X-Hub-Signature-256`, or the hex `X-Gitea-Signature` for Gitea). Bad
   signatures are 401; accepted deliveries are 202 *before* work starts.
3. **Authorize.** GitHub: `OWNER`/`MEMBER`/`COLLABORATOR` for `/review`.
   Gitea: collaborator permission `owner`/`admin`/`write`.
4. **Create the Job.** A `batch/v1` Job is named
   `ocr-<owner>-<repo>-<pr>-<sha7>` (manual runs get a timestamp suffix). A
   duplicate delivery hits `409 AlreadyExists`, which is a no-op.
5. **Run.** The Job clones the repo, fetches `refs/pull/<n>/head`, runs
   `ocr review --from <base> --to <head> --format json`, then posts.

The receiver keeps no queue and no state beyond in-memory metrics. Kubernetes is
the queue.

## Job environment

| Variable | Meaning |
|---|---|
| `GIT_TOKEN` | provider token (installation token or Gitea PAT) |
| `GIT_PROVIDER` | `github` \| `gitea` |
| `GIT_SCHEME` / `GIT_HOST` / `GIT_AUTH_USER` | clone URL parts |
| `REPO`, `PR_NUMBER`, `BASE_REF`, `HEAD_SHA` | review target |
| `GITEA_API_URL`, `GITEA_BOT_LOGIN` | Gitea posting |
| `OCR_LLM_*` | endpoint, model, fallback, extra body, timeout |
| `OCR_BACKGROUND` | PR title + description, passed as `--background` |
| `OCR_INSTRUCTION` | manual `/review <instruction>` text, added as a rule |
| `OCR_EFFORT`, `OCR_TASK_TIMEOUT`, `OCR_MAX_TOKENS`, `OCR_MAX_TOKENS_BUDGET`, `OCR_MAX_TOOLS`, `OCR_EXCLUDE` | review tuning, forwarded only when set |

`GIT_TOKEN`, `OCR_LLM_TOKEN` and LLM values are env vars inside the Job pod;
Kubernetes Secrets are mounted as env, not files, for the token.

## Review policy

Mirrors PR-Agent so both can be compared:

- **Rules from the base ref.** `.opencodereview/rule.json` is read from the
  *base*, never the PR head, so a PR cannot weaken the rules. A manual
  `/review <instruction>` adds one `**` rule (`merge_system_rule: true`),
  preserving the built-in rules. `OCR_EXCLUDE` globs are merged into the rule
  file's `exclude`.
- **Context.** The PR title and description go through `--background`, not a
  rule, clamped to OCR's recommended 2000 characters.
- **Severity.** `critical`/`high` → `Important —`, `medium`/`low` →
  `Nit —`; Important first; at most `OCR_MAX_NITS` nits inline.
- **Dedupe.** One finding per `path + category + existing code`.
- **Include overrides.** Some extensions are not in OCR's allowlist
  (`.gd`, `.md`, `.tscn`, `.tres`). `OCR_INCLUDE` globs are merged into the
  rule file's `include`, which bypasses the `unsupported_ext` gate.
- **Skip generated.** `node_modules`, `vendor`, lockfiles, `*.min.js`,
  generated code, and similar paths are dropped.
- **Fallback.** One retry with `OCR_LLM_FALLBACK_MODEL` if the primary run fails
  or produces no result.
- **Incremental.** Inline findings already posted by the bot are skipped.
  GitHub compares line intervals; Gitea compares the rendered body per path.
- **Summary.** One sticky comment with `<!-- ocr-summary -->`, updated in place;
  findings that cannot be anchored inline are listed there, and so are the
  files a partial run did not review (`manifest.coverage.failed`, with the
  classification and reason) and the reviewer's `warnings[]`. Cached tokens are
  shown when the provider reports them.

## Metrics

The receiver exposes `/metrics`. The Job reports back to `/report` with status,
tokens, elapsed and finding count, so counters describe completed reviews rather
than just deliveries.

## Design notes

- **Why a Job, not the receiver?** Reviews are long (minutes) and CPU/network
  heavy. Jobs are isolated, capped by `activeDeadlineSeconds`, and disappear
  (`ttlSecondsAfterFinished`).
- **Why no GitHub Checks API?** Review comments are the common denominator
  between GitHub and Gitea; Checks would be GitHub-only.
- **No self-update in the Job.** The CLI launcher runs `npm i -g` in the
  background when it sees a newer release, which unlinks `/usr/local/bin/ocr`
  mid-review. The Job image sets `OCR_NO_UPDATE=1` (and the receiver passes it
  too) so the pinned version is the version that runs.
- **Why one image per concern?** The receiver never installs the CLI; the Job
  image never holds provider webhook secrets beyond its own token.
