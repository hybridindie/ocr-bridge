# Gitea setup

Gitea has no App concept: one webhook per repository. The receiver detects Gitea
deliveries by the `X-Gitea-Event` header (Gitea also sends the GitHub-compatible
`X-Hub-Signature-256`, plus its own hex `X-Gitea-Signature`).

## 1. Create a token

Use a **dedicated** token, not an admin token. The token needs to read the repo,
clone it over HTTP, and create reviews/comments — Gitea's `write:repository`
scope.

```bash
kubectl -n ocr create secret generic ocr-gitea \
  --from-literal=token="$GITEA_TOKEN" \
  --from-literal=webhook-secret="$GITEA_WEBHOOK_SECRET"
```

Set `providers.gitea.apiUrl` to the **in-cluster** API base, for example
`http://gitea-http.gitea.svc.cluster.local:3000/api/v1`. The public hostname is
often not resolvable from pods; keep `webUrl` for links.

Set `providers.gitea.botLogin` to the login the token posts as. Gitea has no Bot
user type, so this scopes incremental dedupe; leave it empty to consider all
review comments.

## 2. Add a hook per repository

UI: **Repo → Settings → Webhooks → Add webhook → Gitea**, URL
`http://<release>.<ns>.svc.cluster.local:8080/webhook`, content type `json`,
secret = the `ocr-gitea` webhook secret, events **Pull request**,
**Pull request sync** and **Issue comment**.

API:

```bash
curl -X POST -H "Authorization: token $GITEA_TOKEN" \
  -H 'Content-Type: application/json' \
  http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/<owner>/<repo>/hooks \
  -d '{"type":"gitea","active":true,
       "events":["pull_request","pull_request_sync","issue_comment"],
       "config":{"url":"http://<release>.<ns>.svc.cluster.local:8080/webhook",
                 "content_type":"json","secret":"'"$GITEA_WEBHOOK_SECRET"'"}}'
```

Use **Test delivery** (or `POST .../hooks/<id>/tests`); the receiver records a
`provider="gitea", event="push"` metric and returns 202.

## Gitea differences the bridge handles

| Difference | Handling |
|---|---|
| Push-to-PR is the separate `pull_request_sync` event, action `synchronized` | treated as a PR review trigger |
| PR comments carry top-level `is_pull` (not `issue.pull_request`) | detected |
| No `author_association` | `/review` gated on `/collaborators/{login}/permission` (owner/admin/write) |
| Inline comments use `new_position` (single line) | mapped from the finding's end line |
| No `/pulls/{n}/comments` collection | incremental dedupe reads each review's comments and compares bodies per path |
| No GitHub-style `Bearer` | API calls use `Authorization: token …` |
| Clone auth | `http://oauth2:<token>@<host>/<owner>/<repo>.git` |
| `refs/pull/<n>/head` | same as GitHub |

## Verify

- `/review` comment on an open PR (as the owner or a writer) creates a fresh Job.
- A PR opened from a branch creates a Job automatically.
- Inline comments appear as the token's user.
