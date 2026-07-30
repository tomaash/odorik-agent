# Implementation slices

## Roadmap rule

Each slice must prove one complete operating loop and leave a usable outcome.
The streamlined redesign starts with objects the application can honestly own:
internal/contact/case tasks, contact-linked cases, and a small approval-gated
block language. Speculative workflow primitives and chat authoring remain
deferred. See `REDESIGN_PLAN.md`, `CASES_AND_TASKS.md`, and
`INTERNAL_WORKFLOW.md`.

Connector work now follows `CONNECTOR_EPIC.md`. The connector slices below
record the historical platform sequence; use the dedicated epic for current
implementation order, acceptance criteria, and provider decision gates.

The existing call-to-CRM application remains deployed as a source of real
company data and a working vertical workflow. Photo collection and
CRM-specific customer intake are not platform priorities.

## Slice 1: factual company agent — implemented

### Outcome

An enabled user can ask a natural-language question about the data currently
available in Firestore. Gemini chooses and composes read-only tools, then
answers with inspectable source citations. The application retains the tool
trace, model usage, prompt version, latency, and result.

```text
question
→ model chooses an allowlisted read tool
→ hybrid search / exact lookup / list / aggregate
→ optional additional tool calls
→ structured answer with citations and uncertainty
→ persisted shared thread and run trace
```

### Implemented scope

- One shared company thread in the new mobile-first **Agent** screen.
- Safe projections of calls, contacts, cases, tasks, normalized context items,
  and audit events.
- Four tools:
  - hybrid search;
  - exact record lookup;
  - filtered record listing; and
  - exact count/group aggregation.
- Bounded Gemini 3.5 Flash-Lite tool loop.
- Forced tool use on the first turn.
- Structured final answers with source-ID validation.
- Prompt-injection boundary: retrieved data is evidence, never instructions.
- Qdrant hybrid RAG with a stable temporary-unavailable response when the
  index cannot be reached.
- `gemini-embedding-2` dense retrieval at 1,536 dimensions.
- A single Qdrant `float16` dense representation without a second quantized
  copy or rescoring path.
- Retry-enabled per-record Qdrant synchronization after Firestore writes.
- Qdrant indexing endpoint restricted to application administrators.
- Deterministic retrieval/unit evaluations plus optional live Gemini cases.
- Existing Intake, Requests, and Contacts remain available.

### Known limits

- The free Qdrant deployment is a single node without backup support.
- Firestore-to-Qdrant synchronization is eventually consistent and does not
  yet expose a dead-letter queue or freshness service-level metric.
- Full reconciliation still deletes and rebuilds the target collection rather
  than building a shadow collection and switching an alias.
- Firestore projections and Qdrant operations are company scoped. Per-member
  source ACLs remain future work.
- Conversation history is shared but there is no thread management yet.
- The evaluation set is intentionally small and synthetic; it establishes the
  harness, not production quality.
- The agent cannot write, approve, send, or change company data.

### Exit criteria

- Unit tests prove tool execution, RRF behavior, citation validation, and
  unknown-citation removal.
- Offline retrieval evaluation reports hit@5 and MRR and fails below its
  threshold.
- Live evaluation covers an exact fact, a call fact, a multi-hop audit reason,
  an aggregate, and an unanswerable question.
- The Agent interface works at narrow mobile and desktop widths.
- Production search fails closed without Qdrant and never scans Firestore as
  a lexical fallback.

## Slice 2: durable context index and ingestion contract — implemented kernel

The index now accepts company-scoped normalized `ContextItem` records.
Existing calls were backfilled into this contract and the generic
Firestore-to-Qdrant path was verified. Provisioning, secret binding, verified
backfill, and per-record synchronization are implemented. Remaining work:

- add indexing leases, retries, dead-letter state, replay, and health metrics;
- measure and alert on source-to-index freshness;
- build a shadow collection and switch an alias for zero-downtime migrations;
- separate raw source records from derived chunks and embedding versions;
- add restricted per-member source permissions before sharing sensitive
  sources inside a company;
- add corpus-size, freshness, and missing-index evaluations; and
- expand the labeled query set from real usage.

Exit criterion: every eligible source change is searchable within a measured
freshness target, and the index can be completely rebuilt and reconciled from
Firestore without data loss or duplicates.

## Slice 3: adapter control plane and second source connector — implemented

The Sources control plane distinguishes adapters, configured connections, and
selectable resources. Odorik was migrated onto the contract and read-only
Google Calendar is the second adapter.

- encrypted per-connection credentials and provider-specific grants;
- multiple independently configured accounts for each adapter;
- reversible disconnect plus permanent connection deletion, provider
  revocation, context cleanup, and audit;
- explicit phone-line and calendar selection;
- Calendar OAuth callback and offline refresh token;
- idempotent incremental sync plus scheduled reconciliation;
- normalized `ContextItem` provenance for calls and events;
- source-level access checks before retrieval or prompting;
- chunking appropriate to that source;
- hybrid retrieval across calls and the second source;
- citations back to the original object; and
- deletion and revocation propagation.

Operational caveat: Google OAuth remains in testing mode until verification;
test-mode refresh tokens expire after seven days.

Exit criterion: after the first interactive calendar grant and selection, the
same agent can answer a question requiring both a call and calendar event
without a source-specific model tool.

## Slice 3b: Drive folder connector — implemented initial version

The application now reuses the connection/resource/context kernel for
explicitly selected Google Drive folders using `drive.readonly`. The initial
implementation imports direct children, extracts Google Docs and text-like
files, and retains metadata for other files. Scheduled reconciliation,
recursive folder semantics, stale-file deletion, PDF extraction, and
permission-aware audiences remain part of `CONNECTOR_EPIC.md`.

## Slice 4: generic proposal and human-decision cards

Once factual navigation is useful, add the second half of the product:

- an agent can prepare a typed proposal but still cannot execute it;
- the shared decision card supports Approve, Reject, Request changes, and
  Edit-and-approve;
- feedback creates a new immutable proposal version;
- approval binds actor, proposal version, digest, timestamp, and disclosed
  effects;
- stale cards cannot approve superseded versions; and
- mobile cards expose evidence, assumptions, unknowns, and planned effects.

Use only one safe internal effect, such as creating a generic work item. Do not
add arbitrary external actions in this slice.

Exit criterion: an agent proposal can iterate through human feedback and one
approved version creates exactly one attributable internal work item.

## Slice 5: call-centre agent packages

Build valuable call-centre behaviors on the factual and approval kernels:

- quality/compliance review proposals;
- disposition and routing;
- follow-up task proposals;
- escalation suggestions;
- coaching feedback; and
- evaluation dashboards by behavior and source.

These are configured agent tasks and proposal types, not mandatory CRM stages.
At least two packages should share the same retrieval, proposal, decision, and
evaluation contracts before introducing a more general workflow abstraction.

## Slice 6: first approved external action

Current execution is specified by G2–G3 in `CONNECTOR_EPIC.md`: propose and
then approval-gate creation of a Gmail draft. Sending email remains deferred.

Add one connector write capability with a real business result—for example,
creating a calendar hold or sending a follow-up through a chosen call-centre
channel.

- separate read and write grants;
- disclose the exact external effect on the proposal card;
- record approval before execution;
- implement provider-aware idempotency and reconciliation;
- surface `outcome_unknown` honestly; and
- provide an operator recovery path.

Exit criterion: a person can approve one external action and later prove what
was authorized and what the provider actually did.

## Small executable language before a universal builder

The current product experiment is a deliberately small block language. A
completed transcribed call runs ordered create-task, create-case, or exact
move-case blocks and one-level IF/ELSE blocks over stored call duration,
contact match, or transcript text. A task explicitly targets internal work, the
resolved contact, or exactly one active case in a selected stage. Each action
has an inseparable named approver and can only execute its typed effect after
approval. Separate action blocks are independent proposals. There are no
generic reads, AI drafts, nested expressions, free-form decisions, positional
result bindings, or external writes.

Conversational workflow authoring becomes worth testing when:

- at least two source types use one context contract;
- at least two agent packages use one proposal/decision contract;
- capability permissions and action execution are explicit;
- the factual and action eval sets catch regressions; and
- users repeatedly ask to create or modify recurring behavior themselves.

The current editor changes only typed, executable blocks. Do not generate
executable code or expand it into a universal workflow builder. Agent-authored
changesets, nested or inferred conditions, run suspension, and external actions
still require the proofs above.
