# Security

## Webhook authenticity

- The raw body is verified before JSON parsing, with constant-time comparison.
- GitHub: `X-Hub-Signature-256: sha256=<hex>`.
- Gitea: `X-Hub-Signature-256` or the unprefixed hex `X-Gitea-Signature`.
- An unset/empty secret is a fatal startup error for an enabled provider.
- Deliveries are answered `202` before work starts; failures happen in the Job,
  so a provider retry does not duplicate work (the Job name is deterministic).

## Credentials

| Credential | Scope | Notes |
|---|---|---|
| GitHub App private key | App-level | mints short-lived installation tokens; never sent to the Job |
| Gitea token | repository read/write | **use a dedicated token, not admin**; it can clone and comment |
| LLM token | gateway | mounted into the Job only |

- The chart **never renders secrets** from values; it references
  `existingSecret` names. `secrets.yaml` is not part of this repo.
- The receiver pod runs non-root, with a read-only root filesystem and all
  capabilities dropped.
- The Job service account has `automountServiceAccountToken: false` and no RBAC;
  review pods cannot touch the Kubernetes API.
- Gitea's API is reached in-cluster over plain HTTP; keep it on a trusted
  network or put TLS in front. `webUrl` is only used for links.

## Command authorization

- GitHub: `OWNER`/`MEMBER`/`COLLABORATOR` only (`policy.allowedAssociations`).
- Gitea: the collaborator permission endpoint must return owner/admin/write.
- Comments from bots (`type: Bot` or `[bot]` logins) are ignored.

## Untrusted input

- PR titles, bodies, diffs and comments are attacker-controlled and are fed to
  the LLM as review material. The model's output is posted as Markdown; it is
  not executed.
- The Job checks out PR code to *read* it. `ocr review` parses files; the bridge
  does not run repository scripts or tests.
- The PR-body rule is additive (`merge_system_rule: true`) and cannot remove the
  built-in rules; base-ref rules prevent a PR from weakening policy.

## Endpoint exposure

- Expose only `POST /webhook` publicly.
- Keep `/metrics` internal (PodMonitor) and `/report` internal. **`/report` is
  unauthenticated** — it only updates in-memory metrics, but do not expose it to
  the internet.
- A public webhook URL is required for GitHub/Gitea; a tunnel (e.g. Tailscale
  Funnel) is fine, but terminate TLS at the edge and keep the cluster endpoint
  private.

## Reporting

If you find a vulnerability, open a private security advisory rather than a
public issue.
