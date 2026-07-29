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
  threads/{threadId}
    messages/{messageId}
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

A thread is the durable conversational workspace for one objective. Messages
distinguish `human`, `agent`, and `system` authors and can reference context
items, workflow runs, proposals, and decisions. A message can request agent
work but cannot masquerade as an approval.

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

## Capability registry

The workflow language and action layer share an application-owned registry.
An initial capability descriptor contains:

```ts
type Capability = {
  kind: string
  category: 'context.read' | 'agent.compute' | 'company.write' | 'external.write'
  inputSchema: unknown
  outputSchema: unknown
  requiredRole: string
  requiresApproval: boolean
  reversibility: 'reversible' | 'compensatable' | 'irreversible'
}
```

For the first platform slice, the only consequential action should be
`work_item.create`. Calls are read context. This is deliberately small enough
to test the entire governance path.

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

The first model turn is forced to select a tool. Subsequent turns may compose
more tools or produce a structured final response. Tool calls are bounded,
arguments are validated with Zod, record kinds and fields are allowlisted, and
unknown citation IDs are removed. Retrieval content is explicitly treated as
untrusted evidence rather than instructions.

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
