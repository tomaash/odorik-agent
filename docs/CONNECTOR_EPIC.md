# Connector epic: external context and approved effects

**Status:** core execution active

**Current implementation slice:** H1 — outbound approval notification to Slack.
The core epic (C0–C5, G1–G3) is complete and accepted.

**Last plan revision:** 2026-08-06

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

    A capability's operating loop is the loop *it* performs, not the epic's final
    one. For an observe capability that is select a resource, ingest it, and cite
    it in an answer, together with its cursor recovery and failure states. It is
    **not** the external-write loop: requiring G2–G3 before a mail capability could
    be configured at all would be circular, since the read loop cannot be exercised
    without the configuration surface that drives it. An execute capability is held
    to its own loop — approval, provider call, result or honest uncertainty,
    reconciliation — and that one is genuinely gated on G3.

    What this rules out is unchanged: a card that offers a service with no adapter
    behind it, or one whose failures are invisible.

## Current baseline

The baseline was last accepted in the deployed test environment on 2026-08-02.

| Area | Working now | Important limitation |
| --- | --- | --- |
| Connection kernel | One Google Workspace connection per stable Google identity, one encrypted credential envelope, nested capability configurations and selected resources, durable sync runs/recovery, typed Google failure/reauthorization state, and separate durable search delivery | Draft write is a separately granted capability on the same connection; enabling it needs a second consent pass |
| Odorik | Authenticated call upload, phone-line resources, normalized context | Compatibility path and generic connection path coexist |
| Google Calendar | Workspace subsystem with least-privilege consent, explicit calendar selection, incremental sync tokens, deterministic recurrence/cancellation handling, bounded expired-token full rebuild, typed reauthorization state, durable runs/recovery, 30-minute reconciliation, freshness observations, and per-resource audiences | Google Auth Platform verification remains an operational release gate |
| Google Drive | Workspace subsystem with least-privilege consent, recursive folder selection, deterministic overlapping-root ownership, canonical per-file identity, Google Docs/text/PDF extraction, honest metadata-only fallbacks, complete-snapshot stale cleanup, durable runs/recovery, 30-minute reconciliation, freshness observations, and per-resource audiences | Provider ACLs are deliberately not mirrored; administrators choose the Erik audience explicitly |
| Context | Provider/capability/connection/resource identity, provenance, durable indexing, citations, enforced `company`/`restricted` envelopes, and provider-to-context/search freshness samples | Provider ACLs are deliberately not projected; the selected Erik resource remains the governing access boundary |
| Approval | Named approver, effect digest, execution lease, audit, retry and unknown-outcome states; immutable typed registry for `task.create`, `case.create`, `case.move`, and `mail.draft.create` | `mail.draft.create` is the only external executor; every other effect stays internal |
| Connector catalog | Working Odorik, Google Workspace (Calendar, Drive, Gmail read, Gmail draft write), GitHub, and isolated Grok subscription entries are shown | Sending mail is deliberately absent; the human sends from the mailbox that owns the draft |

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
| C3 | Add durable sync runs, leases, retries, replay, and useful health | Completed | Failures are recoverable and freshness is measurable |
| C4 | Make resource audiences and retrieval access explicit | Completed | Accepted in test production |
| C5 | Harden the Calendar and Drive subsystems of Google Workspace | Completed | Accepted in test production |
| G1 | Add selected-label Gmail evidence to Google Workspace | Completed | Accepted in test production (dogfood + unit suite) |
| G2 | Produce an exact, non-executing email-draft proposal | Completed | Proposal is useful without any provider write |
| G3 | Create a Gmail draft after approval and reconcile the result | Completed | Accepted in test production (dogfood create + unit suite) |
| M1 | Establish one Microsoft 365 account connection and scoped Outlook mail evidence | Gated | Microsoft decision gate passes |
| M2 | Prove `mail.draft.create` through Outlook | Gated | Same workflow needs no provider-specific semantics |
| M3+ | Add one Microsoft resource family per slice | Gated | Calendar/files demand chooses the next family |
| A1 | Ingest selected meeting artifacts | Gated | Artifact demand and provider access are proven |
| R1 | Add one specialist system-of-record connector | Gated | One provider wins the scorecard |
| H1 | Post pending-approval notifications to one selected Slack channel | In progress | Gate opened 2026-08-06; approvals are invisible until someone opens the app |
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

**Implementation status (2026-08-02):** C3A, C3B, and C3C are implemented and
accepted in test production. Calendar, Drive, and GitHub
manual, selection/enable, scheduled, and recovery paths now share durable
capability runs, distinct resource attempts, fenced resource leases, four
bounded attempts (one initial attempt plus 1/5/30-minute backoff), stale-run
recovery, truthful timestamps, and one provider-neutral operator replay action
in Sources. Drive reconciles its current direct-child contract, and GitHub
polling health remains separate from webhook delivery health. Concurrent sync
requests coalesce without losing a newly selected resource. The schema is
additive and retains legacy sync fields as read fallbacks. The
Firestore-to-Qdrant plane now records deterministic per-record deliveries,
generation-fenced leases, bounded retry, stale-lease recovery, terminal
attention, targeted replay, one-time existing-record backfill, and measured
context-to-search p95. Provider reconciliation and search-index health remain
separate. C3 is complete; the next implementation slice is C4.

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

Implementation checkpoint (2026-08-02): resource audiences, normalized access
projection, member-aware Firestore and Qdrant retrieval, authoritative
post-search authorization, case-evidence filtering, lifecycle removal, Sources
editing with access-expansion confirmation, and private per-member agent chats
are implemented and covered by local isolation tests. Existing resources
default to company visibility. `npm --prefix functions run
migrate:resource-audiences -- --apply` persists that compatibility default and
re-enqueues changed context through the durable index-delivery path. The
test-production acceptance record below closes this checkpoint.

### C5 — Harden Google Workspace Calendar and Drive

**Usable outcome:** the Calendar and Drive subsystems of Google Workspace are
dependable enough to be the foundation for Gmail rather than permanent
prototypes.

**Planning checkpoint (2026-08-02):** C5 starts from deployed and accepted C4
commit `93572dd`. The C4 audience migration has already been applied in test
production. C5 must not invoke it again. Any C5 data rewrite first records the
target connection, resources, audience revisions, context counts, and pending
index deliveries, then uses normal fenced reconciliation rather than a blanket
migration.

#### C5 invariants and contract decisions

- Keep the existing Google OAuth scopes, one Workspace connection, explicit
  resource selection, 30-minute polling, C3 durable runs, and C4 application
  audiences. C5 adds no provider write grant, webhook, Gmail data, or provider
  ACL claim.
- A cursor or enumeration result is committed only by the resource lease that
  observed it. A failed or incomplete enumeration may upsert observations but
  may not perform stale deletion, advance the cursor, or report reconciliation
  success.
- Every Calendar event instance has one context item per Workspace connection,
  calendar, and Google event ID. Every Drive provider file has one context item
  per Workspace connection and document capability, independent of how many
  selected roots cover it.
- `source.resourceId`, `access`, and `accessRevision` always come from the
  selected resource that currently owns the item. Synchronization, token
  recovery, metadata refresh, and reauthorization never replace an existing
  resource audience with a default.
- New Calendar and Drive resources continue to default to company visibility
  for C4 compatibility. A resource audience is changed only through the C4
  audience action. Drive selection changes that would transfer existing items
  to a broader root audience require the same second explicit confirmation.
- Unsupported Drive binaries are searchable only by honest metadata. A
  supported extraction failure is actionable and prevents the affected root
  from claiming a successful reconciliation.
- Firestore remains authoritative. All C5 writes and deletes use the existing
  durable index-delivery path; C5 does not write Qdrant directly.

Drive overlap has one deterministic ownership rule. The closest selected
ancestor folder owns a file; ties are resolved by internal resource ID. A
selected descendant is therefore a traversal boundary for its parent. If the
descendant is disabled, it remains an exclusion boundary so disabling a
restricted child cannot make its files reappear through a broader parent.
This gives each file exactly one `source.resourceId`, lets a more-specific root
carry a more-specific C4 audience, and keeps resource counts additive. Moving a
file to another selected root applies that destination root's explicit
audience. Deselecting an overlap that would expose retained files to a broader
ancestor is confirmation-protected.

Calendar event identity continues to use Google's per-calendar event ID. For a
recurring instance, `recurringEventId`, `originalStartTime`, and `iCalUID` are
retained as recurrence metadata rather than substituted for the event ID.
This matches Google's expanded-instance model and lets a cancelled occurrence
delete exactly its prior context item.

#### C5 execution plan

##### C5.0 — Confirm the deployed starting state

Before changing code or provider data:

1. Record the deployed commit and function revisions, Scheduler job state,
   selected Calendar/Drive resources, each resource audience and revision,
   item counts, capability health, last successful/reconciled timestamps, and
   search-index health.
2. Confirm that the accepted C4 fixture is enabled and company-visible, and
   that search is settled at the expected tracked/expected count with no
   pending or attention deliveries. Do not run
   `migrate:resource-audiences`, including as an acceptance shortcut.
3. Run one no-provider-change manual Calendar sync and one Drive sync. Verify
   that both use durable runs, preserve counts and audiences, produce no
   duplicates, advance reconciliation timestamps, and leave search healthy.
4. Confirm one current Calendar citation and one current Drive citation from
   the deployed account. Inspect recent Calendar, Drive, API, index-delivery,
   and recovery logs for errors.
5. Record any difference between this observation and `CONNECTORS.md` before
   implementation. `CONNECTORS.md` remains a description of deployed behavior
   and is updated only after C5 deployment succeeds.

This checkpoint is read-mostly and uses the already connected account. Any
disposable Calendar, folder, or document needed for later mutation scenarios
is created only after the baseline is recorded.

##### C5.1 — Typed Google failure and authorization recovery

Replace status-code string matching with a sanitized Google provider error
that retains HTTP status, provider reason, retryability, and whether the
failure concerns the account credential, capability grant, or one selected
resource. Use it consistently for token refresh, Calendar, Drive listing,
export, and download.

Classification rules:

- timeouts, network failures, `408`, `429`, and `5xx` are transient and use the
  C3 bounded retry schedule, honoring `Retry-After` where available;
- Calendar `410 fullSyncRequired` is cursor recovery, not a provider failure;
- refresh-token `invalid_grant`, or a provider `401` that still fails after one
  forced refresh, is `reauthorization_required` and must not retry forever;
- a missing required capability scope is reauthorization for that capability;
  other enabled capabilities continue when the credential itself remains
  valid; and
- a selected calendar/folder becoming inaccessible is permanent resource
  attention, not falsely classified as global reauthorization.

Marking and clearing reauthorization state must use the injected Firestore
dependency, preserve resources, audiences, context, and cursors, and never log
tokens or provider payloads. Same-account reauthorization restores the
affected capability and queues reconciliation of its existing enabled
resources. Choosing another Google identity continues to fail closed.

##### C5.2 — Calendar incremental and recurrence hardening

- Keep `showDeleted=true` and `singleEvents=true` identical across the initial
  and incremental request sequence. Persist a new sync token only from the
  final page after every page has succeeded.
- Normalize and compare event content so a replay is a no-op, `changes` is an
  actual stored create/update/delete count, deep links and provider versions
  remain stable, and an audience/source revision difference is never skipped
  merely because the Google event version is unchanged.
- Retain `originalStartTime`, recurrence owner, sequence, event type, and
  cancellation metadata needed to distinguish a series, an expanded
  occurrence, and an overridden occurrence. A cancelled one-off or occurrence
  deletes the deterministic instance item.
- On `410`, transactionally mark the resource as requiring a full sync, clear
  the obsolete cursor under the current fence, and perform one bounded full
  rebuild from the existing one-year lower boundary. Collect the complete
  observed identity set; only after all pages succeed, remove old resource
  items not in that set, store the replacement token, and clear the rebuild
  flag. A failed rebuild retains attention/full-sync-required state and does
  not perform stale deletion.
- Apply the same complete-snapshot stale reconciliation to initial and forced
  full syncs so expired-token recovery removes cancelled, deleted, or now
  out-of-bound items instead of only overlaying the old store.
- Keep every page write, cancellation, stale deletion, cursor change, and
  audience copy behind C3 connection/resource lifecycle and lease fencing.

##### C5.3 — Recursive Drive reconciliation and one-file identity

- Change the Drive capability's declared sync mode from the obsolete `manual`
  label to `reconcile`; manual requests remain one trigger of the scheduled
  full-reconciliation contract.
- Enumerate each enabled root breadth-first through all descendant folders,
  with paginated `files.list`, visited-folder cycle protection, shared-drive
  request flags, and explicit item/page/depth/time limits. Treat an incomplete
  Drive search or a limit breach as attention and do not stale-delete.
- Snapshot a capability `selectionRevision` into the run's coverage plan.
  Increment it when roots are selected, deselected, enabled, disabled, or
  deleted. Every write verifies that revision; a concurrent selection change
  invalidates the attempt and coalesces one successor run.
- Include enabled and disabled selected descendants in the coverage plan.
  Enabled descendants own their subtree; disabled descendants are exclusion
  boundaries. Process roots in deterministic ancestor-before-descendant order.
- Treat resource existence as selected independently of enabled/disabled
  lifecycle. The folder picker must show a paused selected root as paused and
  must not silently deselect it when another selection is saved.
- Change Drive context identity to a canonical hash of connection,
  `context.document.read`, and provider file ID. `source.resourceId` names the
  deterministic owning root and may change without changing the context item
  ID. During the first successful C5 reconciliation, replace old
  root-scoped IDs and delete legacy duplicates through fenced, conditional
  writes; no standalone C4 migration is used.
- Before stale deletion, finish the complete traversal and extraction pass.
  Re-read a candidate in the deletion transaction and delete it only if it is
  still owned by that resource and selection revision. This prevents a parent
  cleanup from deleting a context item just reassigned to a child root.
- Reconcile file create, content update, rename, move within a root, transfer
  between selected roots, move outside all selected roots, trash, provider
  deletion, root disable/re-enable, and root deselection. Query stored context
  after reconciliation for each root's `itemCount`; never derive the public
  count from the latest page or add overlapping root counts.
- Have the folder-selection endpoint preview ownership/access impact. If an
  existing item would transfer to a broader audience, return a stable
  confirmation requirement and make Sources submit the exact selection a
  second time with the expected selection revision. Narrowing and no-op
  changes need no extra confirmation.

##### C5.4 — Drive extraction and honest document metadata

Use one extraction result contract for every file:

```text
contentMode: extracted | metadata_only
extractionKind: google_doc | text | pdf | unsupported
extractionStatus: succeeded | no_embedded_text | unsupported | policy_limited
contentFormat: markdown | plain_text | metadata
mimeType, providerModifiedAt, size, sourceUrl
```

- Continue exporting Google Docs as plain text and downloading text/Markdown
  blobs. Add bounded PDF download and prefer semantic Markdown conversion with
  an exactly pinned `@pdf2md/core` version. Retain textual headings, lists,
  tables, links, and page/section boundaries when the converter reconstructs
  them; do not retain base64 page renders or image-only Markdown as searchable
  content. Keep the existing 50,000-character text ceiling and define
  byte/page/time limits before enabling production parsing.
- Gate `@pdf2md/core` on a Node 22/Cloud Functions fixture spike covering
  headings, lists, tables, multiple columns, Czech text, malformed input,
  memory, timeout, deterministic output, and package/license review. If it
  fails that gate, use `unpdf` plain-text extraction behind the same result
  contract rather than weakening reconciliation or labeling.
- A text-bearing PDF is `extracted`. An image-only PDF is honest
  `metadata_only/no_embedded_text`. A file beyond a declared safety limit is
  `metadata_only/policy_limited`. A malformed, encrypted, forbidden, or failed
  download of a file within the supported contract is an actionable extraction
  failure and prevents successful stale reconciliation for that root.
- Unsupported binaries retain only filename, MIME type, description, size,
  modified time, and provider deep link. Their searchable text explicitly says
  metadata only and must never imply that binary content was read.
- Content comparison includes provider version, owning resource, C4 access and
  revision, extraction contract/version, title, and deep link. A content no-op
  does not rewrite the item; an audience or ownership transition does.

##### C5.5 — Freshness and operator truth

- Add adapter observation metadata containing run ID, trigger, observed time,
  provider update time, and provider version. Initial historical imports are
  excluded from freshness samples. After a resource has a prior successful
  reconciliation, a newly observed provider version is eligible.
- Extend durable index delivery to sample a provider version once, even if an
  audience projection later re-indexes it. Store provider-to-context,
  context-to-search, and end-to-end source-to-search durations without mixing
  Calendar/Drive polling latency with historical backfill.
- Aggregate freshness by provider, capability, and run trigger. Sources shows
  Calendar and Drive scheduled sample size and p95 source-to-search latency
  separately from the existing context-to-search metric. The scheduled target
  is below 45 minutes; manual acceptance changes must become searchable within
  two minutes. The existing 75-minute stale threshold remains a separate
  missed-poll health boundary.
- Show recursive-root semantics, overlap ownership, extraction mode/counts,
  metadata-only counts, reauthorization, and actionable resource errors
  truthfully. A healthy connector cannot hide a failed root or unsettled search
  delivery.

##### C5.6 — Automated verification

Add provider-adapter integration tests around real request/response shapes and
the Firestore harness, plus focused public-contract and UI tests.

Calendar cases:

- paginated initial sync, paginated incremental update, no-op replay, one-off
  cancellation, recurring series expansion, overridden occurrence,
  single-occurrence cancellation, series change, and full series deletion;
- `410` on an old cursor, successful full rebuild, failed rebuild without stale
  deletion, and replacement-token commit only after the final page;
- preserved deep link, source version, resource audience, audience revision,
  lifecycle fencing, and stored count; and
- transient refresh/API failure, bounded retry, invalid grant, provider `401`,
  incomplete grant, resource access loss, same-account reauthorization, and
  recovery without duplicate context.

Drive cases:

- paginated recursion, nested folders, traversal cycle/limit protection,
  parent-plus-child overlap, disabled-child exclusion, deterministic owner,
  canonical per-file identity, and zero duplicate active items;
- Google Doc, text, Markdown, text PDF, image-only PDF, policy-limited PDF,
  structured Markdown PDF, multi-column/table PDF, malformed supported file,
  and unsupported binary labeling;
- create/update/rename, move within one root, move between roots with different
  audiences, move out, trash, delete, disable/re-enable, deselect, and
  confirmation-protected audience broadening;
- partial enumeration or extraction failure without stale deletion, transient
  retry, terminal attention, operator replay, concurrent selection revision,
  lifecycle invalidation, and idempotent scheduled reconciliation; and
- C4 enforcement for restricted create, update, ownership change, deletion,
  re-index, exact lookup, hybrid search, and citation paths.

The complete shared, Functions, and frontend suites, production builds,
Firestore index validation, and a dependency/security review for the PDF
converter/parser must pass before deployment.

##### C5.7 — Rollout and real-account acceptance

Roll out additively: required indexes/configuration first, then backend workers
and API, then Sources. Increase Drive worker memory or timeout only from a
measured PDF/recursive fixture. Do not run the C4 migration. Before the first
C5 reconciliation, capture exact Drive legacy/canonical target counts and
audience revisions. After each rollout step, wait for durable index delivery to
settle before judging search.

Calendar acceptance on a disposable selected calendar:

1. Restrict its C4 audience, then create and update a one-off event; create a
   short recurring series, override one occurrence, cancel another, change the
   series, and leave one final event imported. At each step verify deterministic
   counts, metadata, citation/deep link, allowed/denied member retrieval, and no
   active duplicate.
2. Delete that final event at Google, then use a narrowly scoped acceptance
   harness to replace only the disposable resource's sync token with a known
   invalid token, keeping a record of its audience and revision. Manual sync
   must take the typed `410` full-rebuild path, remove the now-stale real event
   observation, obtain a new token, and preserve the audience and revision.
3. Create one final event immediately after a successful scheduled poll and let
   the next real Scheduler cycle ingest it. Record provider mutation,
   Firestore observation, and searchable timestamps for the polling sample.

Drive acceptance beneath a disposable subtree of the existing selected test
folder:

1. Create nested parent/child folders and select both. Give the child a
   restricted audience, then create a Google Doc, Markdown/text file,
   text-bearing PDF, image-only PDF, and unsupported binary below it. Verify
   recursion, one canonical item per file, child ownership/access, extracted
   answers, honest metadata-only labeling, citations, and deep links.
2. Update and rename content, move a file within the child, move it between the
   child and parent, move it outside all selected roots, restore it, trash it,
   and reconcile. Verify destination-root access, no stale retrieval, correct
   stored counts, and zero duplicates after every complete run.
3. Disable and re-enable the child root to prove the broader parent cannot
   resurrect it. Attempt to deselect the restricted child beneath the broader
   parent and verify the second-confirmation contract before accepting the
   transfer. Restore the intended final selection and audiences.
4. Create one final nested document after a successful scheduled poll and use
   the real Scheduler cycle to record a Drive source-to-search sample.

Finally, revoke the test Google grant in a controlled window with the account
owner present for the unverified-app handoff. The next sync must classify
reauthorization without a retry loop or data/audience loss. Reauthorize the
same identity and verify both capabilities recover and reconcile. Ask one
allowed member a cited question spanning an existing call, the disposable
event, and the extracted document; verify a disallowed member cannot retrieve
the restricted event/document. Settle Sources and search health, inspect recent
deployed logs, clean up or retain disposable provider evidence deliberately,
restore fixture state, and add a dated C5 progress entry before changing the
roadmap status to completed.

Calendar:

- retain incremental sync-token and cancellation behavior;
- reconcile scheduled and recurring events deterministically;
- preserve deep links and source versions;
- classify reauthorization separately from transient provider failure; and
- measure the polling freshness target.

Drive:

- extend the scheduled direct-child reconciliation established in C3B to
  recursive selected-folder behavior;
- prevent overlapping selected parent/child roots from creating duplicate
  context;
- extract supported Google Docs, plain text/Markdown, and PDF text;
- treat unsupported binary files as metadata and a deep link, not fake text
  extraction;
- preserve C3B deletion/move cleanup across recursive and overlapping roots;
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
- connection health remains correct through token expiry and recovery;
- zero active duplicate Drive context exists for one provider file within the
  Workspace connection;
- every Calendar/Drive ingestion, update, ownership transfer, deletion, and
  re-index preserves the governing C4 audience and fails closed while stale;
- manual changes are searchable within two minutes and measured scheduled p95
  source-to-search freshness is below 45 minutes; and
- the agent answers a cited question spanning one call, event, and document.

## Gmail slices

### G1 — Scoped Gmail subsystem

**Usable outcome:** a member can ask Erik about relevant email without giving
the whole company an invisible mailbox import.

#### G1 verification decision — 2026-08-03

Neither a CASA security assessment nor a Workspace-Internal app is planned. The
OAuth app therefore stays External with a **Testing** publishing status, which caps
it at 100 test users and expires every refresh token seven days after consent.
Three facts make that a cost rather than a blocker:

- **Gmail adds no new gate.** `drive.readonly` is already a Google *restricted*
  scope, so restricted-scope verification has applied since C1. `gmail.readonly`
  joins an existing gate instead of creating one, and the ceiling it implies —
  dogfood and design partners, no general availability — is already today's ceiling.
- **Gmail costs no extra re-consent.** One connection holds one credential envelope,
  so the reconnect Calendar and Drive already need weekly restores mail in the same
  pass. Frequency is unchanged; only what is restored grows.
- **The failure is already modeled.** C5.1's typed reauthorization moves the
  capability to `reauthorization_required` while preserving resources, audiences,
  and cursors, with no retry loop.

The design consequence is that weekly re-consent is a normal operating condition,
not an exception. Two things follow, and both are implemented: one consent restores
every enabled service, and mail sync treats an expired cursor as a primary path.

#### G1 contract decisions

- **The mail grant is mailbox-wide.** Google publishes no label-scoped read scope;
  `gmail.metadata` is also restricted and omits bodies, so it cannot answer a cited
  question. Label selection is therefore an application boundary over a full-mailbox
  grant, and the Sources card says exactly that rather than implying Google scoped
  the token. This is the same honesty rule C1 applied to account-level revocation.
- **Push is deferred.** A Gmail `watch` expires in seven days and the credential
  expires weekly regardless, so push would add Pub/Sub infrastructure and failure
  modes while inheriting the same latency floor. Polling reuses the C3/C5 runtime,
  consistent with C3's "push comes only after polling and reconciliation are
  correct."
- **Mail defaults to restricted.** A new label resource is visible to the connecting
  member only, deliberately diverging from the company-visible Calendar/Drive
  default. Broadening goes through the existing confirmation-protected C4 action.
- **One item per message.** Context identity hashes connection and Gmail message ID,
  so a message under two selected labels is one observation whose `source.resourceId`
  names its owning label, mirroring the C5 Drive ownership rule.

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
- scheduled reconciliation on the existing 30-minute cadence, with an expired
  `historyId` triggering a complete bounded rebuild rather than a partial overlay
  (push notifications and watch renewal are deferred, see the contract decisions
  above); and
- message deletion/label-removal behavior consistent with the selected scope.

**Implementation status (2026-08-04):** implemented, unit-tested, and accepted in
test production via real-account dogfood (selected-label ingest + agent answers).
Citation presentation was corrected so `context.mail.read_scoped` maps to adapter
`gmail` with the Gmail deep link (live Firestore re-derivation also covers stale
index metadata that had `adapterId: "google"`). The capability, scope planning,
and grant state reuse the generic Workspace machinery unchanged.
`functions/src/connectors/google-gmail.ts` carries label discovery and selection,
the 90-day bounded import, `historyId` incremental sync, expired-cursor rebuild
with complete-snapshot stale reconciliation, and label-removal cleanup.
`syncMailSources` and `recoverMailSourceSyncs` join the C3 durable-run and replay
contract, and Sources offers mail as a Workspace service with a label picker and
the mailbox-wide disclosure. Reconnecting now re-requests every service still
enabled on the connection, closing a latent defect where consenting to one service
replaced the shared credential envelope without the others' scopes; the OAuth
callback also validated capability IDs against a hardcoded pair, silently dropping
any third.

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

**Gate status — 2026-08-06:** opened by product decision for Slack. No external
design partner is named; the operating loop it serves is Erik's own. Every
external effect in the product waits on a named approver, and nothing tells that
approver they are needed. Record this as the reason if the slice is later
questioned.

H2 may later ingest direct mentions or explicitly selected channels. It does
not ingest a whole company by default and does not promise complete history.

#### H1 — Outbound approval notification

**Usable outcome:** when an approval is waiting, the person who must decide sees
it in the chat tool they already have open, and one tap lands them on the
approval card.

Two contract decisions shape this slice.

**Delivery is a standing configuration, not a typed action.** Every other
external effect enters the action registry and takes a named approver. A
notification cannot: approving each notice about a pending approval is circular,
and the notice exists precisely because nobody has looked yet. The administrator
approves the *destination* once, when configuring it, and that recorded decision
authorizes every later delivery to it. `chat.message.post` is therefore **not**
registered as an action, and no agent or workflow can choose to send chat. Only
Erik's own approval lifecycle emits notifications, with content Erik composes
from records it already owns.

**The channel receives a pointer, not the payload.** The message carries the
action kind, the case or contact label, the named approver, and a deep link.
It never carries the draft body, the recipient address, transcript text, or
evidence. Erik's own access control then governs what the person actually sees
when they follow the link — a channel's membership is not an Erik audience and
must never be treated as one. For the same reason, approvals whose audience is
`restricted` do not notify a shared channel at all in this slice.

Build:

- a `slack` connector on the existing connection kernel: one workspace
  connection, encrypted bot credential, stable workspace/team identity;
- capability `action.chat.notify` (`chat:write`, `channels:read`), whose
  selected resources are the channels an administrator explicitly chose;
- Slack's own consent boundary as the outer bound: Erik can only post where the
  bot has been invited, so channel selection lists only those channels;
- notification emission on `approval_requested` for company-audience approvals,
  composed from the approval record;
- one delivery per approval per destination, keyed by an execution record like
  `mailDraftExecutions`, since `chat.postMessage` offers no dedupe key;
- stored result: channel id, message `ts`, and `chat.getPermalink` URL;
- the G3 outcome classification, unchanged: `succeeded`,
  `failed_safe_to_retry`, `outcome_unknown`, with a lookup that never reads a
  failed call as an absence;
- delivery state visible on the approval and in Sources, including a failed or
  unknown delivery; and
- disconnect that revokes the bot token and stops all delivery.

Known limits accepted for this slice:

- **The message names no subject.** Pointer-not-payload leaves "Approval waiting:
  Email draft — Tomáš Holas decides" and a link. A human-readable case or contact
  label would need a lookup whose own audience must then be checked, so it is a
  deliberate second step rather than a convenience taken now.
- **The link lands on the page, not the card.** There is no `/approvals/:id`
  route; approvals render inside `/cases/:id` and `/tasks`. The notification links
  to whichever of those actually holds the card. A per-approval route is worth
  adding, but inventing the URL before the route exists is the mistake `c06cde8`
  already made with Gmail links.

Not included:

- reading any Slack message, thread, mention, or reaction;
- replies, threading, interactive approve/reject buttons in Slack;
- direct messages or per-user routing;
- agent- or workflow-composed chat content;
- notification of anything other than a pending approval; or
- Teams, Google Chat, and Discord.

Exit criteria:

- a company with no chat connection behaves exactly as it does today;
- Erik cannot post to a channel the bot was never invited to, and cannot post to
  a channel the administrator did not select;
- one approval produces exactly one message per destination, including across
  retries and duplicate emission;
- a restricted-audience approval produces no message;
- no draft body, recipient, or transcript text appears in any posted message;
- a failed delivery is visible and retryable, and an unknown delivery is not
  blindly retried;
- disconnecting the workspace stops delivery and revokes the token; and
- an approval created from a real call reaches a real Slack channel in test
  production, and the deep link opens that approval.

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
- [Google Calendar event-list and recurrence semantics](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Google Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Google Drive file and folder search](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Google Drive download and export behavior](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
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

### 2026-08-02 — C3B implementation checkpoint

- **Implementation:** the C3A primitives now expose one shared adapter executor,
  due-run discovery, replay validation, and a coalesced successor for resource
  selections made during an active run. Calendar was moved onto that executor;
  Drive folders and GitHub repositories now use the same claim, fenced lease,
  bounded retry, terminal attention, aggregate-health, and replay semantics.
- **Drive:** selection, manual sync, 30-minute polling, five-minute recovery,
  direct-child stale deletion, actual change counting, and supported-text
  extraction failures are durable per folder. Recursive roots and PDF
  extraction remain C5.
- **GitHub:** manual sync, resource enable, 30-minute polling, five-minute
  recovery, actual issue change counting, and stale issue deletion are durable
  per repository. Webhook delivery remains independently idempotent and its
  health is not overwritten by polling. Transactional webhook mutations defer
  while polling holds the repository lease, closing the poll/event race without
  reporting a false webhook failure.
- **Verification:** adapter integration tests cover isolated transient failure,
  failed-resource-only retry, permanent Drive attention and replay, stale
  cleanup, idempotent reconciliation, webhook-health isolation, and active-run
  successor coalescing. The full redesign suite passes 121 tests: 11 shared
  workflow, 102 Functions, and 8 frontend tests; all production builds pass.
  Full test-production acceptance is still required.
- **Decision:** do not call C3 complete until C3B passes real Drive/GitHub
  acceptance and C3C makes Firestore-to-Qdrant delivery measurable and
  recoverable.

### 2026-08-02 — C3C implementation checkpoint

- **Implementation:** every allowlisted direct company-record write now
  creates or advances one deterministic `knowledgeIndexDeliveries` document.
  The existing `syncKnowledgeIndex` trigger keeps its deployed identity but
  durably queues before attempting Gemini embedding and Qdrant delivery.
  Workers always re-read Firestore, and a generation arriving during an active
  attempt becomes a fenced successor rather than being silently absorbed.
- **Recovery:** transient failures retry after 1, 5, and 30 minutes; permanent
  or fourth-attempt failures enter attention. A private five-minute worker
  reclaims due retries, queued work left by an interrupted trigger, and expired
  leases. Administrators can replay only a tenant-owned attention delivery.
  Successful deletion deliveries retain short-lived audit state and then use
  Firestore TTL.
- **Observability:** Sources has a separate search-index card with current
  tracked/expected records, pending and attention counts, last success, p95
  context-to-search delay, the oldest outstanding delivery, one-time backfill
  for pre-C3C records, and targeted replay. Connector freshness never marks
  Qdrant searchable and Qdrant outcomes never rewrite connector health.
- **Verification:** eight delivery-runtime scenarios cover duplicate and old
  events, existing-record backfill, transient recovery, bounded exhaustion,
  permanent attention and replay, active-generation successors, stale-lease
  fencing, deletion, recursive-trigger exclusion, and tenant-safe public
  status. The full local suite passes 129 tests: 11 shared workflow, 110
  Functions, and 8 frontend tests; production builds and index validation
  pass.
- **Decision:** deploy indexes and TTL configuration before Functions, queue
  the existing-record backfill once, then complete real create/update/disable/
  delete, retry/replay, scheduled recovery, and two-minute freshness
  acceptance before marking C3 complete or starting C4.

### 2026-08-02 — C3C test-production acceptance

- **Rollout:** deployed the six `knowledgeIndexDeliveries` composite indexes
  and `expiresAt` TTL before updating `api`, `syncKnowledgeIndex`, and
  `recoverKnowledgeIndexDeliveries`, then released the Sources frontend. All
  three Gen-2 functions are active on the `odorik-crm` service account, the
  five-minute Scheduler job is enabled with the same OIDC identity, all six
  indexes are ready, and TTL is active.
- **Backfill:** the administrator action queued all 501 existing expected
  records. Bounded recovery drained them in 50-record batches to 501/501
  tracked, zero pending, zero attention, and searchable health. Historical
  backfill deliveries correctly remained outside the freshness sample.
- **Live delivery:** an isolated context probe created and updated through the
  real Firestore trigger and Qdrant path on the first attempt. Measured
  context-to-search delay was 1,172 ms for create and 676 ms for update.
  Disabling the probe produced a zero-point Qdrant deletion; deleting its
  Firestore source produced the next fenced deletion generation and recorded
  TTL without leaving the source document behind.
- **Recovery and replay:** the isolated tombstone recovered from a due
  synthetic retry through the real Scheduler on attempt two. A synthetic
  attention state then appeared in Sources and the tenant-scoped administrator
  replay completed generation five, cleared attention, restored TTL, and
  measured 94,183 ms from the original source commit—inside the two-minute
  target.
- **Evidence:** the settled dashboard reported 501/501 tracked, zero pending,
  zero attention, and searchable health. Recent API, trigger, and recovery
  service logs contained no errors, and the deployed browser session contained
  no warnings or errors.
- **Decision:** C3C is accepted in test production. C3 remains open only for
  the separate real Drive/GitHub C3B acceptance scenarios; provider health and
  search-index health continue to be evaluated independently.

### 2026-08-02 — C3B test-production acceptance

- **Drive reconciliation:** a real Google Doc was created in the selected
  `test` folder, updated in place, moved outside the selected root, and then
  moved to Drive trash. Create and update advanced one normalized context item
  without duplication; the selected-folder count moved from one to two and
  returned to one after move-out. Qdrant delivery generations one and two
  upserted on their first attempts in 758 ms and 659 ms, and generation three
  deleted the moved-out item with zero points and no error.
- **GitHub reconciliation:** issue
  [#6](https://github.com/tomaash/elixir-play/issues/6) was created, updated,
  and closed in the connected `tomaash/elixir-play` repository. The repository
  count moved from two to three and stayed at three without duplication. The
  normalized item reflects the updated title, body, closure state, and cleanup
  comment; Qdrant generations one through three succeeded on their first
  attempts, with measured create and update delays of 690 ms and 667 ms.
- **Scheduled stability:** both deployed 30-minute Scheduler jobs were invoked
  for two complete cycles. All four requests returned HTTP 200. The second
  Drive and GitHub cycles were true no-ops: item and context counts stayed at
  1/1 and 3/3, `lastAttemptAt` and `lastSuccessAt` advanced together,
  `lastChangeObservedAt` did not move, and no health or error state drifted.
- **Recovery and replay:** synthetic due-retry states were injected only into
  the isolated, already completed acceptance runs so real credentials did not
  need to be broken. The deployed Drive and GitHub recovery Scheduler workers
  completed attempt two, cleared failed-resource and error state, and restored
  fresh capability and resource health. Synthetic terminal-attention states
  then appeared in the deployed Sources UI; each scoped administrator replay
  created a new successful `operator_replay` run while preserving its prior
  attention run as audit history.
- **Settled evidence:** Sources reported Calendar current with 341 items,
  Drive current with one selected-folder item, and GitHub current with three
  repository items. Search-index health was 502/502 tracked and expected, zero
  pending, zero attention, and within the two-minute freshness target. Recent
  sync and recovery service logs and the deployed browser console contained no
  errors or warnings.
- **Cleanup:** the disposable Drive document is in recoverable provider trash
  and will be permanently deleted by Google after 30 days. GitHub issue #6
  remains closed as inspectable acceptance evidence.
- **Decision:** C3B and the full C3 slice are accepted in test production.
  Continue to C4 permission-aware resources and context.

### 2026-08-02 — C4 test-production acceptance

- **Rollout and migration:** deployed Firestore rules and indexes, the CRM
  Functions, and both hosting targets. The compatibility migration completed
  for two companies, 18 resources, 360 normalized context items, nine calls,
  and 183 linked derived records. Existing Calendar, Drive, GitHub, and Odorik
  resources retained company-wide visibility.
- **Cross-member enforcement:** the isolated Odorik fixture was restricted to
  Josef, then to Tom. In both directions, the allowed member could retrieve the
  exact call through the contacts API and `get_company_record` with one
  citation, while another active member received no record or citation.
  Hybrid search omitted the exact fixture while Tom was excluded and returned
  it after Tom was added and the durable projection settled.
- **Lifecycle and UI:** Sources displayed the selected audience, required a
  second explicit confirmation before adding a member or restoring company
  visibility, and re-projected the source on every edit. Disabling the fixture
  immediately removed the exact call from direct APIs and agent lookup for
  both tested members and removed it from hybrid results after index delivery.
  The fixture was re-enabled and restored to company-wide access after the
  scenario.
- **Private chat:** two active members each had their own non-empty `chat_`
  thread list, with zero shared physical thread IDs. The deployed Ask UI also
  created a new member-owned chat and kept its messages private to that owner.
- **Tenant isolation:** automated repository and router tests cover identical
  member and record identifiers across companies. The second live company has
  no active membership, so a live cross-company identity could not be exercised
  without changing tenant membership; the production harness failed closed in
  that condition.
- **Settled evidence:** Sources finished searchable at 505/505 tracked and
  expected records, zero pending deliveries, zero intervention, and 16-second
  p95 context-to-search delay. All deployed composite indexes were ready, and
  recent API, projection, index, and workflow service logs contained no errors.
- **Decision:** C4 is accepted in test production. Continue to C5 Calendar and
  Drive hardening.

### 2026-08-02 — C5 test-production acceptance

- **Rollout:** pinned `@pdf2md/core` 0.3.0 and deployed the Calendar, Drive,
  OAuth/recovery, durable indexing, API, and Sources changes. The already
  applied C4 migration was not run again.
- **Calendar recurrence and recovery:** a real two-occurrence weekly series
  produced two deterministic instance records with `recurringEventId`,
  `originalStartTime`, `iCalUID`, event type, sequence, deep link, and the
  calendar's company audience. Cancelling one occurrence changed the stored
  count from two to one and removed only that instance. Agent search returned
  the remaining event with a citation. Replacing only the disposable selected
  resource's sync token with a known-invalid value exercised the live HTTP 410
  path: its attempt completed in `full` cursor mode, committed a replacement
  token, retained all 472 current observations, and left the capability fresh.
  Deleting the series then removed the final instance.
- **Drive recursion, Markdown, and ownership:** a text-bearing PDF placed in a
  nested folder beneath the selected `test` root was discovered recursively,
  converted to Markdown by `@pdf2md/core`, indexed, and returned by agent
  search with a Drive citation. Selecting the nested child as an overlapping
  root transferred ownership to that closest selected ancestor while the
  canonical provider-file record count stayed exactly one. Restoring the
  parent-only selection reassigned the same canonical item without broadening
  its company audience. Moving the disposable subtree to recoverable Drive
  trash reconciled the root from two items back to one and removed both exact
  lookup and search retrieval for the PDF.
- **Polling freshness:** Scheduler-triggered mutations produced one eligible
  sample per provider. Calendar measured 13.747 seconds source-to-context and
  14.904 seconds source-to-search. Drive measured 31.058 seconds
  source-to-context and 32.791 seconds source-to-search. Both were below the
  45-minute scheduled target and the two-minute acceptance target; both index
  deliveries succeeded on their first attempt. Scheduled cleanup then removed
  both disposable observations.
- **Audience and failure coverage:** every live C5 item retained its selected
  resource's company audience through create, recurrence cancellation,
  expired-token rebuild, overlapping-root transfer, deletion, and re-indexing.
  Automated adapter/runtime tests additionally cover restricted audiences,
  confirmation-protected broadening, lifecycle and selection-generation
  fences, paginated traversal, extraction and enumeration failures, retry,
  terminal resource attention, invalid grant, capability reauthorization, and
  recovery without stale deletion.
- **Cleanup and settled state:** the active Google fixtures were restored to
  only `České svátky` (341 company-visible Calendar items) and `test` (one
  company-visible Drive item, `Samikovo`). Disposable Calendar records were
  deleted and disposable Drive artifacts are in recoverable provider trash.
  Sources settled at 519/519 searchable records, zero pending deliveries, zero
  intervention, and 16-second p95 context-to-search delay.
- **Decision:** C5 is accepted in test production. The Gmail decision gate may
  now be evaluated; no Gmail scope or provider write capability was added by
  C5.

### 2026-08-04 — G1 test-production acceptance

- **Scope:** selected-label Gmail evidence on the existing Google Workspace
  connection (`context.mail.read_scoped`), plus citation presentation for mail.
- **Dogfood:** a real Workspace account enabled mail, selected a label, completed
  import, and the factual agent answered questions over the imported messages.
  Cross-source call + email usefulness was exercised informally in the live app.
- **Automated:** `gmail-sync` suite covers 90-day bound, restricted audience copy,
  label-loss removal, expired-`historyId` rebuild, and attachment-name-only
  extraction. Connector registry tests keep Gmail observe-only (`gmail.readonly`,
  no compose/send). Agent tests assert mail context items present as
  `adapterId: "gmail"` with `metadata.sourceUrl` as the deep link, including
  chunks written into the knowledge index path.
- **Citation fix shipped with acceptance:** capability
  `context.mail.read_scoped` maps to adapter `gmail` (not provider `"google"`).
  Search citations re-derive presentation from the authoritative Firestore
  record so pre-fix Qdrant points still open in Gmail without a forced full
  reindex.
- **Explicitly not claimed:** multi-member restricted-audience rejection in live
  prod was not re-run end-to-end for this log entry (unit/access contracts remain
  the proof); push/watch remains deferred; no draft or send scope was added.
- **Decision:** G1 is accepted. Proceed to G2 (exact non-executing
  `mail.draft.create` proposal only).

### 2026-08-04 — G2 non-executing mail draft proposal

- **Scope:** typed `mail.draft.create` proposal only — registry descriptor,
  workflow block, history/run parity via `proposedPayloads`, approval card and
  editor UI, contact email for recipient resolution. No Gmail write scope and
  no provider write call.
- **Contract:** `mailDraftCreateActionSchema` is the disclosed effect; digest
  covers every field that could reach Gmail. Default executor throws
  `MailDraftExecutionUnavailableError` so approval never reaches Google.
- **Skip reasons:** `recipient_missing`, `mailbox_unavailable`,
  `insufficient_context` (plus existing contact/target skips).
- **Automated:** `mail-draft` suite (descriptor, preconditions, evidence pin,
  digest sensitivity, preview/run payload identity); shared workflow suite
  (literal recipient, fail-closed, validation); action-registry includes
  `mail.draft.create` and still rejects `mail.send`. Scopes remain
  `gmail.readonly` only.
- **UI:** workflow mail block, approval card preview of subject/body/to/mailbox,
  contact email edit so contact-recipient drafts can resolve.
- **Decision:** G2 is accepted for ship. Proceed to G3 (executor +
  `action.mail.draft.create` capability grant + reconciliation).

### 2026-08-04 — G3 approval-gated Gmail draft creation

- **Scope:** separate Workspace capability `action.mail.draft.create`
  (`mail_draft` service, `gmail.compose` scope), production executor on
  `mail.draft.create`, Firestore idempotency + Message-ID marker, reconcile
  path for `outcome_unknown`, Sources grant UI, approval result + reconcile CTA.
- **Independent grants:** mail read (`gmail.readonly`) and draft write
  (`gmail.compose`) are separate capabilities; read-only cannot execute.
  Product never calls send even though compose can send at the provider.
- **Executor:** builds text/plain RFC822 with Erik Message-ID
  `<draftRequestId@erik-mail-draft.local>`, creates via `users.me/drafts`,
  stores `mailDraftExecutions/{draftRequestId}`; retries reuse stored success
  or find-by-rfc822msgid before creating again.
- **Automated:** connectors registry grant matrix; mail-draft preconditions
  require write grant; executor suite (MIME, missing grant, idempotent create,
  reconcile without create, `outcome_unknown` classification). Full functions
  + frontend suites green.
- **Not claimed in this log entry:** live dogfood of call → proposal → approve
  → open draft in Gmail (operator path after deploy).
- **Decision:** G3 implementation accepted for ship. Core epic G1–G3 code path
  complete pending dogfood.

### 2026-08-06 — G3 test-production acceptance and post-acceptance fixes

- **Dogfood:** a real Workspace account with mail read but no draft-write grant
  attempted an approval and was refused with the grant-missing message — the
  read/write independence exit criterion, observed live. The administrator then
  granted “Create Gmail drafts” (`gmail.compose`) from Sources, re-approved, and
  one draft was created in the connected mailbox.
- **Decision:** G3 is accepted. The core epic (C0–C5, G1–G3) is complete.
- **Explicitly not claimed:** rejection-makes-no-provider-call, non-approver
  rejection, live double-approve idempotency, and live `outcome_unknown`
  reconciliation were not re-exercised by hand for this entry. Their proofs are
  the unit contracts below, not production observation.
- **Three defects found reviewing the shipped path, now fixed:**
  1. **The idempotency lookup needed a scope the write grant does not include.**
     It searched `users.messages.list`, which requires a *read* scope; a
     connection holding only `gmail.compose` would get 403, and the caller read
     that as “no draft exists” and created a second one. The dogfood account has
     both grants, so this could not appear there. Now uses
     `users.drafts.list?q=rfc822msgid:`, which `gmail.compose` covers — and which
     returns the real draft id instead of substituting the message id.
  2. **A failed lookup was treated as a confirmed absence.** The lookup swallowed
     every error and returned `null`, so a transient Gmail failure during
     `outcome_unknown` recovery led straight to a second create, and the operator
     reconcile path told the user “safe to approve again” on the strength of a
     question Gmail never answered. Both now keep the outcome unknown. A failed
     lookup on a first attempt is still advisory, since nothing exists yet to
     duplicate.
  3. **The draft deep link used a fragment shape already withdrawn.** G3 emitted
     `#drafts/{apiMessageId}`, the same class of link `c06cde8` removed for
     citations because the Gmail web UI does not address messages by API id. The
     link now opens the Drafts list of the owning mailbox via `authuser`, which
     also fixes `/u/0` pointing at whichever account signed in first. Draft,
     message, and thread ids remain stored for operators.
- **Automated:** seven added cases cover the drafts-endpoint/scope contract, real
  draft id versus message id, empty list as absence versus failed list as error,
  no-second-draft after an unanswered lookup, create after a *confirmed* absence,
  first-attempt tolerance of a flaky pre-check, and the withdrawn link shape.
  Full functions suite green at 162.
