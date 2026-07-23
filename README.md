# AI-first company operations platform

This repository is evolving from a call-to-CRM application into a
workflow-agnostic operating interface for AI-first companies.

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
- Audio is stored privately and processed with `gemini-3.1-flash-lite`.
- Transcripts, summaries, speaker segments, and CRM extraction runs are stored
  in a named Firestore Enterprise database.
- Enabled users sign in with Google and use a Vue 3 mobile-first application.
- tRPC is the single authenticated application API.
- A user can review evidence-backed extraction proposals and move approved
  service requests through a simple lifecycle.
- Review and status mutations use revision checks and audit events.
- A read-only factual agent uses Gemini tool calls to search, fetch, list, and
  aggregate the available company records. Answers retain source citations and
  run/token/tool traces.
- Qdrant combines 1,536-dimensional `gemini-embedding-2` vectors with BM25,
  and a Firestore write trigger keeps indexed record chunks synchronized.
- The mobile-first **Sources** screen separates provider adapters, configured
  account connections, and independently selectable resources.
- Odorik is no longer a singleton integration: its legacy account is migrated
  into an Odorik connection with selectable phone lines, while new accounts
  receive isolated encrypted credentials and callback URLs.
- Google Calendar has read-only OAuth, explicit calendar selection,
  incremental sync tokens, deletion propagation, and scheduled reconciliation.
- Calls and calendar events normalize into company-scoped `ContextItem`
  documents before the same Qdrant indexing pipeline processes them.
- The new **Agent** screen is the default signed-in destination; the existing
  CRM remains available as Intake, Requests, and Contacts.

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
- Current model: `gemini-3.1-flash-lite`

The former token dashboard remains deployed at
<https://odorik-api-apf5skngva-ey.a.run.app> while the new platform direction
is developed.

## Access control

Google sign-in authenticates identity but does not grant company access. On
first sign-in, the API creates an access document with `enabled: false`. An
administrator manually enables the person in Firestore.

Source configuration is restricted to application administrators. Enabled
members can read company-visible normalized context through the authenticated
API; direct Firestore browser access remains denied. Restricted per-source
member ACLs are still required before a source can be shared with only a subset
of enabled company members.

## Repository map

- `src/`, `Dockerfile`, `infra/`: Odorik recording ingestion and transcription
- `functions/`: Firebase Auth context, tRPC, CRM extraction and review
- `functions/src/connectors/`: adapter registry, encrypted connection
  credentials, Odorik projection, Calendar OAuth and incremental sync
- `functions/src/agent/`: factual agent loop, safe company-data tools, and
  Qdrant/Firestore retrieval
- `functions/evals/`: versioned factual and retrieval evaluation cases
- `frontend/`: Vue 3, TypeScript, Pinia, PrimeVue, Tailwind, and Firebase Auth
- `docs/`: target product, platform contracts, and implementation sequence
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
```

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

The Google OAuth application is currently in testing mode. Approved testers
must be added in Google Auth Platform; test-mode refresh tokens expire after
seven days. OAuth verification is required before publishing Calendar access
to arbitrary company users.

Pushes to `main` also deploy through GitHub Actions using Workload Identity
Federation scoped to this repository. Existing Odorik destinations, production
secrets, and retention policies must not be changed as an incidental part of
the platform migration.
