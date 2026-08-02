# Connector epic: external context and approved effects

**Status:** core execution active

**Current implementation slice:** C3 — Durable synchronization and operator recovery

**Last plan revision:** 2026-07-31

This document owns connector sequencing. `PRODUCT_VISION.md` remains
authoritative for the product boundary, `INTERNAL_WORKFLOW.md` remains
authoritative for mandatory approval, and `CONNECTORS.md` remains the operating
description of what is deployed.

This is not a commitment to build every provider listed below. The core epic is
C0–C5 and G1–G3. Later provider phases begin only after their decision gate.

## Decision

Erik is the control plane for company work, not a replacement for email, chat,
calendars, documents, meetings, or specialist systems of record.

Erik owns:

- cases, stages, tasks, approvals, and their accountable owners;
- typed proposals and exact planned effects;
- durable case notes and an inspectable activity history;
- source references, evidence, and derived non-authoritative agent work; and
- execution and reconciliation records for approved effects.

Other products continue to own:

- composing, sending, and receiving everyday communication;
- live group conversation;
- document editing and canonical file storage;
- calendar and meeting experiences;
- video calls; and
- a specialist record when a company explicitly chooses that product as its
  system of record.

A case note is durable operational context, not an internal chat product.
Notifications should be delivered through the company's existing email or chat
system.

## What the sequence means

Each roadmap row is a separate implementation slice. One slice is designed,
built, tested, deployed, and observed before the next begins. A slice must
leave the product usable and must not depend on unfinished behavior from a
later slice.

For every slice:

1. Confirm its current assumptions against deployed behavior.
2. Write or update contract tests before changing a shared contract.
3. Implement the smallest complete backend and UI path.
4. Test authorization, isolation, idempotency, deletion, and failure behavior.
5. Deploy to the test-production environment.
6. Exercise the acceptance scenario with a real connected account.
7. Observe logs and stored state, then record the result here.
8. Start the next slice only when the exit criteria and decision gate are met.

The hosted environment currently serves as a test environment. Backward
compatibility remains the default, but a slice may declare a tightly scoped,
one-time destructive reset when preserving test data would cement the wrong
contract. The reset must name exactly what is removed and prove that unrelated
company data survives. C1 has approval to reset Google connector data only.

A later slice may be reordered when usage evidence warrants it; it may not
silently absorb another slice.

## Objective and core completion

The core epic proves this provider-backed loop:

```text
selected external evidence
→ normalized, permission-aware context
→ cited agent work
→ exact typed proposal
→ mandatory named approver
→ provider action
→ provider result or honest uncertainty
→ reconciliation and audit
```

The core epic is complete when:

- the Calendar, Drive, and Gmail subsystems of one Google Workspace connection
  meet the shared source contract;
- source freshness, failures, access, and deletion are inspectable;
- the workflow language can propose one honest external effect:
  `mail.draft.create`;
- the exact mailbox, recipient, subject, body, thread, and evidence are visible
  before approval;
- no provider call can occur without the named approver's recorded decision;
- retries cannot knowingly create duplicate drafts;
- an uncertain provider outcome cannot be blindly retried; and
- the provider draft ID and deep link are stored with the execution result.

Sending email is not part of the core epic. The human reviews, edits if needed,
and sends the draft in the mailbox that owns it.

## Non-negotiable invariants

1. **Explicit selection.** Connecting an account selects no resource
   implicitly.
2. **Least privilege.** Read and write grants are separate product records even
   when a provider represents them in one token. Adding a new capability never
   silently expands access.
3. **Mandatory approval.** Every workflow action has one named approver.
   External effects have no executor bypass. A direct user may be the approver,
   but the decision is still recorded before execution.
4. **Typed effects.** There is no generic `send_message`, `external_action`, or
   provider-authored executable payload.
5. **Exact preview.** Approval discloses the provider account, destination,
   payload, evidence, and expected result.
6. **Provider ownership.** Imported objects remain owned by their provider.
   Erik stores normalized observations and references, not competing canonical
   copies.
7. **One write destination.** An action writes to one declared system of
   record. Dual writes require a future typed compound-effect contract.
8. **Honest uncertainty.** Execution distinguishes `succeeded`,
   `failed_safe_to_retry`, and `outcome_unknown`.
9. **Access before retrieval.** A model never receives a source item the
   requesting member may not read.
10. **No placeholder capability.** A connector or workflow block is not shown
    as usable until its operating loop and failure behavior exist.

## Current baseline

The baseline was inspected in the deployed test environment on 2026-07-31.

| Area | Working now | Important limitation |
| --- | --- | --- |
| Connection kernel | One Google Workspace connection per stable Google identity, one encrypted credential envelope, nested capability configurations and selected resources | Durable run history, leases, retry, and honest aggregate health remain C3 |
| Odorik | Authenticated call upload, phone-line resources, normalized context | Compatibility path and generic connection path coexist |
| Google Calendar | Workspace subsystem with least-privilege consent, explicit calendar selection, incremental sync tokens, cancellation deletion, and 30-minute reconciliation | Imported items are company-visible; no measured freshness target |
| Google Drive | Workspace subsystem with least-privilege consent, explicit direct-folder selection, Google Docs/text extraction, manual sync, and consistent internal resource identity | No scheduled sync, recursive selection, stale-file deletion, or PDF text extraction |
| Context | Provider/capability/connection/resource identity, provenance, indexing, citations, and `company`/`restricted` envelope | Google capabilities still write `company`; provider ACLs are not projected |
| Approval | Named approver, effect digest, execution lease, audit, retry and unknown-outcome states; immutable typed registry for `task.create`, `case.create`, and `case.move` | No external executor exists yet; C3–G3 must prove provider recovery and execution |
| Connector catalog | Only working Odorik and Google Workspace capabilities are shown | Gmail remains deliberately absent until G1 has a complete operating loop |

The first slices protect and improve this baseline rather than immediately
adding another provider.

## Target connector contracts

The product hierarchy is provider account → capability configuration →
selected resource. A provider connection represents one authorized external
identity. Calendar, files, and mail are capabilities of that connection, not
separate accounts merely because their APIs have separate endpoints.

Provider and service routing IDs remain implementation details. Product
behavior is declared through capabilities.

```ts
type ConnectorCapability = {
  id: string
  direction: "observe" | "execute"
  resourceType?: string
  requiredScopes: string[]
  syncMode?: "webhook" | "incremental" | "reconcile"
  inputSchema?: unknown
  resultSchema?: unknown
  requiresApproval: boolean
}

type ProviderConnection = {
  connectorId: string
  providerId: string
  providerAccountId?: string
  tenantId?: string
  accountLabel: string
  grantedScopes: string[]
  status: "active" | "attention" | "disconnected"
}

type CapabilityConfiguration = {
  capabilityId: string
  enabled: boolean
  grantedScopes: string[]
  status: "active" | "attention" | "reauthorization_required" | "disabled"
}
```

Initial capability names:

```text
context.call.read
context.calendar.read
context.document.read
context.mail.read_scoped
context.meeting_artifact.read

action.task.create
action.case.create
action.case.move
action.mail.draft.create
```

A connection records one provider identity, tenant identity where relevant,
the encrypted credential envelope, all scopes actually granted to that
credential, lifecycle, and aggregate health. Each capability has a separate
configuration and logical grant even when the provider represents several
grants in one token.

Initial setup asks which implemented capabilities to enable before requesting
their combined scopes. Adding a capability later uses explicit incremental
authorization. It never silently expands access. Disabling a capability stops
sync and removes its imported context; it must not claim to revoke one provider
scope when the provider offers only account-level revocation. Disconnecting the
provider connection revokes and removes the whole account.

Every source capability must define:

- discoverable and selectable resource boundaries;
- initial import boundary and incremental cursor;
- normalization and deterministic identity;
- application access policy;
- update, move, deletion, disconnect, and revocation behavior;
- deep-link behavior;
- freshness target and reconciliation path; and
- what the user sees when the source is incomplete or stale.

Every action capability must define:

- validated input and result schemas;
- the exact required grant;
- named approver and effect digest;
- current-state preconditions;
- provider-aware idempotency;
- safe retry and reconciliation behavior;
- external result ID and deep link; and
- an operator path for `outcome_unknown`.

## Roadmap overview

| Slice | Outcome | Status | Gate |
| --- | --- | --- | --- |
| C0 | Characterize and protect current connector behavior | Completed | Baseline contract tests pass |
| C1 | Replace split Google connectors with one Workspace account and capability configurations | Completed | Scoped Google reset succeeds and one real account reconnects |
| C2 | Put internal actions behind an extensible typed action registry | Completed | Existing workflow approvals behave unchanged |
| C3 | Add durable sync runs, leases, retries, replay, and useful health | In progress | Failures are recoverable and freshness is measurable |
| C4 | Make resource audiences and retrieval access explicit | Pending | Restricted-source isolation tests pass |
| C5 | Harden the Calendar and Drive subsystems of Google Workspace | Pending | Real accounts meet source acceptance scenarios |
| G1 | Add selected-label Gmail evidence to Google Workspace | Pending | Cross-source call + email answer succeeds |
| G2 | Produce an exact, non-executing email-draft proposal | Pending | Proposal is useful without any provider write |
| G3 | Create a Gmail draft after approval and reconcile the result | Pending | Core epic acceptance scenario succeeds |
| M1 | Establish one Microsoft 365 account connection and scoped Outlook mail evidence | Gated | Microsoft decision gate passes |
| M2 | Prove `mail.draft.create` through Outlook | Gated | Same workflow needs no provider-specific semantics |
| M3+ | Add one Microsoft resource family per slice | Gated | Calendar/files demand chooses the next family |
| A1 | Ingest selected meeting artifacts | Gated | Artifact demand and provider access are proven |
| R1 | Add one specialist system-of-record connector | Gated | One provider wins the scorecard |
| H1 | Post approval/case notifications to one chat provider | Gated | A customer loop requires it |
| H2 | Read selected chat mentions or channels | Gated | H1 is useful and privacy case is accepted |

## Core foundation slices

### C0 — Characterize and protect the baseline — completed 2026-07-30

**Usable outcome:** current source behavior can be refactored without guessing
what must remain stable.

Build:

- contract fixtures for public connection/resource views;
- adapter normalization tests for deterministic source identity and
  provenance;
- tests for Calendar incremental updates and cancellations;
- tests for Drive selection and current direct-child behavior;
- tests for resource disable, disconnect, permanent deletion, and context
  removal;
- tests proving credentials and unrestricted source payloads never enter the
  public view; and
- documentation corrections for the actually deployed Drive behavior.

Not included:

- schema redesign;
- new OAuth scopes;
- new providers; or
- changes to user-visible source behavior.

Exit criteria:

- tests describe the existing compatibility promises;
- known gaps are explicit rather than accidentally encoded as desired behavior;
- the full redesign test suite passes; and
- this document names C1 as current only after deployment verification.

### C1 — Google Workspace account and subsystem configurations — completed 2026-07-31

**Usable outcome:** an administrator connects one Google Workspace account,
chooses which implemented services Erik may observe, and configures the
resources included by each service from one coherent account workspace.

This is an intentional pre-production contract reset. Preserving the current
split Calendar and Drive connection records would add migration code around a
model we no longer want.

Connection model:

```text
Google Workspace account connection
├── encrypted OAuth credential envelope
├── Calendar capability configuration
│   └── selected calendar resources
├── Drive capability configuration
│   └── selected folder resources
└── future Gmail capability configuration
    └── selected label resources
```

Build:

- replace the C0 public fixtures with target-contract tests before changing the
  runtime, including reset-boundary and cross-capability isolation tests;
- replace `google_calendar` and `google_drive` connection types with one
  `google_workspace` connector;
- identify the account by Google's stable OpenID `sub`, retain email as a
  mutable display label, and leave room for hosted-domain or tenant identity;
- derive the connection document identity from company and Google `sub` so
  duplicate callbacks cannot create two Workspace connections for one account;
- ask the administrator which currently implemented subsystems to enable
  before OAuth, then request the union of only their required scopes;
- persist the scopes Google actually granted and enable only explicitly
  selected capabilities whose complete required scope set is present;
- preserve the existing refresh token during incremental authorization when
  Google returns only a new access token, and reject an attempted subsystem
  expansion when the returned `sub` differs from the existing connection;
- store one encrypted credential envelope on the provider connection;
- store Calendar and Drive configuration, lifecycle, and aggregate sync state
  independently at
  `connections/{connectionId}/capabilities/{calendar|drive}`;
- keep resources beneath the provider connection and require every resource to
  name exactly one capability;
- make provider operations accept the Workspace connection ID and reject calls
  whose corresponding capability is absent, disabled, or insufficiently
  granted;
- normalize source identity as `providerId`, `capabilityId`, `connectionId`,
  internal resource document ID, provider object `externalId`, and version;
- correct Drive context so `source.resourceId` always references the internal
  resource document ID;
- update scheduled Calendar discovery, connection deletion, revocation,
  resource exclusion, citations, and search metadata for the new identity;
- replace the Calendar and Drive top-level cards with one Google Workspace card
  per account and nested subsystem configuration;
- show account identity, enabled capabilities, actual grants, selected
  resources, aggregate connection state, per-capability state, and
  reauthorization requirements;
- distinguish **Disable service** from **Disconnect Google Workspace**:
  disabling stops synchronization and removes that capability's imported
  context, while disconnecting revokes the provider token and removes the
  entire account;
- remove Gmail and GitHub placeholders from the primary catalog; and
- add a confirmation-protected reset command that deletes only Google
  Calendar/Drive connections, resources, imported context, derived search
  records, and unfinished Google OAuth state.

The reset must preserve Odorik calls and connections, contacts, cases, tasks,
approvals, workflows, companies, and memberships. After deployment, the test
account is reconnected and its calendars and folders are selected again.

Adding a future Google capability uses incremental consent on the same logical
Workspace connection. It may replace the encrypted credential envelope and
expand its physical token scopes, but the newly enabled capability and grant
remain explicit product records.

Not included:

- Gmail data or mail actions;
- provider actions of any kind;
- migration of current Google connector records or imported Google context;
- merging distinct Google identities or organization-wide delegation;
- claiming that disabling one service revokes only that scope at Google;
- Microsoft 365 accounts; or
- new workflow blocks.

Exit criteria:

- the scoped reset removes all and only existing Google connector data;
- selecting Calendar and Drive during setup produces one consent flow, one
  Workspace connection, and two independently configurable capabilities;
- selecting one service requests no scopes for the other;
- authorization selects no calendars or folders implicitly;
- partial consent fails closed for any capability missing a required scope;
- Calendar and Drive use the same connection ID without mixing resources,
  cursors, errors, or counts;
- every active resource and normalized context item maps to one declared
  observe capability;
- disabling one subsystem removes it from retrieval without disabling the
  other;
- disconnecting Workspace removes both subsystems and revokes the credential;
- the public API contains no credential material;
- Odorik and all internal operational data survive the reset unchanged; and
- one real Workspace account completes connect, select, sync, cite, disable,
  and re-enable acceptance scenarios; and
- credential revocation and scoped account deletion pass contract acceptance.
  A destructive live disconnect is repeated only when the acceptance account
  can be reauthorized without another manual unverified-app safety handoff.

### C2 — Typed action capability registry — completed 2026-07-31

**Usable outcome:** the approval kernel can add an external executor without
turning into a growing provider-specific conditional.

#### Design boundary

C2 is a static application registry, not a connector marketplace, runtime
plugin system, generic action endpoint, or dynamic workflow UI. The production
registry contains exactly the three action kinds that already execute:
`task.create`, `case.create`, and `case.move`.

Workflow block kinds remain `action.task.create`, `action.case.create`, and
`action.case.move`; their evaluated approval payloads retain the existing
shorter action kinds. Source capability descriptors remain separate from the
action registry. This avoids forcing observe and execute behavior into one
misleading abstraction.

Direct task/case interactions also remain direct user authorizations: the
initiating human is the recorded approver. The registry is the only dispatch
path for workflow-proposed effects, but it is not exposed as a browser-callable
“execute any action” API.

#### Registry contract

Each descriptor owns the complete semantics that currently leak into
`approvals/repository.ts`:

```ts
type ActionDescriptor = {
  kind: string
  capabilityId: string
  contractVersion: 1
  category: "company.write" | "external.write"
  inputSchema: ZodType
  resultSchema: ZodType
  authorization: {
    requiresApproval: true
    providerCapabilityId?: string
  }
  reversibility: "compensatable" | "irreversible"
  idempotency: "deterministic_internal" | "provider_aware"
  reconciliation: "deterministic_lookup" | "required_before_retry"
  prepareForApproval(...)
  assertRequestPreconditions(...)
  scope(...)
  execute(...)
  resultReference(...)
  classifyFailure(...)
}
```

The registry constructor rejects duplicate kinds, duplicate capability IDs,
any descriptor that does not require approval, and an `external.write`
descriptor without a provider capability, provider-aware idempotency, and a
reconciliation declaration. It returns an immutable map; production code
cannot register actions after startup.

`prepareForApproval` resolves authoritative member and stage names before the
effect digest is calculated. `assertRequestPreconditions` retains transaction-
aware validation for a selected case and exact case movement. `scope` owns
contact/call/case linkage. `execute` receives an approval-bound context
containing company, approval ID, approver, attempt ID, and immutable workflow
provenance. `resultSchema` validates the sanitized result before success is
recorded, while `resultReference` produces the generic task/case/movement link
already used by the UI.

All three internal effects are compensatable rather than automatically
reversible. Their deterministic IDs make retry safe and provide their current
reconciliation strategy. A future external descriptor must name its required
provider capability and use provider-aware idempotency; merely adding it to
the registry does not grant access or bypass approval.

#### Approval-kernel cutover

After the cutover, the approval repository performs one generic sequence:

1. resolve and verify the named active approver;
2. look up the action descriptor and parse its strict input schema;
3. let the descriptor normalize the disclosed action and validate request-time
   preconditions;
4. persist the action kind, capability ID, contract version, exact payload,
   canonical digest, scope, and workflow provenance;
5. on approval, verify actor, payload, digest, lease, and attempt ID;
6. invoke only the descriptor returned by the immutable production registry;
7. validate and persist the typed execution result plus its generic result
   reference; and
8. classify failure as safe to retry or outcome unknown before writing the
   audit event.

Existing approval documents remain executable. Missing contract-version and
capability fields infer version 1 from the registered action kind, and the
legacy digest fallback remains until no deployed approval relies on it. C2
does not migrate or rewrite historical approvals.

Registry metadata is not part of the effect digest: the digest continues to
cover the exact disclosed action payload only. Persisted contract version and
capability ID select its interpreter but cannot silently change what was
approved.

The refactor removes action-specific branches for preparation, scope,
preconditions, execution, and result mapping from the approval kernel.
Action-specific rendering in `ApprovalCard.vue` remains explicit; building a
generic schema-driven form or renderer before an external proposal exists
would add machinery without user value.

Build:

- keep action schemas, canonical digest, and legacy digest compatibility in
  `actions/contracts.ts`;
- add the descriptor types, immutable registry constructor, and production
  lookup in `actions/registry.ts`;
- implement the three current descriptors in `actions/internal-actions.ts`,
  reusing the existing task and pipeline repositories rather than copying
  their mutation logic;
- move request preparation, transactional preconditions, scope derivation,
  execution, result validation, result linking, and failure classification
  behind those descriptors;
- keep approval decision, effect-integrity, lease, retry, unknown-outcome, and
  audit mechanics generic in `approvals/repository.ts`;
- add one narrow dependency boundary around the approval kernel—database,
  immutable registry, and active-member resolution—so tests can use an
  isolated registry and store without making production registration mutable;
- keep the existing canonical effect digest and named approver contract;
- persist additive `actionCapabilityId`, `actionContractVersion`, and sanitized
  `executionResult` fields on new approvals;
- make test registry injection explicit without exposing mutable registration
  in the production runtime; and
- update `INTERNAL_WORKFLOW.md` and `PLATFORM_ARCHITECTURE.md` to match the
  deployed contract after acceptance.

Implementation order:

1. Add golden action/digest fixtures and registry-construction tests.
2. Introduce the registry and the three internal descriptors while the old
   dispatcher still exists.
3. Cut approval creation over to descriptor preparation, preconditions, and
   scope, then compare persisted fixture projections.
4. Cut approval execution over to descriptor dispatch and typed results; delete
   the old dispatcher only after parity tests pass.
5. Run one test-only external descriptor through the approval harness with a
   spy executor; it must remain unreachable without the named approval.
6. Deploy and exercise current internal actions in test production before
   naming C3 as current.

Not included:

- an external executor;
- a generic connector action;
- a runtime extension API or provider-authored descriptor;
- a schema-driven approval-card renderer;
- changes to workflow block schemas or the editor;
- changes to direct human task/case actions;
- approval policy rules or a new policy language; or
- autonomous actions.

Tests:

- registry construction fails for duplicate, malformed, or approval-optional
  descriptors, and lookup rejects every unregistered action kind;
- strict input and result schemas reject extra or malformed fields;
- golden canonical and legacy digests for all three current actions remain
  unchanged;
- existing approval projections remain readable with no contract-version
  field;
- actor mismatch, payload tampering, and an active execution lease call no
  executor;
- two approval/retry requests for the same deterministic effect produce one
  task, case, or movement;
- a stale case movement still changes nothing and returns a precondition
  failure;
- a malformed executor result cannot be recorded as success;
- an external descriptor without a provider-capability declaration is rejected;
- the registered fake external executor's call count remains zero without its
  named approval;
- a simulated uncertain external result becomes `outcome_unknown`, cannot be
  blindly retried, and calls the fake provider only once; and
- the complete redesign suite remains green.

Test-production acceptance:

- use one disposable completed-call/contact/case fixture and a workflow version
  that proposes the existing internal actions;
- approve a task, case creation, and exact case move from the current Work and
  case-detail surfaces;
- confirm their existing result links, authorization envelopes, effect
  digests, and audit events;
- repeat an already succeeded approval and observe the same result with no
  duplicate object; and
- make one movement stale before approval and verify that neither the case
  stage nor revision changes.

Exit criteria:

- the production approval kernel contains no action-kind conditional;
- all existing workflow payloads, approval cards, and result links behave
  unchanged;
- duplicate approvals still produce exactly one internal effect;
- stale case movements still fail closed;
- unknown or unregistered actions cannot create approvals;
- a test-only external action cannot execute without a named approval and
  declared provider capability; and
- the live task/create-case/move-case acceptance scenario passes with no
  duplicate effects.

### C3 — Durable synchronization and operator recovery

**Usable outcome:** an administrator can distinguish fresh, stale, failed, and
recovering sources and can safely replay a failed resource.

**Implementation status (2026-08-02):** C3A is implemented in the repository
and awaits test-production acceptance. Calendar manual, selection, scheduled,
and recovery paths now share durable capability runs, distinct resource
attempts, fenced resource leases, four bounded attempts (one initial attempt
plus 1/5/30-minute backoff), stale-run recovery, truthful timestamps, and an
operator replay action in Sources. The schema is additive and retains legacy
sync fields as read fallbacks. C3 remains in progress: Drive and GitHub still
need to adopt the runtime, and Firestore-to-Qdrant delivery/freshness remains a
separate unfinished reliability plane.

Build:

- durable per-capability and per-resource sync runs with trigger, cursor,
  attempt, counts, timing, outcome, and sanitized error;
- a lease that prevents concurrent runs for the same resource;
- separate `lastAttemptAt`, `lastSuccessAt`, `lastChangeObservedAt`, and
  `lastReconciledAt` semantics;
- bounded retry with backoff, then a visible dead-letter/attention state;
- replay from the Sources screen;
- continue syncing healthy capabilities and resources when one fails;
- reconciliation that does not resurrect a disconnected/deleted connection;
  and
- metrics for source-to-context and context-to-search freshness.

Polling remains acceptable in this slice. Push subscriptions come only after
polling and reconciliation are correct.

Exit criteria:

- forced transient failure retries without duplicates;
- forced permanent failure becomes actionable rather than looping forever;
- a stale lease is safely reclaimed;
- a disconnected connection cannot be revived by an in-flight run; and
- connection health is an honest aggregate of its capability configurations
  rather than a last-writer-wins field; and
- the Sources screen reports truthful account, subsystem, and resource state.

### C4 — Permission-aware resources and context

**Usable outcome:** a company can connect a sensitive source without exposing
it to every enabled member.

Build:

- an explicit resource audience: all company members or selected member IDs;
- default personal mailbox resources to the connecting member only;
- copy the resource audience to every normalized context item;
- enforce access consistently in exact lookup, list, aggregate, hybrid search,
  citations, and case-linked evidence;
- display the audience in Sources and warn before broadening it;
- re-project and re-index context after an audience change; and
- preserve current company visibility for existing Calendar/Drive resources
  until an administrator changes it.

Provider ACL mirroring is deferred. The first honest contract is an explicit
Erik audience chosen by an administrator, never a claim that provider ACLs
were reproduced perfectly.

Exit criteria:

- unauthorized members cannot retrieve restricted source content through any
  agent tool or direct API;
- changing an audience updates search eligibility;
- disabling a resource removes it from all retrieval; and
- cross-company and cross-member isolation tests pass.

### C5 — Harden Google Workspace Calendar and Drive

**Usable outcome:** the Calendar and Drive subsystems of Google Workspace are
dependable enough to be the foundation for Gmail rather than permanent
prototypes.

Calendar:

- retain incremental sync-token and cancellation behavior;
- reconcile scheduled and recurring events deterministically;
- preserve deep links and source versions;
- classify reauthorization separately from transient provider failure; and
- measure the polling freshness target.

Drive:

- schedule synchronization as well as supporting manual sync;
- define selected-folder behavior as recursive;
- prevent overlapping selected parent/child roots from creating duplicate
  context;
- extract supported Google Docs, plain text/Markdown, and PDF text;
- treat unsupported binary files as metadata and a deep link, not fake text
  extraction;
- delete context for files deleted, trashed, moved out of scope, or no longer
  visible; and
- reconcile counts from stored context rather than the latest page scan.

Initial service targets:

- manual sync becomes searchable within two minutes for the expected test
  corpus;
- scheduled sources have a measured p95 source-to-search freshness below
  45 minutes; and
- zero duplicate active context items for one provider object within one
  Workspace connection and capability.

Push notifications may later improve latency, but they are not an excuse to
skip reconciliation. OAuth verification is an operational release gate before
general customer authorization.

Exit criteria:

- real Calendar and Drive subsystems pass create/update/delete/move/deselect
  scenarios within one Workspace account;
- extracted and metadata-only documents are labeled honestly;
- connection health remains correct through token expiry and recovery; and
- the agent answers a cited question spanning one call, event, and document.

## Gmail slices

### G1 — Scoped Gmail subsystem

**Usable outcome:** a member can ask Erik about relevant email without giving
the whole company an invisible mailbox import.

Build:

- add `context.mail.read_scoped` as a capability configuration of an existing
  Google Workspace connection;
- request its required scopes through explicit incremental consent and record
  the scopes actually granted;
- preserve the same Workspace account identity and credential envelope rather
  than creating a parallel Gmail connection;
- explicit label discovery and selection with nothing selected by default;
- a fixed 90-day initial import, followed by incremental changes;
- normalized message and thread identity, sender/recipient headers, timestamps,
  plain searchable body, provider version, and Gmail deep link;
- attachment names and provider references only; attachment content is
  deferred;
- restricted audience defaulting to the connecting member;
- Gmail push notification handling plus periodic reconciliation and watch
  renewal; and
- message deletion/label-removal behavior consistent with the selected scope.

Not included:

- reading every mailbox by default;
- organization-wide delegation;
- composing, drafting, sending, or modifying mail;
- attachment ingestion; or
- provider-specific agent tools.

Exit criteria:

- enabling Gmail does not alter Calendar or Drive configuration, resources, or
  sync state;
- a Workspace connection without the complete Gmail grant cannot import mail;
- the agent answers a cited question requiring one call and one selected-label
  email;
- removing the selected label removes that message from active context;
- an unauthorized member cannot discover the message;
- watch loss is recovered by reconciliation; and
- the Sources screen shows label coverage and freshness.

### G2 — Exact email-draft proposal

**Usable outcome:** a workflow can prepare a useful follow-up proposal while
remaining incapable of writing to Gmail.

Build:

- a typed `mail.draft.create` proposal payload containing connection, mailbox,
  recipient, subject, body, optional thread reference, and evidence references;
- a workflow block with an inseparable named approver;
- internal derived draft generation from explicitly available evidence;
- a preview that distinguishes generated content from provider state;
- validation of recipient email, mailbox ownership, body limits, and current
  connection capability;
- deterministic skip reasons such as `recipient_missing`,
  `mailbox_unavailable`, or `insufficient_context`; and
- an effect digest covering every field that could reach the provider.

The block does not execute yet. It proves that the workflow can name a real
effect rather than reintroducing a vague “draft using” primitive.

Exit criteria:

- history preview and a real workflow run produce the same proposed payload;
- missing or ambiguous recipient data fails closed;
- the proposal shows exact content and evidence on mobile and desktop;
- changing any effect field changes the digest; and
- no Gmail write scope or API call exists in the slice.

### G3 — Approval-gated Gmail draft creation

**Usable outcome:** approving the exact proposal creates one inspectable Gmail
draft; rejecting it creates nothing.

Build:

- explicitly expand the same Google Workspace connection with the separate
  `action.mail.draft.create` capability grant and its minimum write scope;
- keep mail-read and draft-write grants independently visible and enforceable
  even though Google may represent both in the connection's credential;
- a Gmail executor registered through the C2 action registry;
- transactionally recorded approval before the provider call;
- provider-aware idempotency and a deterministic reconciliation marker;
- storage of Gmail draft/message/thread ID, deep link, provider account, and
  observed version in the execution result;
- correct `failed_safe_to_retry` versus `outcome_unknown` classification;
- an operator reconciliation/recovery action for unknown results; and
- an execution card linked from the related case, task, approval, and audit
  history where applicable.

Not included:

- automatic sending;
- attachments;
- bulk mail;
- open/click tracking;
- a mailbox or email editor inside Erik; or
- retrying an unknown result without reconciliation.

Exit criteria:

- a Workspace account with mail-read permission but no draft-write grant
  cannot execute the action;
- rejection makes zero provider calls;
- approval by anyone other than the named approver fails;
- two approval/retry requests produce one provider draft;
- simulated timeout-after-provider-success becomes reconcilable rather than
  duplicating the draft;
- the user can open the created draft in Gmail; and
- the complete call → proposal → approval → draft → audit scenario succeeds in
  the test-production environment.

## Expansion decision gates

Later phases are options, not automatic continuation. A provider is selected
using evidence from target companies and the following scorecard.

| Criterion | Weight |
| --- | ---: |
| Ubiquity in the target customer segment | 20 |
| Valuable repeatable operating loop unlocked | 20 |
| Signal density and authority of its data | 15 |
| Safe typed action available | 15 |
| API, permission, and ACL feasibility | 10 |
| Installation and administrator friction | 10 |
| Sync, reconciliation, and support cost | 10 |

A provider must have:

- one named user problem, not “integration coverage”;
- at least one real design partner willing to authorize and test it;
- explicit selectable resources;
- a supportable API and permission path;
- a source retention/access model; and
- one acceptance scenario that completes a loop.

Free price alone is not a selection criterion.

### M1–M3 — Microsoft 365

Decision gate: at least one committed Microsoft 365 design partner, or clear
evidence that Google-only support blocks the target segment.

Microsoft 365 follows the same product hierarchy as Google Workspace:

```text
Microsoft 365 account connection
├── provider account and tenant identity
├── encrypted Microsoft Graph credential envelope
├── Outlook Mail capability configuration
├── future Outlook Calendar capability configuration
└── future SharePoint/OneDrive capability configuration
```

It is not a collection of unrelated Outlook, OneDrive, SharePoint, and Teams
connection cards. One connection represents one Microsoft account in one
tenant; each enabled subsystem retains its own scopes, configuration,
resources, sync state, and failures.

Execute one resource family per slice:

1. **M1:** establish the Microsoft 365 connection kernel with stable account
   and tenant identity, explicit subsystem selection, incremental Microsoft
   Graph consent, and selected Outlook mail folders implementing
   `context.mail.read_scoped`.
2. **M2:** add the separate `action.mail.draft.create` capability grant to the
   same connection and implement the existing approved draft contract through
   Outlook.
3. **M3+:** choose Outlook Calendar or SharePoint/OneDrive from observed
   demand, then add one capability configuration before considering the other.

Teams chat and meeting artifacts are not enabled merely because the account is
already connected. They retain their own demand, privacy, permission, and
acceptance gates.

Use delegated, dynamically requested scopes where the tenant permits them.
Tenant policy or an admin-restricted permission must become an explicit
`admin_consent_required` setup state, never a reason to request broad
organization-wide application permissions by default.

The proof is provider neutrality: the workflow and approval semantics do not
change, while account and tenant identity, grants, cursors, IDs,
reconciliation, and deep links remain provider-specific.

### A1 — Meeting artifacts

Decision gate: users repeatedly need meeting outcomes that call transcripts do
not cover and the chosen suite exposes supportable artifacts.

Ingest selected transcript, recording, attendance, or generated-note
references from Google Meet, Microsoft Teams, or a demanded specialist
provider. Erik stores normalized text and deep links; it does not host meetings
or become a video client.

### R1 — Specialist system of record

Decision gate: one CRM, support, issue, or accounting provider wins the
scorecard for a concrete workflow.

Before implementation, declare ownership:

- an Erik-owned case/task may link to an external object;
- an imported provider object is a provider-owned observation;
- an approved action writes to one selected provider and stores its external
  identity; and
- bidirectional synchronization is excluded until conflict semantics are
  specified.

Build only one provider and one typed action first, such as creating a ticket
or updating an external case stage. GitHub Issues is not privileged merely
because it is already a planned catalog entry.

### H1–H2 — Chat

Decision gate: a customer operating loop measurably benefits from chat delivery
and identifies the provider it already uses.

H1 is outbound notification only:

- selected destination;
- exact short message and Erik deep link;
- mandatory named approver;
- result ID and deep link; and
- no attempt to reproduce conversation in Erik.

H2 may later ingest direct mentions or explicitly selected channels. It does
not ingest a whole company by default and does not promise complete history.

Slack, Teams, Google Chat, and Discord remain provider candidates. Erik should
not recommend Discord as a universal company default merely because its free
tier is generous. A future starter-stack guide should be neutral, disclose
identity/security/retention tradeoffs, and remain content rather than a product
dependency.

## Metrics

Record these per capability and provider:

- time from authorization to first useful cited result;
- selected resources with at least one successfully normalized item;
- source-to-context and context-to-search freshness;
- successful, retried, dead-lettered, and reauthorized sync runs;
- duplicate and stale-item rate after reconciliation;
- unauthorized retrieval attempts and successful leaks—the latter target is
  always zero;
- proposals approved, rejected, or skipped by reason;
- external execution success, safe failure, and unknown outcome;
- duplicate external effect rate—the target is zero;
- time to reconcile an unknown outcome; and
- administrator setup and support time.

Provider count is not a success metric.

## Explicitly deferred

- internal email, chat, calendar, document, or meeting replacements;
- organization-wide mailbox or chat ingestion;
- autonomous external actions;
- generic send-message or arbitrary HTTP workflow actions;
- email sending in the first external-action loop;
- provider ACL claims before they can be enforced;
- automatic bidirectional synchronization;
- simultaneous implementation of Google, Microsoft, Slack, and Discord;
- connector marketplace architecture; and
- provider recommendations based mainly on price.

## Reference material

- [Google OAuth 2.0 for web server applications and incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OpenID Connect identity](https://developers.google.com/identity/openid-connect/openid-connect)
- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Google Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Google Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Microsoft Graph Outlook mail API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview)
- [Microsoft Graph calendar delta query](https://learn.microsoft.com/en-us/graph/delta-query-events)
- [Microsoft identity platform scopes and incremental consent](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)
- [Google Workspace Events API](https://developers.google.com/workspace/events)
- [Slack API rate limits](https://api.slack.com/apis/rate-limits)
- [Discord message resource and privileged content intent](https://docs.discord.com/developers/resources/message)

## Progress log

Add one entry after each deployed slice:

```text
YYYY-MM-DD — Slice
- Commit/deployment:
- Acceptance account and scenario:
- Metrics observed:
- Known limitations:
- Decision: continue, revise, or stop
```

### 2026-07-30 — C0

- **Commit/deployment:** `e997f07`; GitHub Actions run
  [30573276441](https://github.com/tomaash/odorik-agent/actions/runs/30573276441)
  completed successfully.
- **Acceptance:** the production repository functions were exercised through
  an in-memory Firestore contract harness; CI rebuilt and tested Functions,
  rebuilt the frontend, deployed Firebase resources, and the hosted
  application returned HTTP 200. C0 intentionally made no live provider or
  source-data mutation.
- **Metrics observed:** the full redesign suite passes 60 tests: 11 shared
  workflow, 41 Functions, and 8 frontend tests. Five new connector tests cover
  public projections and secret exclusion, connection/resource lifecycle,
  Calendar incremental/cancellation behavior, Drive's direct-child boundary,
  and deterministic Odorik provenance.
- **Known limitations:** Drive normalized context uses the provider folder ID
  while the resource document uses a hashed ID, so generic resource
  enable/disable cannot match Drive items. Google source audiences remain
  company-wide. C1 will replace and reimport Google test data rather than
  migrate the split connection model; C4 owns resource audiences.
- **Decision:** C0 passed. Continue to C1.

### 2026-07-31 — C1 deployment checkpoint

- **Commit/deployment:** `a9e3740`; GitHub Actions run
  [30611814118](https://github.com/tomaash/odorik-agent/actions/runs/30611814118)
  completed successfully and deployed Functions, Firestore indexes, and both
  application hosting targets.
- **Acceptance:** the guarded production dry-run selected one superseded
  Google connection, five Google resources, seven Google-derived context
  items, and no OAuth states. The confirmed reset removed that exact set; a
  second dry-run returned zero for every Google category. The signed-in
  Sources screen retained the populated Odorik connection, rendered one empty
  Google Workspace account card, and produced one OAuth request containing
  only OpenID identity, Calendar read, and Drive read scopes.
- **Metrics observed:** 63 tests pass: 11 shared workflow, 44 Functions, and
  8 frontend tests. New C1 contracts cover target public projections and
  secret exclusion, minimal and partial scope grants, cross-capability
  isolation, stable Google account identity, and Google-only reset isolation.
  The hosted app and OAuth callback returned healthy HTTP responses.
- **Known limitations:** Google displayed its unverified-test-app safety
  interstitial. The owner must explicitly continue through that warning;
  connector acceptance has therefore not yet exercised real calendar/folder
  selection, synchronization, citation, disable/re-enable, and full-account
  disconnect. C3, C4, and C5 still own durable recovery, resource audiences,
  and provider synchronization hardening.
- **Decision:** the deployment and destructive reset passed. Stay on C1 until
  the owner completes the Google safety handoff and the real-account scenario
  passes; do not begin C2 yet.

### 2026-07-31 — C1 completed

- **Commit/deployment:** `a9e3740`, `b54a202`, `cf88939`, and `156312b`;
  final GitHub Actions run
  [30615127006](https://github.com/tomaash/odorik-agent/actions/runs/30615127006)
  completed successfully and deployed the accepted production state.
- **Acceptance:** `tomas.holas@gmail.com` authorized Calendar and Drive on one
  Workspace connection. A partial first consent enabled Calendar only, the UI
  truthfully reported the missing Drive grant, and a focused incremental
  authorization recovered it. No resource was selected implicitly. The
  administrator selected only `České svátky` and the top-level `test` folder;
  the Sources screen showed 341 calendar events and one document. A fresh Ask
  query answered that 5 July 2026 is Den slovanských věrozvěstů Cyrila a
  Metoděje with high confidence and one calendar citation.
- **Isolation and recovery:** disabling Calendar removed its materialized
  context while Drive remained included with one item. Re-enabling and
  reselecting Calendar forced a full rebuild back to 341 items instead of
  incorrectly trusting an incremental cursor over deleted context. Unselected
  provider calendars are no longer persisted as disabled product resources,
  and Drive selection records truthful capability sync timestamps.
- **Metrics observed:** 63 tests pass: 11 shared workflow, 44 Functions, and
  8 frontend tests. Live selected-resource counts are 341 Calendar and one
  Drive item. The scoped reset and all live subsystem operations left the
  existing Odorik connection and internal company data intact.
- **Known limitations:** Google still presents the unverified-test-app safety
  interstitial. Provider revocation and scoped deletion are contract-tested,
  but the final live acceptance account was deliberately left connected so
  another manual safety handoff was not required. Durable sync-run history and
  recovery belong to C3, resource audiences to C4, and reconciliation,
  recursive Drive selection, stale-file deletion, and richer document
  extraction to C5.
- **Decision:** C1 passed. Keep the accepted Workspace account connected and
  continue to C2.

### 2026-07-31 — C2 completed

- **Commit/deployment:** implementation commit `328601e` and completion
  hardening commit `f87ae65`; GitHub Actions runs
  [30619069809](https://github.com/tomaash/odorik-agent/actions/runs/30619069809)
  and
  [30620593141](https://github.com/tomaash/odorik-agent/actions/runs/30620593141)
  completed successfully and deployed Functions, Firestore configuration, both
  application targets, and the verified private Eventarc bindings.
- **Acceptance:** the existing call-follow-up workflow was upgraded from its
  legacy implicit task subject, previewed against six completed calls, and
  deployed as versions 3 and 4. A supported call backfill created typed
  `task.create`, `case.create`, and `case.move` requests with capability IDs,
  contract version 1, exact named approver, immutable call/workflow provenance,
  and no target effect before approval. Approving the first two produced one
  open task and one case. Approving the exact `New → Follow-up` movement
  produced one movement and revision 1; the Work queue and case workspace
  showed the task, result links, stage, revision, authorization, and audit
  history. Repeated task, case, and movement approvals returned their stored
  typed results with `duplicate: true`, and repeating the workflow backfill
  retained one version-4 run, three approvals, and one movement.
- **Failure acceptance:** repeated version-4 task and case proposals were
  rejected and created no objects. A separate exact movement was requested at
  `Follow-up`, the case was changed directly to `In progress`, and approval of
  the stale proposal failed safe to retry without changing stage or revision.
  Registry tests also prove payload tamper, actor mismatch, active lease,
  malformed result, unknown action, and simulated provider-uncertainty
  behavior.
- **Infrastructure finding:** the first backfill exposed a missing
  `roles/run.invoker` binding between the declared `odorik-crm` Eventarc
  delivery identity and the private `processCallWorkflows` Cloud Run service.
  The service returned authenticated-invocation warnings and performed no
  work. The narrow private binding was restored; the next delivery succeeded.
  Deployment now reapplies the same binding idempotently to all three private
  Firestore-triggered services.
- **Metrics observed:** 72 tests pass: 11 shared workflow, 53 Functions, and
  8 frontend tests. The nine registry tests cover construction, golden
  digests, approval-only dispatch, legacy approvals, uncertain outcomes,
  malformed results, tamper/lease behavior, and stale movement preconditions.
  Live acceptance produced exactly one task, one case, and one successful
  movement; rejected and duplicate paths produced no additional effect.
- **Known limitations:** the production registry deliberately contains only
  the three honest internal effects. Approval cards remain explicitly rendered
  by action kind, and no external executor exists until G3. The disposable C2
  task, case, approvals, run records, and stale-failure record remain visible
  in the test-production account as inspectable acceptance evidence.
- **Decision:** C2 passed. Keep mandatory named approval and the immutable
  registry boundary; continue to C3 before adding Gmail or an external write.
