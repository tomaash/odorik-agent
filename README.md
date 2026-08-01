# Agent Erik

Agent Erik is an internal operating interface for teams working from calls,
contacts, tasks, and cases. This repository is evolving from a call-to-CRM
application into that focused, accountable product.

The intended product has two primary surfaces:

1. a conversation with company agents, where people describe outcomes, ask
   questions, and create or change workflows; and
2. a decision queue, where agents present accountable proposals that a person
   can approve, reject, edit, or return with feedback.

Calls are the first working context source and call centres are an important
initial product. They are not the platform's data model. Calendar events,
documents, messages, and other company systems should enter through the same
source and capability contracts.

See:

- [Product vision](docs/PRODUCT_VISION.md)
- [Platform architecture](docs/PLATFORM_ARCHITECTURE.md)
- [Implementation slices](docs/IMPLEMENTATION_SLICES.md)
- [Factual agent, hybrid RAG, and evaluations](docs/RAG_AND_EVALS.md)
- [MVP multi-tenancy](docs/MULTI_TENANCY.md)

## The product loop

```text
company context is ingested with provenance
                   ↓
a person converses with an agent
                   ↓
the agent prepares a typed, evidence-backed proposal
                   ↓
a responsible person approves, rejects, edits, or requests changes
                   ↓
an allowlisted application action executes
                   ↓
the result and responsibility trail are retained
```

An agent may create drafts and derived analysis automatically. It may not turn
its own proposal into authoritative company state or an external side effect.
Approval is a signed business decision: it binds a person to one immutable
proposal version and its disclosed effects.

Mechanical source ingestion is not a business approval. It is recorded as an
observation attributed to its connector. Indexes, embeddings, transcripts,
agent drafts, and run logs remain derived state until a governed action is
approved.

## Current implementation

The existing vertical slice remains useful as a proving ground:

- Odorik uploads completed call recordings to a private Cloud Run endpoint.
- Audio is stored privately, transcribed with Deepgram Nova-3, and summarized
  with `gemini-3.5-flash-lite`.
- Transcripts, summaries, speaker segments, and CRM extraction runs are stored
  in a named Firestore Enterprise database.
- Enabled users sign in with Google and use a Vue 3 mobile-first application.
- tRPC is the single authenticated application API.
- A user can manage contact-linked cases in a configurable shared pipeline.
- Review and status mutations use revision checks and audit events.
- A read-only factual agent uses Gemini tool calls to search, fetch, list, and
  aggregate the available company records. Answers retain source citations and
  run/token/tool traces.
- Qdrant combines 1,536-dimensional `gemini-embedding-2` vectors with BM25.
  Dense vectors are stored once as `float16`, halving their raw storage
  relative to `float32` without maintaining a second quantized copy. A
  Firestore write trigger keeps record chunks synchronized.
- The mobile-first **Sources** screen separates provider adapters, configured
  account connections, and independently selectable resources.
- Odorik is no longer a singleton integration: its legacy account is migrated
  into an Odorik connection with selectable phone lines, while new accounts
  receive isolated encrypted credentials and callback URLs.
- Google Calendar has read-only OAuth, explicit calendar selection,
  incremental sync tokens, deletion propagation, and scheduled reconciliation.
- GitHub uses the `Agent Erik Development` GitHub App with a private key held
  in Secret Manager. Administrators connect the configured installation in
  Sources, explicitly include repositories (none are selected by default),
  and synchronize issues/comments into `ContextItem`s with downscoped read-only
  observer tokens. The App's write grants are used only by the trusted coding
  publisher after a human approves the bounded implementation action.
- Administrators connect a paid Grok subscription from Sources with xAI device
  OAuth. A dedicated 1 vCPU / 1 GiB auth job writes the opaque session directly
  to Secret Manager; the browser never receives it and no xAI API key is used.
- Calls and calendar events normalize into company-scoped `ContextItem`
  documents before the same Qdrant indexing pipeline processes them.
- All CRM, agent, connector, recording, and derived-search data is scoped to
  the authenticated member's company.
- Active team members can invite a verified Google email. A cold registration
  without an invitation remains pending.
- The MVP supports one team per user, `admin` and `member` roles, and no
  self-service team creation or team switcher.
- The signed-in application opens on **Tasks**. **Pipeline** provides one
  configurable contact-linked case board. Every card opens a dedicated case
  workspace with exact stage movement, linked task controls, case-targeted
  approvals, explicitly linked source calls, and activity history.
  **Contacts** joins calls, cases, and tasks; **Ask** stays cited and
  read-only; and **Sources** manages connectors.
- A dependency-free shared block language validates and evaluates in both
  browser and Node. Ordered task, create-case, move-case, and one-level factual
  IF/ELSE blocks can preview calls and create deterministic approval requests.
  Only each action block's named approver can execute its disclosed result.
- Approval is mandatory and attached to every action; it cannot be omitted or
  wired around. The palette exposes no speculative read, draft, or
  external-action blocks. External capabilities are added only after connector,
  authorization, execution, retry, and audit behavior exists.

This code is not being discarded. During the pivot it serves as:

- the first `odorik` adapter and its configured connections;
- a supply of real and fixture context items;
- a reference implementation for authentication, review, revision checks, and
  auditability; and
- a temporary deployed workflow while the platform kernel is introduced.

The service-request schema, status board, Odorik-specific extraction, and any
future photo intake must not become mandatory platform primitives. They can
later be represented as one workflow package built on the generic kernel.

## Live application

- Existing CRM: <https://odorik-tx-260720-c58d.web.app>
- Google Cloud project: `odorik-tx-260720-c58d`
- Region and Firestore location: `europe-west3`
- Database: named Firestore Enterprise database `odorik`
- Current model: `gemini-3.5-flash-lite`

The former token dashboard remains deployed at
<https://odorik-api-apf5skngva-ey.a.run.app> while the new platform direction
is developed.

## Access control

Google sign-in authenticates identity but does not grant company access. On
first sign-in, the API records the user without a company membership, leaving
them pending. An active team member can email a seven-day invitation. The
recipient must sign in with the exact verified Google email and accept it.

Every authenticated application procedure derives `companyId` from the
server-side active membership. The browser cannot select a company identifier.
The first team is `Explorers`; Tom is its administrator and Josef and Katarina
are members.

Source configuration is restricted to application administrators. Enabled
members can read company-visible normalized context through the authenticated
API; direct Firestore browser access remains denied. Restricted per-source
member ACLs are still required before a source can be shared with only a subset
of enabled company members.

## Repository map

- `src/`, `Dockerfile`, `infra/`: Odorik recording ingestion and transcription
- `functions/shared/`: dependency-free internal workflow schema, validator,
  condition evaluator, template renderer, and preview contract
- `functions/`: Firebase Auth context, tRPC, CRM extraction and review
- `functions/src/connectors/`: adapter registry, encrypted connection
  credentials, Odorik projection, Calendar OAuth and incremental sync, and
  GitHub App installation-token authentication plus issue projection
- `functions/src/agent/`: factual agent loop, safe company-data tools, and
  Qdrant/Firestore retrieval
- `functions/evals/`: versioned factual and retrieval evaluation cases
- `frontend/`: Vue 3, TypeScript, Pinia, PrimeVue, Tailwind, and Firebase Auth
- `docs/`: target product, platform contracts, and implementation sequence
- `coding-runner/`: isolated Cloud Run Job worker using Grok subscription OAuth
- `coding-dispatcher/`: trusted GitHub source packager and draft-PR publisher that refetches one
  normalized issue, resolves the exact selected default-branch SHA, creates an
  immutable bundle, starts only the isolated runner, then validates its result
  before pushing the approved branch and opening one draft PR
- `grok-auth-worker/`: subscription-only device login and Secret Manager rotation
- `firestore.rules`, `firestore.indexes.json`: named-database rules and indexes

## Local verification

```bash
npm install
npm test

npm --prefix functions ci
npm --prefix functions test

npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run build

npm --prefix coding-runner install
npm --prefix coding-runner test
```

Google connector OAuth in the emulator uses the deterministic frontend origin
`http://127.0.0.1:5173`. The `Agent Erik connectors` web OAuth client must
keep both exact callbacks:

```text
https://odorik-tx-260720-c58d.web.app/oauth/google/callback
http://127.0.0.1:5173/oauth/google/callback
```

Vite proxies the local callback to the Functions emulator; the callback then
returns the browser to the local `/sources` page. Google requires exact redirect
URI matches, including scheme, host, port, path, and trailing slash.

## Deployment

The current application can be deployed manually with:

```bash
functions/node_modules/.bin/firebase deploy \
  --only functions:crm,firestore:odorik,hosting \
  --project odorik-tx-260720-c58d
```

The first deployment of the Gen-2 `syncKnowledgeIndex` Firestore trigger also
needs its Eventarc delivery identity to invoke that one private Cloud Run
service. This production project grants `roles/run.invoker` on
`syncKnowledgeIndex` only to the custom `odorik-crm` service account.

Connector deployments additionally use:

- `CONNECTOR_CREDENTIAL_KEY`: a base64-encoded 32-byte AES-GCM key shared only
  by the authenticated API and recording ingest service;
- `GOOGLE_CONNECTOR_CLIENT_ID` and `GOOGLE_CONNECTOR_CLIENT_SECRET`: the
  dedicated Google Workspace web OAuth client;
- the exact hosted callback
  `https://odorik-tx-260720-c58d.web.app/oauth/google/callback`; and
- a private `syncCalendarSources` scheduled function invoked every 30 minutes.

The GitHub observe connector binds `GITHUB_APP_PRIVATE_KEY` to the authenticated
API, webhook worker, and reconciliation worker. Upload or rotate the ignored
`infra/*.pem` key with `infra/configure-github-app.sh`; the script validates the
key, refuses tracked files, and grants only the control-plane service account
access. App ID, client ID, slug, and the development installation ID are public
identifiers with environment overrides; no installation token or private key is
stored in Firestore or returned to the browser.

Signed GitHub deliveries arrive at
`https://agent-erik-app.web.app/webhooks/github`. Prepare its high-entropy
`GITHUB_WEBHOOK_SECRET` with `infra/configure-github-webhook.sh`, then copy the
value once into the GitHub App webhook settings and subscribe to Issues and
Issue comments. Installation repository changes are sent automatically by
GitHub Apps. The endpoint derives the company and connection from a
server-owned installation map, deduplicates the GitHub delivery ID, and queues
only a minimized payload. A retryable Firestore worker fetches the canonical
issue and comments with a short-lived installation token. The Sources UI shows
webhook health; manual synchronization remains available, and
`syncGitHubSources` reconciles enabled repositories every 30 minutes.
Observer tokens request only read permissions even though the App installation
grants Contents and Pull requests write. Coding publication mints a separate
short-lived token restricted to the approved repository. Label
`erik-implement` creates an approval; it does not start Grok until the named
administrator approves the exact issue snapshot, base SHA, limits, branch, and
automatic draft-PR effect.

Grok subscription connection uses `infra/bootstrap-grok-auth-worker.sh` and
`infra/deploy-grok-auth-worker.sh`. The auth job has its own service account and
can manage versions only on `grok-subscription-auth`; the coding job retains
read-only access. The callback accepts only a Google-signed identity token for
that exact worker service account and hosted audience. The official Grok Build
OAuth grant currently includes broad Grok.com and Projects read/write scopes,
so production should use a dedicated paid Grok account. Disconnecting in
Sources disables every stored secret version; it does not revoke the grant at
xAI.

Team invitation delivery additionally binds `RESEND_API_KEY` to the API
function, as does `sendPartnerForm`, which delivers the website's contact form.
Both send from `hello@agenterik.cz`, a domain verified in Resend, so they can
reach arbitrary recipients. Both also run as the `odorik-crm` service account,
which holds `secretAccessor` on the secret — a function binding the secret
under any other identity makes the deploy try to patch the secret's IAM policy,
which CI is not permitted to do.

The Google OAuth application is currently in testing mode. Approved testers
must be added in Google Auth Platform; test-mode refresh tokens expire after
seven days. OAuth verification is required before publishing Calendar access
to arbitrary company users.

Pushes to `main` also deploy through GitHub Actions using Workload Identity
Federation scoped to this repository. Existing Odorik destinations, production
secrets, and retention policies must not be changed as an incidental part of
the platform migration.

## Workflow controls

The internal workflow engine is on by default and evaluates enabled schema-v4
approval-gated programs. Immutable schema-v2 and schema-v3 versions normalize
to equivalent action blocks whose existing assignee becomes the mandatory
approver. The engine can be stopped independently:

```text
WORKFLOW_ENGINE_ENABLED=false
```

Schema-v1 experiments are preserved as disabled legacy records. The exact
untouched demo plus supported schema-v2 and schema-v3 drafts upgrade to the
approval-gated language. The legacy call-to-CRM mutation path is retired.

The GCP project id, named Firestore database, legacy deployed function names,
and `odorik-crm@...` service account are historical infrastructure identifiers.
They deliberately remain unchanged. `odorik` continues to name the telephony
provider and its adapter; it no longer names the Agent Erik product.
