# ocr-bridge

A small, self-hosted bridge that runs
[OpenCodeReview](https://github.com/alibaba/open-code-review) on pull requests
as **ephemeral Kubernetes Jobs**.

It is a webhook receiver — not a GitHub Action — so it works with a **GitHub
App** *or* **Gitea**, keeps long reviews off your CI runners, and talks to any
OpenAI-compatible LLM endpoint (vLLM, LiteLLM, MLflow AI Gateway, Ollama Cloud,
…).

```
 provider webhook (HMAC)
        │
        ▼
 ┌──────────────┐   create Job    ┌───────────────┐
 │  receiver    │ ──────────────► │  review Job   │
 │  (1 replica) │                 │  (per PR/SHA) │
 └──────┬───────┘                 └───────┬───────┘
        │ /metrics, /report               │ git fetch + `ocr review`
        ▼                                 ▼
   Prometheus                     provider REST API
                                  (inline + sticky comments)
```

- **Provider-neutral**: GitHub App (installation tokens) or Gitea (access token).
- **One Job per PR head SHA**; duplicate deliveries are 409 no-ops.
- **Policy parity with PR-Agent**: severity prefixes, Important-first, capped
  nits, one finding per root cause, generated-path filtering, base-ref rules,
  PR title and description as `--background` context, fallback model,
  incremental comments, sticky summary.
- **Incremental across pushes**: a fully covered review records a checkpoint,
  and the next push reviews only the commits since it. Outdated bot threads
  can be resolved automatically (GitHub).
- **Reviews converge**: nits inline on the first review only, no re-review
  of an unchanged rebase, and a severity rubric for Important findings
  ([why](#why-reviews-dont-converge)).
- **Partial runs are explained**: files OCR could not review and its warnings
  are listed in the summary, with the reason.
- **Metrics**: webhooks, jobs, reviews, tokens, findings, duration.

## Contents

- [Quick start](#quick-start)
- [GitHub App setup](docs/github-app.md)
- [Gitea setup](docs/gitea.md)
- [Configuration](#configuration)
- [How it works](docs/architecture.md)
- [Security](docs/security.md)
- [Design write-up](docs/blog/2026-11-13-self-hosting-opencodereview.md)
- [Development](#development)

## Quick start

Requirements: Kubernetes, Helm 3, an OpenAI-compatible endpoint, and a Git host
webhook.

### 1. Build and publish the images

Published defaults follow the chart version: `ocr-receiver:<chart>` and `ocr-job:<ocr-cli>-bridge<chart>` (for example `0.5.1` and `1.14.4-bridge0.5.1`), so a public build never shares a tag with a private build pushed to the same registry. Build your own with the commands below and set `image.*.repository`/`tag`.

```bash
podman build -t ghcr.io/you/ocr-receiver:0.5.1 -f Dockerfile.receiver .
podman build -t ghcr.io/you/ocr-job:1.14.4-bridge0.5.1 -f Dockerfile.job .
podman push ghcr.io/you/ocr-receiver:0.5.1
podman push ghcr.io/you/ocr-job:1.14.4-bridge0.5.1
```

`ocr-job` pins the CLI (`ARG OCR_VERSION`); bump the tag with it. Add
`--build-arg GIT_SHIM=true` to install the optional `git grep` wrapper
([below](#code_search-and-pcre)).

### 2. Create the secrets

```bash
# Provider secrets (keys are fixed)
kubectl create ns ocr
kubectl -n ocr create secret generic ocr-app \
  --from-literal=app-id=123456 \
  --from-literal=webhook-secret="$GITHUB_WEBHOOK_SECRET" \
  --from-file=private-key.pem=./private-key.pem

kubectl -n ocr create secret generic ocr-gitea \
  --from-literal=token="$GITEA_TOKEN" \
  --from-literal=webhook-secret="$GITEA_WEBHOOK_SECRET"

# LLM gateway token
kubectl -n ocr create secret generic ocr-llm --from-literal=token="$LLM_TOKEN"
```

Omit unused providers and disable them in `values.yaml`.

### 3. Install

```bash
helm install ocr-bridge deploy/helm/ocr-bridge -n ocr \
  --set llm.url=http://vllm.ai.svc.cluster.local/v1 \
  --set llm.model=Qwen3.8-27B \
  --set image.receiver.repository=ghcr.io/you/ocr-receiver \
  --set image.job.repository=ghcr.io/you/ocr-job
```

`LLM_MODEL` is the **bare** endpoint name when you talk to a gateway/LiteLLM —
an `openai/` prefix is stripped by LiteLLM clients and is *not* valid here.

### 4. Expose `/webhook`

Point an Ingress, Tailscale Funnel, or a tunnel at
`ocr-bridge.<ns>.svc.cluster.local:8080`. Then configure the provider:

- GitHub App → [docs/github-app.md](docs/github-app.md)
- Gitea → [docs/gitea.md](docs/gitea.md)

### 5. Prove it

```bash
# unsigned POST must be 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ocr.example.com/webhook \
  -H 'Content-Type: application/json' -d '{}'

kubectl -n ocr get jobs,pods
kubectl -n ocr logs job/ocr-<repo>-<pr>-<sha> --tail=100
```

A successful run posts inline comments plus one sticky summary beginning with
`<!-- ocr-summary -->`.

## Manual trigger

Comment on the PR:

| Comment | Effect |
|---|---|
| `/review` | review the current head |
| `/ocr`, `/open-code-review` | aliases |
| `@open-code-review` | mention form |
| `/review focus on auth` | add a one-off instruction rule |

GitHub gates commands on `OWNER`/`MEMBER`/`COLLABORATOR`
(`policy.allowedAssociations`). Gitea has no `author_association`, so the
receiver checks the collaborator permission API and accepts owner/admin/write.

## Configuration

Set under `policy`, `llm`, `job`, `providers` in `values.yaml`; they map to the
pod's environment.

| Value | Env | Default | Notes |
|---|---|---|---|
| `providers.github.enabled` | — | `true` | GitHub App webhooks |
| `providers.gitea.enabled` | — | `true` | Gitea webhooks |
| `providers.gitea.apiUrl` | `GITEA_API_URL` | — | in-cluster `/api/v1` base |
| `providers.gitea.botLogin` | `GITEA_BOT_LOGIN` | — | scopes incremental dedupe |
| `llm.url` | `OCR_LLM_URL` | — | OpenAI-compatible base URL |
| `llm.model` | `OCR_LLM_MODEL` | — | e.g. `Qwen3.8-27B` |
| `llm.fallbackModel` | `OCR_LLM_FALLBACK_MODEL` | — | retried once on failure |
| `llm.extraBody` | `OCR_LLM_EXTRA_BODY` | — | JSON merged into requests |
| `policy.maxNits` | `OCR_MAX_NITS` | `3` | max low-severity inline |
| `policy.incremental` | `OCR_INCREMENTAL` | `true` | skip posted findings |
| `policy.concurrency` | `OCR_CONCURRENCY` | `4` | file reviews in parallel |
| `policy.include` | `OCR_INCLUDE` | — | globs that bypass the extension allowlist, e.g. `**/*.gd` |
| `policy.exclude` | `OCR_EXCLUDE` | — | globs added to the rule file's `exclude` |
| `policy.effort` | `OCR_EFFORT` | CLI (`medium`) | `--effort`: 1/2/3 review rounds |
| `policy.taskTimeout` | `OCR_TASK_TIMEOUT` | CLI (15, scaled by effort) | `--timeout`, minutes per subtask |
| `policy.maxTokens` | `OCR_MAX_TOKENS` | CLI (200k) | `--max-tokens`, prompt ceiling per subtask; keep it below the model's context |
| `policy.maxTokensBudget` | `OCR_MAX_TOKENS_BUDGET` | — (unlimited) | `--max-tokens-budget`, total tokens per review; a runaway guard |
| `policy.maxTools` | `OCR_MAX_TOOLS` | CLI | `--max-tools`, tool-call rounds per subtask |
| `policy.checkpoint` | `OCR_CHECKPOINT` | `true` | review `<checkpoint>..<head>` on later pushes ([below](#cross-push-checkpoints)) |
| `policy.resolveOutdated` | `OCR_RESOLVE_OUTDATED` | `report` | `false` \| `report` \| `true`; GitHub only |
| `policy.routeSeverityBelow` | `OCR_ROUTE_SEVERITY_BELOW` | — | findings at or below this severity go to the summary |
| `policy.routeCategories` | `OCR_ROUTE_CATEGORIES` | — | categories that go to the summary, e.g. `style,documentation` |
| `policy.nitsFirstRoundOnly` | `OCR_NITS_FIRST_ROUND_ONLY` | `true` | nit threads on the first review only |
| `policy.skipUnchangedRebase` | `OCR_SKIP_UNCHANGED_REBASE` | `true` | carry the review forward when a rebase left the patch unchanged |
| `policy.severityRubric` | `OCR_SEVERITY_RUBRIC` | `true` | `true`, `false`, or replacement rubric text |
| `policy.demoteUnquotedImportant` | `OCR_DEMOTE_UNQUOTED_IMPORTANT` | `false` | post an Important finding that quotes no code as a nit |
| `policy.commands` | `OCR_COMMANDS` | `/review,/ocr,/open-code-review` | |
| `policy.allowedAssociations` | `OCR_ALLOWED_ASSOCIATIONS` | `OWNER,MEMBER,COLLABORATOR` | GitHub only |
| `job.deadlineSeconds` | `OCR_JOB_DEADLINE_SECONDS` | `3600` | activeDeadlineSeconds |

The tuning values are passed to `ocr review` only when set, so an empty value
keeps the CLI default. Per-repository rules, `include` and `exclude` belong in
`.opencodereview/rule.json` on the base branch; the Job merges them with the
values above.

The PR title and description reach the model through `--background`, OCR's
channel for requirement context. The receiver joins them (title first) and
trims the result at a line or word boundary to the recommended 2000
characters; the Job clamps it again.

### Cross-push checkpoints

Without a checkpoint, every push re-reviews the whole `merge-base..head` range,
so a PR that takes five pushes pays for five full reviews.

1. When a run reviewed everything it selected (`manifest.coverage.failed` is
   empty and the status is not `partial` or `failed`), the poster appends
   `<!-- ocr-checkpoint: <head> base=<base sha> -->` to the sticky summary.
2. On the next `pull_request` event the receiver reads that marker and passes
   `CHECKPOINT_SHA` / `CHECKPOINT_BASE_SHA` to the Job. A manual `/review`
   never gets a checkpoint.
3. The Job uses it only if the base ref still resolves to the recorded base,
   the fetched head is the webhook head, and the checkpoint is an ancestor of
   the head (`git merge-base --is-ancestor`). Otherwise it logs
   `checkpoint … unusable; reviewing the full range`.

Fail-closed is the point: a force-push, a merge from the base branch, a
partial run or a missing marker all fall back to a full review.

### Review integrity: pinned head, unique merge-base, no self-hidden diffs

Ported from OpenCodeReview 1.14.4's `review_pr` skill
([alibaba/open-code-review#2038](https://github.com/alibaba/open-code-review/pull/2038)).
All three run in the Job before the model:

- **Pinned head.** The Job reviews the webhook's `HEAD_SHA`, not whatever
  `refs/pull/<n>/head` points at when it runs. A force-push between delivery and
  fetch would otherwise attach a different snapshot to this Job's SHA and to the
  checkpoint in its summary, while a newer delivery already owns that review. If
  the announced commit is unreachable and the server refuses it by id, the Job
  logs `head moved: …` and exits 0 as a no-op.
- **Unique merge-base.** On a criss-cross history `git diff base...head` silently
  picks one merge base, so the reviewed patch is not the PR's. The Job refuses
  with the base/head pair in the log.
- **No self-hidden diffs.** `.gitattributes` and `.gitmodules` let a PR mark a
  file binary, attach a diff driver, or replace a directory with a pointer the
  review cannot see into. The Job refuses and names the paths;
  `OCR_ALLOW_GIT_METADATA_CHANGES=true` overrides it for repositories that
  legitimately maintain those files. `.gitignore` only warns (it affects
  untracked files, not the diff).

A refusal exits 1 and posts nothing, so it surfaces as a failed Job instead of a
review of a doctored diff. `src/run-review.test.mjs` covers all four behaviours.

### Resolving outdated threads

With `policy.resolveOutdated: report`, each GitHub run logs which of the bot's
own outdated, unresolved threads (GraphQL `reviewThreads`) it would resolve. A
thread with any human reply, or one whose lines a current finding still
covers, is never touched. Once the reports look right, set it to `"true"`.
Gitea has no thread-resolution API, so the setting does nothing there.

## Why reviews don't converge

Every push to a PR starts a review, and a model reviewing a diff will nearly
always find something. Left alone, that has three effects:

- **Each fix draws new nits.** Every round may open up to `maxNits` new nit
  threads, often on the commit that fixed the last round's findings, so the
  thread count grows with the number of pushes instead of falling.
- **Rebases are reviewed again.** Rebasing onto a newer base, or retargeting a
  stacked PR onto `main` after its lower PR squash-merged, changes every
  commit id but not the patch. A full re-review re-files the old findings.
- **"Important" has no bar.** The CLI gives its severity levels no meaning,
  and the bridge turns high/critical into `Important —` threads that someone
  has to answer. Without a definition, speculative "this could fail" findings
  land there.

Four settings address them. The first three are on by default.

| Setting | Default | What it does |
|---|---|---|
| `OCR_NITS_FIRST_ROUND_ONLY` | on | The poster counts reviews in the sticky summary (`<!-- ocr-round: N -->`; a summary from before the marker counts as one, the "nothing reviewable" summary as zero). Round 1 posts up to `OCR_MAX_NITS` nits inline. Later rounds post only Important findings inline and list nits in a collapsed *Nits* section of the summary. |
| `OCR_SKIP_UNCHANGED_REBASE` | on | With a checkpoint, the Job compares `git diff <base>...<head> \| git patch-id --stable` for the checkpoint (against its recorded base) and for the new head (against the current base). If they are equal and non-empty, the model is not run: `post-review.mjs --carry-forward` moves the checkpoint to the new head and notes "Rebased, patch unchanged; previous review carried forward". Any doubt (no checkpoint, a commit that cannot be fetched, no summary to update) falls back to a normal review. `/report` records the run as `carried`. |
| `OCR_SEVERITY_RUBRIC` | on | Appends a rubric to every rule in the generated rule file, and to a trailing `**` catch-all, because OCR applies only the first matching rule: high/critical only for a defect with a concrete triggering input or state, the wrong result, and a backtick quote of the code path; anything else is medium or low. Any value other than true/false replaces the text. |
| `OCR_DEMOTE_UNQUOTED_IMPORTANT` | **off** | A backstop in the poster: a high/critical finding whose text has no inline code span is posted as a nit. It is a heuristic, and on prose-heavy repositories or documentation reviews a correct Important finding often quotes no code, so turn it on only where findings are about code. |

Skipping unchanged rebases depends on checkpoints (`policy.checkpoint`).

## code_search and PCRE

OCR's `code_search` tool runs `git grep -i -P -n ... -e <text>` when the model
sets `use_perl_regexp`, and models set it for literal text such as
`falls(&self, ground:`, which PCRE rejects ("missing closing parenthesis").
Before CLI 1.14.3 the tool call then returned nothing and the model reviewed
without the search it asked for. 1.14.3 (upstream
[alibaba/open-code-review#1811](https://github.com/alibaba/open-code-review/pull/1811))
returns the regex error to the model so it can retry.

`src/git-shim.sh` is an **optional** stopgap from before that fix. Built with
`--build-arg GIT_SHIM=true`, the Job image installs it as `/usr/local/bin/git`:
a `git grep -P` that fails to compile its pattern is retried once with `-F`,
and every other git command goes straight to `/usr/bin/git`. The default image
does not install it. Once 1.14.3 is confirmed on your reviews, the shim (and
the build argument) can be removed.

## Metrics

`/metrics` (Prometheus):

```
ocr_webhooks_total{provider,event,action}
ocr_jobs_created_total
ocr_jobs_create_errors_total
ocr_commands_ignored_total
ocr_reviews_total{repo,status}
ocr_review_tokens_total{repo}
ocr_review_findings_total{repo}
ocr_review_duration_seconds{repo}
```

The Job posts its result to `/report`, so token/finding/duration metrics come
from the review itself. Set `podMonitor.enabled=true` for the Prometheus
Operator.

## Compatibility

| Component | Tested |
|---|---|
| OpenCodeReview CLI | 1.14.3 (pinned in `Dockerfile.job`) |
| git (Job image) | ≥ 2.41, as OCR requires (`node:*-trixie-slim`; the build checks it) |
| Kubernetes | 1.28+ (`batch/v1` Jobs, `ttlSecondsAfterFinished`) |
| Gitea | 1.22+ / 28.x |
| GitHub | GitHub App, REST 2022-11-28 |
| LLM | any OpenAI-compatible `/chat/completions` |

## Limitations

- Reviews every PR (`opened`, `synchronized`, `reopened`); there is no
  per-repo enable list beyond which webhooks you install.
- No GitHub Checks API integration — findings are review comments only.
- Gitea inline comments are single-line (`new_position`), and incremental dedupe
  compares rendered bodies because Gitea does not expose a PR-wide review
  comment collection.
- One receiver replica is assumed; Jobs are name-deduped, so extra replicas are
  safe but untested.

## Development

Node stdlib only — no runtime dependencies.

```bash
npm test          # node --test src/*.test.mjs
npm start         # run the receiver locally (needs env, see values.yaml)
```

The receiver and poster are unit-tested against mock GitHub, Gitea and
Kubernetes servers, plus a Job-spec contract test. `run-review.test.mjs` runs
the Job script against a local bare origin with stub `ocr` and poster binaries
(unchanged-rebase skip, stacked-PR retarget, incremental range, rubric, the
git wrapper); it needs `git` and `bash`.

## License

MIT. OpenCodeReview itself is Apache-2.0 and is installed at image build time,
not vendored.
