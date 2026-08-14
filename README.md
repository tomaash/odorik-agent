# Agent Erik

Internal operating interface for company work: sources → agent conversation →
human approval → allowlisted actions.

**Live app (staging-like prod):** https://app.agenterik.cz · https://agent-erik-app.web.app  
**GCP:** `odorik-tx-260720-c58d` · `europe-west3` · Firestore DB `odorik`

---

## Run locally

**Preferred:** local UI against the live (staging-like) backend. No local secrets,
no Java, no emulators.

UI: **http://127.0.0.1:5173**

### Prerequisites

- **Node.js 22+**
- A Google account that is already a team member (or a live invitation)

### Install

```bash
npm install
npm --prefix functions install
npm --prefix frontend install
```

### Start (local UI → prod backend)

```bash
npm run dev          # alias: npm run dev:prod
```

1. Open http://127.0.0.1:5173
2. Sign in with Google (production Firebase Auth)
3. Work as usual — API and data are the live project

Vite proxies `/api` to `https://agent-erik-app.web.app` (override with
`VITE_API_TARGET` if needed). No `functions/.secret.local` or root `.env` is
required: secrets stay in the deployed Functions.

**Writes are real** (tasks, approvals, invites, connector changes, workflows).
Prod is still closer to shared staging than hardened multi-tenant production,
but treat it as shared live data.

Stop with `Ctrl+C`, or `npm run stop` from another shell.

---

### Optional: full emulators

Use only when you need an isolated Auth/Firestore/API stack (offline work,
destructive experiments, seedable tenancy). Requires **Java 21+**. Features that
call Gemini, Qdrant, connectors, or email also need local secrets.

```bash
npm run dev:emulator
```

1. Open http://127.0.0.1:5173 and sign in (Auth emulator).
2. With emulators still up, grant team access once:

   ```bash
   npm run seed:local
   ```

3. Refresh the app (or “check again” on `/pending`).
4. Stop with `Ctrl+C` or `npm run stop`.

Emulator data: `functions/.emulator-data` (import on start, export on exit).
Ports: Auth `9099`, Firestore `8085`, Functions `5001`, Hosting `5005`,
Emulator UI `4041`, Vite `5173`.

**Optional secrets** for full feature parity — create gitignored
`functions/.secret.local` (one `NAME=value` per line):

```text
GEMINI_API_KEY=...
QDRANT_URL=...
QDRANT_API_KEY=...
CONNECTOR_CREDENTIAL_KEY=...   # base64 of 32 random bytes
GOOGLE_CONNECTOR_CLIENT_ID=...
GOOGLE_CONNECTOR_CLIENT_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...       # verifies Slack Events and Block Kit interactions
RESEND_API_KEY=...
# GITHUB_APP_PRIVATE_KEY=...
```

With ADC logged into the project, the emulator may also pull secrets from
Secret Manager. Google connector OAuth on emulators needs
`http://127.0.0.1:5173/oauth/google/callback` registered on the connectors
OAuth client; Vite proxies it into the Functions emulator.

For Slack direct conversation and Slack-native proposal decisions, configure the
Slack app's Event Subscriptions request URL as `/webhooks/slack` and its
Interactivity request URL as `/interactions/slack` on the same public origin.
Private proposal cards support approve, reject, and request changes. Approved
effects still execute only through Erik's canonical approval kernel; the first
conversation actions are one internal task and one Gmail draft (never send).

| | Prod backend (default) | Emulators |
| --- | --- | --- |
| Command | `npm run dev` / `dev:prod` | `npm run dev:emulator` |
| Local secrets | None | Optional, for Ask/connectors/etc. |
| Auth / data | Live project | Local emulators |
| Side effects | Real shared data | Local only (+ external APIs if secreted) |

Scripts force `VITE_USE_FIREBASE_EMULATORS` so a leftover `frontend/.env.local`
cannot point the UI at the wrong backend.

---

## Stack

| Layer | Tech |
| --- | --- |
| App UI | Vue 3, TypeScript, Pinia, PrimeVue, Tailwind, Vite |
| Auth | Firebase Auth (Google sign-in) |
| API | tRPC on Firebase Functions (Gen 2, Node 22) |
| Data | Firestore Enterprise (named DB `odorik`) |
| Search | Qdrant + Gemini embeddings |
| Models | Gemini (factual agent / embeddings), Deepgram (transcription) |
| Connectors | Odorik, Google Workspace, Slack, GitHub App, Grok subscription OAuth |
| Coding loop | Cloud Run Jobs: `coding-dispatcher`, `coding-runner`, `grok-auth-worker` |
| Ingest | Cloud Run services in `src/` (Odorik upload → storage → transcript) |
| Marketing site | Nuxt 4 static site in `web/` |
| Hosting / CI | Firebase Hosting + Functions; deploy on `main` via GitHub Actions |

### Repository map

| Path | Role |
| --- | --- |
| `frontend/` | Signed-in Vue app |
| `functions/` | Auth context, tRPC API, connectors, agent, workflows |
| `functions/shared/` | Dependency-free workflow schema (browser + Node) |
| `src/`, `infra/` | Recording ingest/transcription Cloud Run stack |
| `coding-dispatcher/`, `coding-runner/`, `grok-auth-worker/` | Isolated coding jobs |
| `web/` | Public marketing site |
| `docs/` | Product, architecture, multi-tenancy, RAG/evals |

---

## Tests

```bash
npm test                              # root recording/ingest
npm --prefix functions/shared test
npm --prefix functions test
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Factual-agent evals (optional, needs Gemini):

```bash
npm --prefix functions run eval
npm --prefix functions run eval:live
```

---

## Deploy

Pushes to `main` that touch `frontend/`, `functions/`, or Firebase config deploy
via GitHub Actions. Manual CRM deploy:

```bash
functions/node_modules/.bin/firebase deploy \
  --only functions:crm,firestore:odorik,hosting:frontend,hosting:odorik-tx-260720-c58d \
  --project odorik-tx-260720-c58d
```

Recording ingest/coding jobs: `infra/`. Marketing site: `web/` +
`.github/workflows/deploy-web.yml`.

---

## Access model (short)

- Google sign-in identifies the user; it does **not** by itself grant company data.
- Active members invite verified Google emails (7-day tokens via Resend).
- Every company-scoped tRPC procedure resolves `companyId` from server-side
  membership. The browser never selects a tenant.
- Source (connector) configuration is admin-only. Direct Firestore client
  access is denied by rules.

---

## Notes

- Product/architecture docs: [`docs/`](docs/).
- Project id `odorik-tx-260720-c58d`, database id `odorik`, and
  `odorik-crm@...` are historical infra names. The product is Agent Erik;
  `odorik` is the telephony connector.
- `WORKFLOW_ENGINE_ENABLED=false` disables evaluation of enabled workflow
  programs without turning off the rest of the app.
