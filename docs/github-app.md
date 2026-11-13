# GitHub App setup

The receiver mints an installation token per repository — no installation ID is
stored. One App can cover many repos.

## 1. Create the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
|---|---|
| Webhook URL | `https://ocr.example.com/webhook` |
| Webhook secret | a random 32+ byte string |
| Content type | `application/json` |
| Subscribe to events | **Pull request**, **Issue comment** |
| Where can it be installed | any account/repo you choose |

**Repository permissions**

| Permission | Access | Why |
|---|---|---|
| Contents | Read | clone the base ref and `refs/pull/<n>/head` |
| Pull requests | Read and write | read PRs, post inline review comments, dedupe |
| Issues | Read and write | sticky summary comments (`/issues/<n>/comments`) |
| Metadata | Read | required for every App |

Do **not** grant Contents: write, Actions, Checks, Workflows, Administration or
Packages. The poster uses the Issues API for the sticky summary, so Issues:
write is required even though the upstream Action example omits it.

## 2. Store the credentials

```bash
kubectl -n ocr create secret generic ocr-app \
  --from-literal=app-id=<APP_ID> \
  --from-literal=webhook-secret="$GITHUB_WEBHOOK_SECRET" \
  --from-file=private-key.pem=./<app>.private-key.pem
```

Keys are fixed: `app-id`, `webhook-secret`, `private-key.pem`.

Alternatively, the receiver can read a PR-Agent-style `.secrets.toml` mounted at
`/secrets/.secrets.toml` (keys `GITHUB_APP_SECRETS_PATH` /
`GITHUB_APP_PRIVATE_KEY_PATH`). Env vars take precedence.

## 3. Install

Install the App on the repositories to review. The receiver resolves the
installation per repo, so changing the selection needs no redeploy.

## 4. Verify

- App → **Advanced → Recent Deliveries** → a `ping` should return **202**.
- An unsigned `POST /webhook` returns **401**.
- Open a PR: a Job appears within seconds, then inline comments and the
  `<!-- ocr-summary -->` comment.

## Permissions the receiver itself needs

None beyond the App. The App JWT is signed with the private key; installation
tokens are short-lived and never persisted.
