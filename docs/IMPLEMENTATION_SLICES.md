# Implementation slices

## Roadmap rule

Each slice must prove one complete operating loop and leave a usable outcome.
We are not committing to an agent-authored workflow language yet. First prove
that an agent can navigate heterogeneous company context, answer factual
questions with evidence, and expose its limitations. Then generalize ingestion
and add accountable actions.

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
- Safe projections of calls, interactions, contacts, service requests, tasks,
  reviews, and audit events.
- Four tools:
  - hybrid search;
  - exact record lookup;
  - filtered record listing; and
  - exact count/group aggregation.
- Bounded Gemini 3.1 Flash-Lite tool loop.
- Forced tool use on the first turn.
- Structured final answers with source-ID validation.
- Prompt-injection boundary: retrieved data is evidence, never instructions.
- Qdrant hybrid RAG when configured; Firestore BM25 fallback otherwise.
- Qdrant indexing endpoint restricted to application administrators.
- Deterministic retrieval/unit evaluations plus optional live Gemini cases.
- Existing Intake, Requests, and Contacts remain available.

### Known limits

- Qdrant credentials are not provisioned by this repository; the deployed
  function uses lexical fallback until the hosted cluster and secret binding
  are configured.
- Index refresh is currently an explicit full rebuild, not event-driven.
- Firestore projections are single-company and bounded for the spike.
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
- Production answers remain functional without Qdrant through the explicit
  lexical fallback.

## Slice 2: durable context index and ingestion contract

Turn the search spike into a reliable context layer:

- provision Qdrant Cloud and bind its URL/API key through Firebase/Secret
  Manager;
- backfill existing records and verify counts/checksums;
- emit normalized context updates when calls and CRM records change;
- incrementally upsert changed chunks and delete stale chunks;
- add indexing leases, retries, dead-letter state, replay, and health metrics;
- separate raw source records from derived chunks and embedding versions;
- implement company scoping and source permissions before a second company;
- add corpus-size, freshness, and missing-index evaluations; and
- expand the labeled query set from real usage.

Exit criterion: every eligible source change is searchable within a measured
freshness target, and the index can be completely rebuilt and reconciled from
Firestore without data loss or duplicates.

## Slice 3: second source connector

Add one non-call source based on a real question users need answered. A
read-only Google Calendar or focused document source is the likely choice.

- connector OAuth, grants, revocation, and health;
- idempotent incremental sync;
- normalized `ContextItem` provenance;
- source-level access checks before retrieval or prompting;
- chunking appropriate to that source;
- hybrid retrieval across calls and the second source;
- citations back to the original object; and
- deletion and revocation propagation.

Exit criterion: the same agent can answer a question requiring both a call and
the second source without adding a source-specific model tool.

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

## Revisit workflow definition only after these proofs

Conversational workflow authoring becomes worth testing when:

- at least two source types use one context contract;
- at least two agent packages use one proposal/decision contract;
- capability permissions and action execution are explicit;
- the factual and action eval sets catch regressions; and
- users repeatedly ask to create or modify recurring behavior themselves.

At that point, start with a small declarative specification over registered
capabilities. Do not generate executable code and do not begin with a universal
visual workflow builder.

