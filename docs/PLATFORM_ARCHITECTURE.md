# Platform architecture

## Architecture objective

The platform kernel must support this invariant:

```text
agents may observe and propose
people decide
application capabilities execute
the audit trail explains all three
```

The existing Vue, TypeScript, tRPC, Firebase Auth, Firestore Enterprise, Cloud
Run/Functions, Cloud Storage, and Gemini stack remains appropriate. The pivot
changes the domain contracts, not the entire technology stack.

The first platform kernel is deliberately narrower than a workflow engine: a
read-only factual agent with allowlisted data tools, hybrid retrieval, source
citations, and measurable evaluations. Workflow-definition records below are
an architectural option, not current implementation scope.

## Trust zones

### Source zone

Connector payloads and artifacts are observations from an external system.
They are stored idempotently, retain provenance, and may be processed
automatically. They are not automatically accepted as normalized business
truth.

### Agent workspace

Messages, retrieval results, model runs, drafts, and proposals live here. Model
output is untrusted until it passes a typed schema, application validation, and
where necessary evidence validation. The agent workspace cannot directly call
business mutation handlers.

### Decision boundary

A human decision binds an authenticated company member to an immutable
proposal version. Revision checks prevent a stale card from approving newer or
different content.

### Action boundary

Typed action handlers are ordinary application code. Each handler declares its
input schema, required role, preconditions, idempotency strategy, reversibility,
and audit representation. External APIs are called only here.

## Company tenancy

New platform data should be company scoped from the beginning, even while the
deployment serves one company. A suitable Firestore layout is:

```text
companies/{companyId}
  memberships/{uid}
  connections/{connectionId}
    resources/{resourceId}
  contextItems/{contextItemId}
  agentThreads/{memberThreadDocumentId}
    messages/{messageId}
    sessions/{sessionId}
  externalConversationBindings/{bindingId}
  conversationEvents/{eventId}
  workflows/{workflowId}
    versions/{versionId}
  workflowRuns/{runId}
  workItems/{workItemId}
  proposals/{proposalId}
    versions/{versionId}
  decisions/{decisionId}
  actionExecutions/{executionId}
  auditEvents/{eventId}
```

All tRPC procedures derive `companyId` from an authorized membership; clients
do not gain access by merely supplying a company identifier. Direct browser
Firestore access remains denied.

The CRM, agent, connector, recording, and normalized context records now live
below `companies/{companyId}`. Legacy top-level records remain temporarily as
rollback data and are not read by the application.

## Core records

### Adapter, Connection, and Resource

These are separate concepts:

- an **adapter** is application code for one provider such as `odorik` or
  `google_calendar`;
- a **connection** is one company-authorized provider account with its own
  authentication, lifecycle, health, and sync state; and
- a **resource** is an explicitly selectable unit within a connection, such as
  a phone line or calendar.

One company may therefore have several accounts for every adapter—multiple
Odorik accounts, multiple Google identities, and later multiple Drive, Gmail,
or GitHub accounts. Each account contains its own selectable resources.
Provider credentials belong to a connection, never to a call, event, or phone
number. The browser receives only public status and credential mode; the
encrypted credential envelope stays server-side.

Disconnecting a connection is reversible and pauses new ingestion. Permanent
deletion first stops synchronization, then invokes the adapter's revocation
hook where available, deletes the credential envelope and resource documents,
removes normalized context so Qdrant deletion triggers run, and retains only a
non-secret audit event. Provider-owned originals are outside this lifecycle.

### ContextItem

A normalized envelope around a source observation:

```ts
type ContextItem = {
  id: string
  companyId: string
  kind: string                 // call, calendar.event, document, message, ...
  source: {
    adapterId: string
    connectionId: string
    resourceId: string
    externalId: string
    version?: string
  }
  occurredAt?: string
  observedAt: string
  title?: string
  text?: string
  artifactRefs: string[]
  participantRefs: string[]
  access: { visibility: 'company' | 'restricted'; memberIds?: string[] }
  provenance: { rawRef?: string; checksum: string; ingestionVersion: string }
}
```

Large binary data remains in Cloud Storage. Firestore contains metadata,
searchable text, references, and provenance. Derived context—such as a call
transcript—references its parent item rather than replacing it.

### Thread and Message

A thread is a private durable conversational workspace owned by one company
member. Its physical ID is derived from authenticated member ID plus logical
thread ID; thread lists also filter by `ownerUid`. This prevents two members
using the same logical name such as `general` from sharing history. Members can
create and switch among their own chats. Messages distinguish `human`, `agent`,
and `system` authors and can reference context items, workflow runs, proposals,
and decisions. A message can request agent work but cannot masquerade as an
approval.

A logical thread is independent of a delivery surface. An
`ExternalConversationBinding` maps one authenticated provider conversation—for
example a Slack workspace, DM channel, and linked Slack user, or a Teams tenant,
personal conversation, and Entra object ID—to one member-owned Erik thread.
Binding is explicit and revocable; matching an email address or display name is
not identity proof.

Inbound and outbound provider events first enter a durable conversation
journal. Its delivery envelope is immutable for ordering and idempotency, while
message text, rendered cards, provider identity fields, and derived content are
redacted after the declared retention period or an earlier member/lifecycle
request. The retained envelope contains only the hashed document identity,
ordering/delivery outcome, and references required for replay safety and
mandatory approval/execution audit. The provider event identity is hashed into
the document key and remains the idempotency boundary. Events wait for a
small explicit reorder window, then provider time plus a stable event-ID
tie-breaker defines processing order; Firestore trigger arrival order does not.
An event that arrives older than an already advanced cursor is retained and
marked late, then processed against current state rather than rewriting already
delivered history.

### Conversation runtime and memory

Each thread owns a sequence of working sessions. A session retains its message
range, active or closed state, compact current subject, discussed entity
references, unresolved questions, and summary version. A session closes after
an explicit new-topic request or a product-defined inactivity threshold; it is
not kept alive by an open model process.

The first continuity contract deliberately implements only the active session.
Six hours of inactivity closes it; recent messages use a 6,000-token estimate;
and compact state versions cite exact first/last message IDs. A memory-generation
fence first prevents stale content from entering a prompt; the retention service
then redacts the older provider payloads, thread messages, derived session state,
and agent-run content without erasing approval or execution audit.
Older-session semantic retrieval is a separate 9B capability and must not be
approximated by appending every historical summary.

Context assembly has separate inputs:

```text
current inbound event
+ recent ordered raw turns under a token budget
+ compact state for the active session
+ relevant provenance-bound summaries from older sessions
+ freshly authorized company evidence when the turn requires it
```

Conversation summaries are derived workspace records, not `ContextItem`
evidence. A summary records the exact first and last message IDs it compresses,
summarizer and prompt versions, source-access envelope, and creation time. It may
help resolve “that customer” or recall an unresolved task, but it cannot satisfy
a citation or authorize an effect. It also retains the source dependencies of
the messages it summarizes so revoked evidence can exclude or rebuild the
derived memory. Explicit member preferences are stored separately, with scope,
authorship, timestamp, and deletion controls; assistant claims are never
promoted as preferences or company facts.

Every conversation has one durable processing cursor and at most one active
lease with a fencing token. A worker claims the oldest eligible inbound event,
records the user message before generation, assembles context from a fixed
revision, persists the run and response, advances the cursor, and then delivers
the response. A stale worker cannot commit over a newer lease. Delivery retries
reuse the persisted response instead of running the model again. The worker
drains all eligible queued events before releasing the lease; a scheduled
recovery path reclaims expired leases and events whose reorder window elapsed
without another trigger.

The turn router chooses an application-owned response policy before the factual
loop:

- `social`: no company-data tools;
- `capability`: no evidence lookup unless the answer depends on live account
  configuration;
- `company_fact`: one or more fresh read tools and citations;
- `contextual_followup`: resolve references from conversation state, then use
  fresh tools for factual claims; and
- `action_request`: prepare or explain a typed proposal, never execute directly.

Routing may use deterministic rules plus a structured classifier, but its
result, confidence, prompt version, and chosen tool policy are persisted and
evaluated. Low-confidence consequential routing fails toward clarification or
read-only behavior.

### Workflow and WorkflowVersion

> Deferred: retain this shape as a hypothesis until the factual agent and
> proposal/decision primitives are proven.

`Workflow` is the stable identity and lifecycle. Each immutable version holds a
validated declarative specification:

```ts
type WorkflowSpec = {
  name: string
  objective: string
  trigger: TriggerSpec
  context: ContextRequirement[]
  steps: Array<AgentStep | DecisionStep | ActionStep>
  exceptionPolicy: ExceptionPolicy
  completion: CompletionSpec
}
```

The first implementation supports only a small registry of trigger, step, and
action kinds. Unknown kinds are rejected; model-generated executable code is
not accepted.

Publishing a workflow version is itself a proposed `publish_workflow` action
requiring a human decision.

### WorkflowRun and WorkItem

A run is one execution of a published workflow version against specific
context. It records inputs, step state, retries, outputs, model usage, and
errors. Long waits are represented by durable Firestore state, not an open
model session.

A work item is something visible in a person's queue. It may request a
decision, report an exception, or represent a company task. The queue is not
hard-coded to CRM statuses.

### Proposal and ProposalVersion

A proposal is a stable review subject. Each version is immutable and includes:

```ts
type ProposalVersion = {
  proposalId: string
  version: number
  kind: string
  summary: string
  payload: unknown             // validated by the registered kind schema
  evidenceRefs: EvidenceRef[]
  assumptions: string[]
  plannedEffects: PlannedEffect[]
  risk: 'low' | 'medium' | 'high'
  reversible: boolean
  createdBy: { kind: 'agent'; runId: string }
  digest: string
  createdAt: string
}
```

Proposal kind renderers provide richer cards for known payloads. The envelope,
decision controls, history, and evidence treatment stay common.

### Decision

```ts
type Decision = {
  proposalId: string
  proposalVersion: number
  proposalDigest: string
  actorUid: string
  outcome: 'approved' | 'rejected' | 'changes_requested'
  feedback?: string
  decidedAt: string
}
```

“Edit and approve” first creates a new proposal version attributed to the
editor and then records approval of that exact version. An old card cannot
approve a superseded version.

### ActionExecution

An approved proposal can create one or more executions. Each uses a stable
idempotency key derived from company, proposal version, and planned effect.

```text
pending → executing → succeeded
                    ↘ failed_safe_to_retry
                    ↘ outcome_unknown
```

The proposal, decision, execution, external result, and audit events remain
separate records. This makes responsibility and operational status visible
without pretending that approval and execution are the same event.

## Action capability registry

The workflow language emits exact typed proposals. The approval layer resolves
their shorter execution kinds through a static, application-owned action
registry. Source connector capabilities remain a separate contract because
observing context and executing effects have different lifecycle and safety
requirements.

An action descriptor contains:

```ts
type ActionDescriptor = {
  kind: string
  capabilityId: string
  contractVersion: number
  category: 'company.write' | 'external.write'
  inputSchema: unknown
  resultSchema: unknown
  authorization: {
    requiresApproval: true
    providerCapabilityId?: string
  }
  reversibility: 'reversible' | 'compensatable' | 'irreversible'
  idempotency: 'deterministic_internal' | 'provider_aware'
  reconciliation: 'deterministic_lookup' | 'required_before_retry'
}
```

The registry also owns preparation, transactional preconditions, scope,
execution, typed result validation, result references, and failure
classification. The approval kernel remains generic: named actor, effect
digest, execution lease, attempt identity, decision state, audit, and outcome
state.

The production registry contains `task.create`, `case.create`, `case.move`,
`coding.issue.implement`, and `mail.draft.create`. It rejects duplicate or
approval-optional descriptors and is immutable after startup. It is not a
runtime plugin system or a generic action API. Future external effects must
declare the provider capability and reconciliation contract they require before
they can be registered.

## Agent execution

Agent prompts receive:

- the workflow version;
- the current run step;
- retrieved context items the member and workflow may read;
- typed output schemas; and
- the capability descriptions relevant to that step.

Agent output is parsed and validated in TypeScript. Evidence references must
resolve to context the run actually received. The model never receives
credentials and never writes Firestore or invokes a connector directly.

Gemini remains replaceable behind an `AgentModel` interface. Model choice,
prompt version, token usage, latency, and validation results are retained on
every agent run.

### Implemented factual-agent loop

The current read-only loop exposes four application-owned tools:

- `search_company_data`: Qdrant hybrid retrieval over safe record views;
- `get_company_record`: complete safe fields for one known record;
- `list_company_records`: exact filtered relationships and recent records; and
- `aggregate_company_records`: exact totals and supported groupings.

The currently deployed factual endpoint forces the first model turn to select a
tool. Subsequent turns may compose more tools or produce a structured final
response. Tool calls are bounded, arguments are validated with Zod, record
kinds and fields are allowlisted, and unknown citation IDs are removed.
Retrieval content is explicitly treated as untrusted evidence rather than
instructions.

Forced first-tool use remains correct only after a turn has been classified as
requiring company evidence. It is not the entry policy for general
conversation: production Slack dogfood showed that forcing the social message
“hello” through the factual loop repeated the previous company-summary search.
The target runtime routes first, then requires tools for factual modes and
prohibits them for ordinary social turns.

Qdrant provides the preferred `gemini-embedding-2` dense plus BM25 candidate
rankings and fuses them with RRF. Its 1,536-dimensional dense vectors use
one `float16` representation. There is no separate quantized copy or dense
rescoring path. Firestore remains authoritative; a retry-enabled write trigger
incrementally replaces all derived chunks for each changed or deleted
allowlisted record. If Qdrant is not configured or is unavailable, search
fails closed with a stable temporary-unavailable result instead of scanning
Firestore. Exact record lookup, filtered lists, and aggregate queries remain
available because those tools issue bounded, explicit Firestore reads.

## Connector contract

Connectors implement independent source and action interfaces:

```ts
interface SourceConnector {
  discover(connection: Connection): Promise<SelectableResource[]>
  sync(cursor?: string): Promise<SourcePage>
  fetch(externalId: string): Promise<SourceObject>
  normalize(source: SourceObject): Promise<ContextItemDraft[]>
}

interface ActionConnector<TInput, TResult> {
  execute(input: TInput, idempotencyKey: string): Promise<TResult>
  reconcile?(execution: ActionExecution): Promise<ReconciliationResult>
}
```

Webhook connectors may push observations instead of being polled. All paths
converge on the same idempotent normalization contract. OAuth grants and
secrets stay in Secret Manager or an appropriate encrypted credential store;
they never enter prompts or browser responses.

### Implemented source data plane

```text
provider payload
→ adapter validates the configured connection
→ raw or typed source record remains authoritative
→ normalized companies/{companyId}/contextItems record
→ Firestore write trigger
→ Gemini Embedding 2 and BM25 payload
→ tenant-filtered Qdrant company_context_v5
→ source-agnostic agent tools and citations
```

The Odorik compatibility endpoint maps to Explorers and `odorik-primary`; new
accounts use `/webhooks/odorik/{companyId}/{connectionId}/recordings`.
Non-legacy stored call IDs hash connection ID plus provider call ID, preventing
cross-account collisions.
Phone-line resources are discovered from upload metadata and can be excluded
from active context independently.

Calendar OAuth requests only calendar-list read and event read scopes. Each
selected calendar owns a sync token. An expired token causes a bounded full
sync from one year ago; otherwise the adapter requests changes only. Cancelled
events and deselected calendars remove their context and Qdrant chunks. A
private scheduled function reconciles every 30 minutes.

## UI architecture

The platform shell has three primary destinations:

- **Work:** agent conversations and the shared work/decision queue;
- **Workflows:** draft, published, paused, and historical workflow versions;
- **Sources:** connectors, permissions, sync health, and source coverage.

On mobile, a proposal opens as one focused card with persistent explicit
actions. On larger screens, conversation, card, and evidence/history can appear
side by side. The same APIs and records power both layouts.

The current product surfaces are Tasks, a configurable case Pipeline, Contacts,
Ask, Workflows, Sources, and Team. The legacy call-to-CRM mutation workflow is
not a supported fallback.

## Security and correctness invariants

1. Every read and write is company authorized on the server.
2. Context retrieval enforces source access before prompting a model.
3. No proposal payload is executable without validation against a registered
   kind and capability.
4. Approval references an immutable digest and cannot approve a superseded
   version.
5. A transaction records the decision and pending execution before any
   external effect.
6. External actions are idempotent where the provider supports it; uncertainty
   is represented honestly where it does not.
7. Agent, human, connector, and system authorship are never conflated.
8. Raw sources and evidence retain provenance and retention rules.
9. Secrets and unrestricted source content never reach the browser.
10. Direct browser Firestore access remains denied.
11. External conversation events are idempotent, durably ordered, and processed
    by one fenced worker per logical conversation.
12. The inbound human turn is persisted before model generation; delivery retry
    never regenerates a different answer for the same provider event.
13. Conversation summaries and previous assistant answers are never accepted as
    company evidence or action authority.
14. Memory retrieval rechecks current member and source access, and deletion or
    revocation propagates to future context assembly.
15. Social, factual, proposal, decision, and execution messages retain distinct
    types and cannot be mistaken for one another across transport surfaces.
