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

```bash
podman build -t ghcr.io/you/ocr-receiver:1.2.2 -f Dockerfile.receiver .
podman build -t ghcr.io/you/ocr-job:1.13.10-r2 -f Dockerfile.job .
podman push ghcr.io/you/ocr-receiver:1.2.2
podman push ghcr.io/you/ocr-job:1.13.10-r2
```

`ocr-job` pins the CLI (`ARG OCR_VERSION`); bump the tag with it.

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
| OpenCodeReview CLI | 1.13.x (pinned in `Dockerfile.job`) |
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
Kubernetes servers, plus a Job-spec contract test.

## License

MIT. OpenCodeReview itself is Apache-2.0 and is installed at image build time,
not vendored.
