# Grok subscription auth worker

This package implements the short-lived device-OAuth worker behind **Sources →
Grok subscription**. It uses the pinned Grok Build CLI and a paid Grok
subscription session. It never accepts an xAI API key.

## Boundary

The worker runs as the dedicated `erik-grok-auth` Cloud Run Job service
account. That identity can add, list, and disable versions of the single
`grok-subscription-auth` secret. It has no Firestore, repository, GitHub, coding
artifact, or coding-runner execution permission.

For a connect operation it:

1. removes any inherited `XAI_API_KEY` and starts `grok login --device-auth`;
2. extracts only the exact `https://accounts.x.ai/oauth2/device` URL and its
   short-lived code;
3. calls the public Firebase callback with a Google-signed service identity;
4. validates that Grok produced subscription-OAuth state, never an API-key
   shaped document;
5. writes the opaque document directly to Secret Manager and disables older
   enabled versions; and
6. sends only account/status metadata back to the callback.

Secret Manager returns canonical resource names with the numeric GCP project
number even when requests use the textual project ID. The worker validates the
secret and numeric version components, then reconstructs the resource under its
configured project/secret before cleanup and callback processing.

Raw CLI output and `auth.json` are never logged or sent to Firebase. The
browser receives only the device URL/code and safe connection metadata.

A disconnect operation disables every enabled version without reading any
payload. This immediately prevents new coding-runner mounts. It does not revoke
the OAuth grant at xAI; provider-side revocation remains an operator action.

## Resource size

The deployed job uses 1 vCPU and 1 GiB RAM with a 20-minute timeout, one task,
and zero retries. A production probe confirmed that 512 MiB is below the Grok
CLI startup floor and causes an out-of-memory exit before device authorization.
The coding runner remains a separate 2 vCPU / 4 GiB job because it also checks
out repositories and runs the agent sandbox.

## OAuth scope warning

The official Grok Build consent currently requests broad Grok.com and Grok
Projects read/write scopes in addition to identity and offline access. Erik
cannot narrow scopes controlled by xAI's OAuth client. Use a dedicated paid
Grok account rather than a personal account containing unrelated chats or
projects.

## Verification and deployment

```bash
npm install
npm test

infra/bootstrap-grok-auth-worker.sh
infra/deploy-grok-auth-worker.sh
```

`infra/configure-grok-subscription.sh` remains a local break-glass path. Normal
reconnection belongs in the authenticated Sources UI.
