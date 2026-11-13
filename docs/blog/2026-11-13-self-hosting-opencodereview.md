---
title: Self-hosting OpenCodeReview on GitHub and Gitea
date: 2026-11-13
description: A webhook receiver that turns OpenCodeReview into ephemeral Kubernetes Jobs, and the Gitea quirks that made it worth writing down.
tags: [kubernetes, code-review, llm, gitea, github]
---

# Self-hosting OpenCodeReview on GitHub and Gitea

[OpenCodeReview](https://github.com/alibaba/open-code-review) is an Apache-2.0
code-review CLI: point it at a diff, give it an OpenAI-compatible model, and it
returns structured findings. The upstream examples wire it into GitHub Actions.
That is a fine default, but it has two problems for a self-hosted setup:

1. **It runs on your CI runners.** Reviews are long, token-hungry and network
   heavy; they compete with builds.
2. **It assumes GitHub.** If your code lives on Gitea, the action does not help.

So I wrote a small bridge: a webhook receiver that creates **one ephemeral
Kubernetes Job per pull request head SHA**, runs `ocr review` inside it, and
posts the findings back. It supports a GitHub App and Gitea, and it is
provider-neutral about the model.

The result is [**ocr-bridge**](https://github.com/hybridindie/ocr-bridge). This
post is the design tour and the Gitea knowledge that is hard to find elsewhere.

## Shape

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
```

The receiver does four things: verify the signature, decide whether the event
is actionable, mint a provider token, and create a Job. It keeps no queue —
Kubernetes is the queue. A duplicate delivery is a `409 AlreadyExists` no-op
because the Job name is deterministic (`ocr-<owner>-<repo>-<pr>-<sha7>`).

The Job clones the repo, fetches `refs/pull/<n>/head`, and runs:

```bash
ocr review --from origin/<base> --to origin/pr-<n> \
  --format json --audience agent --output /tmp/result.json \
  --concurrency 8 --rule /tmp/rule.json
```

Then a small poster turns the JSON into review comments.

## Why a Job and not the receiver

A review takes minutes and can consume gigabytes of memory. Doing that in the
webhook process couples availability to the slowest review and makes resource
limits meaningless. Jobs give isolation, a hard `activeDeadlineSeconds`, and
`ttlSecondsAfterFinished` cleanup. The Job runs with a service account that has
`automountServiceAccountToken: false` and no RBAC — a review pod cannot touch
the cluster.

## Policy parity with PR-Agent

I had PR-Agent running on the same repos, and the fastest way to trust a
replacement was to make it behave the same:

- **Severity prefixes**: `critical`/`high` → `Important —`, `medium`/`low` →
  `Nit —`; Important first; at most N low-severity findings inline.
- **One finding per root cause**: `path + category + existing code`.
- **Skip generated paths**: lockfiles, `node_modules`, `vendor`, `*.min.js`,
  generated code.
- **Rules from the base ref**: `.opencodereview/rule.json` is read from the
  *base*, never the PR head, so a PR cannot weaken its own review.
- **Ticket rule**: one additive `**` rule is built from the PR body and the
  manual command text (`merge_system_rule: true`).
- **Fallback**: one retry with a second model if the first returns nothing.
- **Incremental**: findings already posted by the bot are skipped on re-review.
- **Sticky summary**: one comment marked `<!-- ocr-summary -->`, updated in
  place.

Both bots posted side by side for a while; the outputs were close enough to
switch, and the old one was suspended.

## Gitea is where the interesting bits are

Gitea emulates GitHub's webhook contract, which gets you 80% of the way and then
drops you into the details. The bridge detects Gitea by `X-Gitea-Event` and
handles these differences:

**Push-to-PR is a separate event.** GitHub sends `pull_request` with action
`synchronize`; Gitea sends `pull_request_sync` with action `synchronized`. If
you only subscribe to `pull_request`, new commits never trigger a re-review.

**PR-ness is not on the issue.** For comments, GitHub sets `issue.pull_request`;
Gitea sets a top-level `is_pull` (and sometimes a `pull_request` object).

**There is no `author_association`.** To keep `/review` trusted, the receiver
asks the collaborator permission API
(`/repos/{owner}/{repo}/collaborators/{login}/permission`) and accepts
owner/admin/write. Note that the owner is *not* returned by the collaborator
endpoint — the permission endpoint is the one that reports `owner`.

**Inline comments use `new_position`.** GitHub wants
`{path, line, side, start_line, start_side}`; Gitea wants
`{path, new_position}` and does not support multi-line ranges.

**There is no PR-wide review-comment collection.** `GET
/repos/{o}/{r}/pulls/{n}/comments` is a 404. Comments live under each review:
`/pulls/{n}/reviews/{id}/comments`. Incremental dedupe therefore walks the
reviews and compares the rendered body per path, because Gitea's `position` is
a diff offset, not a file line.

**Clone auth** is `http://oauth2:<token>@<host>/<owner>/<repo>.git`, and
`refs/pull/<n>/head` exists, same as GitHub.

**No Bot user type.** Comments are authored by the token's user, so the bridge
takes a `botLogin` to scope dedupe.

None of this is exotic, but none of it is in one place. That is most of why I
packaged the bridge instead of leaving it as a homelab script.

## Configuration is environment, not code

The chart takes an OpenAI-compatible URL and model:

```yaml
llm:
  url: http://vllm.ai.svc.cluster.local/v1
  model: Qwen3.8-27B
  fallbackModel: GLM-5.3-Flash
  extraBody: '{"thinking":{"type":"disabled"}}'
```

One trap: when the endpoint is a gateway (LiteLLM, MLflow AI Gateway), use the
**bare** endpoint name. LiteLLM clients strip an `openai/` prefix; sending
`openai/Qwen3.8-27B` directly to the gateway yields
`GatewayEndpoint not found`.

Secrets are never rendered by the chart. You create `ocr-app` (App ID, webhook
secret, PEM), `ocr-gitea` (token, webhook secret) and `ocr-llm` (gateway token),
and reference them by name.

## Metrics

The Job reports its result back to `/report`, so the counters describe completed
reviews rather than just deliveries:

```
ocr_webhooks_total{provider,event,action}
ocr_jobs_created_total
ocr_reviews_total{repo,status}
ocr_review_tokens_total{repo}
ocr_review_findings_total{repo}
ocr_review_duration_seconds{repo}
```

That makes it easy to see, per repo, what the reviewer costs and how often it
fails over.

## What I would improve next

- A per-repo enable list, so you do not have to manage webhooks one by one.
- GitHub Checks API support (currently findings are comments only).
- Multi-line inline comments on Gitea, if the API grows them.
- A first-class Helm chart for Gitea itself is out of scope, but the in-cluster
  API URL assumption is worth documenting better.

## Try it

```bash
helm install ocr-bridge deploy/helm/ocr-bridge -n ocr \
  --set llm.url=http://vllm.ai.svc.cluster.local/v1 \
  --set llm.model=Qwen3.8-27B
```

- Repo: <https://github.com/hybridindie/ocr-bridge>
- Upstream: <https://github.com/alibaba/open-code-review>
- Setup guides: [GitHub App](../github-app.md) · [Gitea](../gitea.md)

If you run Gitea with a self-hosted model, the Gitea section is the part worth
reading twice.
