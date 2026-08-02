# Secret Manager audit and consolidation plan

Project `odorik-tx-260720-c58d`, audited 2026-08-02.

Secret Manager bills roughly **$0.06 per active secret version per month**, where
"active" means anything not `DESTROYED` — disabled versions still cost. Six
versions are free per billing account. Cost therefore tracks the *number of
secrets*, not how often they are read, so consolidation is the lever.

State after the 2026-08-02 prune: **15 secrets, 15 versions** (down from 24
versions). The plan below takes that to **12**.

## Consumer map

Derived from what is actually mounted, across both regions and across Cloud Run
**services and jobs**, including secret *volumes* as well as env vars. A
services-only scan misses the coding pipeline entirely: it runs as on-demand jobs
in `europe-west1` that mount their credentials as files.

| Secret | Consumers | Kind |
|---|---|---|
| `CONNECTOR_CREDENTIAL_KEY` | 7 — api, googleoauthcallback, odorik-ingest, recover{calendar,drive}sourcesyncs, sync{calendar,drive}sources | env |
| `GOOGLE_CONNECTOR_CLIENT_ID` | 6 — api, googleoauthcallback, recover{calendar,drive}sourcesyncs, sync{calendar,drive}sources | env |
| `GOOGLE_CONNECTOR_CLIENT_SECRET` | 6 — same six as above | env |
| `GITHUB_APP_PRIVATE_KEY` | 5 — api, processgithubwebhook, recovergithubsourcesyncs, syncgithubsources, **erik-coding-dispatcher** | env + volume |
| `GEMINI_API_KEY` | 3 — api, recoverknowledgeindexdeliveries, syncknowledgeindex | env |
| `QDRANT_API_KEY` | 3 — same three as above | env |
| `QDRANT_URL` | 3 — same three as above | env |
| `RESEND_API_KEY` | 2 — api, sendpartnerform | env |
| `GITHUB_WEBHOOK_SECRET` | 1 — githubwebhook | env |
| `DEEPGRAM_API_KEY` | 1 — odorik-processor | env |
| `gemini-api-key` | 1 — odorik-processor | env |
| `dashboard-token` | 1 — odorik-api | env |
| `odorik-upload-user` | 1 — odorik-ingest | env |
| `odorik-upload-password` | 1 — odorik-ingest | env |
| `grok-subscription-auth` | 1 — **erik-coding-runner** (on-demand job, europe-west1) | volume |

## A. Move to a plain environment variable

### `GOOGLE_CONNECTOR_CLIENT_ID` → env var

Verified to be the standard `<digits>-<hash>.apps.googleusercontent.com` form.
That value is transmitted to **every user's browser** in the OAuth consent URL —
it is public by construction, and Google documents it as such. Storing it in
Secret Manager protects nothing. `GOOGLE_CONNECTOR_CLIENT_SECRET` stays a secret.

**Saves 1 version.**

### `QDRANT_URL` — keep it a secret after all

An earlier draft of this audit listed this as "just a URL, not a credential."
That was too glib. The stored value is
`https://<uuid>.<region>.<cloud>.cloud.qdrant.io` — a Qdrant Cloud managed
cluster whose 36-character UUID subdomain is unguessable and published nowhere.

It is genuinely *not a credential*: `QDRANT_API_KEY` is what grants access, and
knowing the hostname alone gets an attacker nothing directly. But "not a
credential" is not the same as "safe to broadcast." Demoting it to a plain env
var writes it into Cloud Run service specs readable by any principal with
`run.viewer`, into deploy logs, and into CI output — turning a targeted attack on
that specific cluster from "needs discovery" into "needs no work at all."

That is a real reduction in defence-in-depth to save $0.06/month. Not worth it.
The rule that separates the two cases: **public-by-construction** values (an
OAuth client ID) can be env vars; **non-public infrastructure identity** should
not be, even when it is not itself a credential.

## B. Duplicate holding the same credential

### `gemini-api-key` (legacy) vs `GEMINI_API_KEY`

Two secrets holding the same Gemini key, split only by naming convention: the
lowercase one predates the Firebase Functions migration and is read solely by the
legacy `odorik-processor` service; the uppercase one serves the three Functions
consumers.

Point `odorik-processor` at `GEMINI_API_KEY` (`infra/deploy.sh:97`), grant
`odorik-processor@` the `secretAccessor` role on it, then delete the lowercase
secret.

**Saves 1 version.**

## C. Bundle — same consumer *and* same rotation lifecycle

### `odorik-upload-user` + `odorik-upload-password` → `odorik-upload-credentials`

One consumer (`odorik-ingest`), one service account, and they are two halves of a
single credential pair that is always rotated together. Store as JSON
(`{"user": "...", "password": "..."}`) and parse at startup.

This is the only bundle worth doing: bundling pays off exactly when the members
share a consumer *and* a rotation event, because rotating the bundle then costs
one new version instead of two.

**Saves 1 version.**

## D. Deliberately *not* bundled

`GEMINI_API_KEY`, `QDRANT_API_KEY` and `QDRANT_URL` have an identical consumer set
(api, recoverknowledgeindexdeliveries, syncknowledgeindex), so they look like an
obvious bundle. Don't:

- They are credentials for **different vendors** with independent rotation
  schedules. Bundling means rotating the Gemini key rewrites the Qdrant key's
  storage too, and any consumer needing one gets read access to both.
- The saving is $0.06/month per secret. That does not justify widening the blast
  radius of a leak or coupling two vendors' rotation procedures.

Same reasoning keeps `GITHUB_APP_PRIVATE_KEY` (5 consumers, spanning both
Functions and the coding dispatcher job) apart from `GITHUB_WEBHOOK_SECRET`
(1 consumer) — different consumer sets *and* different lifecycles.

`CONNECTOR_CREDENTIAL_KEY` stays alone regardless: it is the key encrypting stored
connector credentials, so rotating it is a data-migration event, not a
credential swap.

## E. Everything has a consumer

Every one of the 15 secrets is mounted by something. In particular
`grok-subscription-auth` is **not** an orphan: `erik-coding-runner` mounts it at
`/secrets/grok/auth.json` from version `latest`. That job is *on demand* — it
sits idle between coding runs, so its absence from a running-workload listing
says nothing about whether it is used. It also lives in `europe-west1`, which
`infra/deploy-coding-runner.sh:24-27` enforces, so a `europe-west3` query will
not see it.

The prune performed on 2026-08-02 was safe on this point:
`infra/collect-inuse-secret-versions.py` enumerates jobs and secret volumes in
both regions, and it correctly reported `grok-subscription-auth latest` as in
use.

## Result

| | Versions |
|---|---|
| Before the 2026-08-02 prune | 24 |
| After the prune | 15 |
| After this plan | **12** |

Across the billing account (4 projects) that moves the total from 42 → ~21, or
roughly **Kč 45/month → Kč 19/month**. The absolute numbers are small; the reason
to do it is that the growth was unbounded, not that the current bill hurts.

## Related: secret version pinning

`firebase deploy` does **not** deploy functions against `latest`. It resolves each
`defineSecret` to a concrete version number
(`firebase-tools/lib/deploy/functions/validate.js` calls
`getSecretVersion(projectId, secret, "latest")` and then sets
`s.version = sv.versionId`). A deployed function keeps reading the version that
was current at deploy time, so rotating a secret is a no-op until the next
deploy.

`GEMINI_API_KEY` was manually repointed to `latest` on api,
recoverknowledgeindexdeliveries and syncknowledgeindex on 2026-08-02. **The next
`firebase deploy --only functions` will re-pin it.** Re-run afterwards:

```
python3 infra/unpin-function-secrets.py GEMINI_API_KEY
```

The seven other secrets mounted on `api` remain pinned to version 1 by design; if
any of them should also track `latest`, add them to that command.
