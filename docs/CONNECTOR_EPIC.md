# Connector epic: external context and approved effects

**Status:** core execution active

**Current implementation slice:** C1 — explicit source capabilities and grants

**Last code review:** 2026-07-30

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

Production currently serves as a test environment, but schema changes must
still be backward-compatible and reversible. A later slice may be reordered
when usage evidence warrants it; it may not silently absorb another slice.

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

- Calendar, Drive, and Gmail meet the shared source contract;
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
2. **Least privilege.** Read and write grants are separate. Adding a new
   capability never silently expands an existing grant.
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

The baseline was inspected in the repository on 2026-07-30.

| Area | Working now | Important limitation |
| --- | --- | --- |
| Connection kernel | Multiple connections, encrypted credentials, selected resources, disconnect, revoke/delete, health summary | Registry is provider-shaped and reduces capability to `readOnly` |
| Odorik | Authenticated call upload, phone-line resources, normalized context | Compatibility path and generic connection path coexist |
| Google Calendar | Explicit calendar selection, incremental sync tokens, cancellation deletion, 30-minute reconciliation | Imported items are company-visible; no measured freshness target |
| Google Drive | Explicit direct-folder selection, Google Docs/text extraction, manual sync | No scheduled sync, recursive selection, stale-file deletion, or PDF text extraction; normalized items use the provider folder ID while the resource document uses a hashed ID |
| Context | Provenance, source IDs, indexing, citations, `company`/`restricted` envelope | Google adapters always write `company`; provider ACLs are not projected |
| Approval | Named approver, effect digest, execution lease, audit, retry and unknown-outcome states | Dispatch is hard-coded to `task.create`, `case.create`, and `case.move` |
| Planned catalog | Gmail and GitHub cards | Planned cards imply commitments without a proven loop or demand gate |

The first slices protect and improve this baseline rather than immediately
adding another provider.

## Target connector contracts

An adapter ID remains an implementation routing detail. Product behavior is
declared through capabilities.

```ts
type ConnectorCapability = {
  kind: string
  direction: "observe" | "execute"
  resourceType?: string
  requiredGrant: string
  syncMode?: "webhook" | "incremental" | "reconcile"
  inputSchema?: unknown
  resultSchema?: unknown
  requiresApproval: boolean
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

A connection continues to represent one authorization grant for one external
account. It records provider identity, tenant identity where relevant, granted
scopes, declared capabilities, lifecycle, and sync health. Connections for the
same Google or Microsoft identity may be grouped visually, but their refresh
tokens and grants are not merged merely to create a tidier card. This preserves
least privilege and avoids a risky suite-account migration before it is needed.

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
| C1 | Replace `readOnly` with explicit source capabilities and grants | Next | Existing sources behave unchanged |
| C2 | Put internal actions behind an extensible typed action registry | Pending | Existing workflow approvals behave unchanged |
| C3 | Add durable sync runs, leases, retries, replay, and useful health | Pending | Failures are recoverable and freshness is measurable |
| C4 | Make resource audiences and retrieval access explicit | Pending | Restricted-source isolation tests pass |
| C5 | Bring Calendar and Drive fully onto the hardened contract | Pending | Real accounts meet source acceptance scenarios |
| G1 | Read and cite email from selected Gmail labels | Pending | Cross-source call + email answer succeeds |
| G2 | Produce an exact, non-executing email-draft proposal | Pending | Proposal is useful without any provider write |
| G3 | Create a Gmail draft after approval and reconcile the result | Pending | Core epic acceptance scenario succeeds |
| M1 | Prove the same mail-read capability through Microsoft Graph | Gated | Microsoft decision gate passes |
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

### C1 — Explicit source capabilities and grants

**Usable outcome:** an administrator can see what each connection can observe,
which provider grants enable it, and which resources are included.

Build:

- replace the `readOnly` descriptor with declared observe/execute
  capabilities;
- persist normalized provider, account, scopes, and capability grants;
- make `source.resourceId` consistently reference the resource document ID,
  retaining provider identity only in `externalId`, and migrate existing Drive
  context safely;
- infer backward-compatible grants for existing Odorik, Calendar, and Drive
  records;
- show capability, account, selection, and reauthorization state in Sources;
- retain separate Calendar and Drive authorization grants even when their
  account label matches; and
- remove uncommitted planned provider cards from the primary catalog. A
  connector request surface may replace them later.

Not included:

- provider actions;
- combining Google OAuth grants;
- Microsoft accounts; or
- new workflow blocks.

Exit criteria:

- existing connections need no manual repair;
- the public API contains no credential material;
- every active resource maps to one declared observe capability; and
- Calendar, Drive, and Odorik behavior is unchanged.

### C2 — Typed action capability registry

**Usable outcome:** the approval kernel can add an external executor without
turning into a growing provider-specific conditional.

Build:

- register action kind, schema, authorization class, executor, result schema,
  reversibility, and reconciliation support in one application-owned registry;
- move `task.create`, `case.create`, and `case.move` behind the registry without
  changing their workflow schemas;
- keep the existing canonical effect digest and named approver contract;
- make the approval executor dispatch only registered action kinds;
- require external action registrations to declare a separate grant and
  reconciliation strategy; and
- reject unknown action kinds before an approval record can be created.

Not included:

- an external executor;
- a generic connector action;
- approval policy rules; or
- autonomous actions.

Exit criteria:

- all existing workflow and approval tests pass unchanged;
- duplicate approvals still produce exactly one internal effect;
- stale case movements still fail closed; and
- a test-only external action cannot execute without a named approval.

### C3 — Durable synchronization and operator recovery

**Usable outcome:** an administrator can distinguish fresh, stale, failed, and
recovering sources and can safely replay a failed resource.

Build:

- durable per-resource sync runs with trigger, cursor, attempt, counts, timing,
  outcome, and sanitized error;
- a lease that prevents concurrent runs for the same resource;
- separate `lastAttemptAt`, `lastSuccessAt`, `lastChangeObservedAt`, and
  `lastReconciledAt` semantics;
- bounded retry with backoff, then a visible dead-letter/attention state;
- replay from the Sources screen;
- continue syncing healthy resources when one resource fails;
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
- the Sources screen reports truthful times and state.

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

### C5 — Harden Google Calendar and Drive

**Usable outcome:** the existing Google sources are dependable enough to be the
foundation for Gmail rather than permanent prototypes.

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
  connection.

Push notifications may later improve latency, but they are not an excuse to
skip reconciliation. OAuth verification is an operational release gate before
general customer authorization.

Exit criteria:

- real Calendar and Drive accounts pass create/update/delete/move/deselect
  scenarios;
- extracted and metadata-only documents are labeled honestly;
- connection health remains correct through token expiry and recovery; and
- the agent answers a cited question spanning one call, event, and document.

## Gmail slices

### G1 — Scoped Gmail evidence

**Usable outcome:** a member can ask Erik about relevant email without giving
the whole company an invisible mailbox import.

Build:

- a separate Gmail authorization using only the scopes required by this slice;
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

- a separately authorized `action.mail.draft.create` grant;
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

Execute one resource family per slice:

1. **M1:** Microsoft identity/tenant authorization plus selected Outlook mail
   folders implementing `context.mail.read_scoped`.
2. **M2:** Outlook implementation of the same approved
   `action.mail.draft.create` contract.
3. **M3+:** choose Outlook Calendar or SharePoint/OneDrive from observed demand,
   then implement one before considering the other.

The proof is provider neutrality: the workflow and approval semantics do not
change, while grants, cursors, IDs, reconciliation, and deep links remain
provider-specific.

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

- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Google Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Google Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Microsoft Graph Outlook mail API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview)
- [Microsoft Graph calendar delta query](https://learn.microsoft.com/en-us/graph/delta-query-events)
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
  company-wide. C1 and C4 own those changes respectively.
- **Decision:** C0 passed. Continue to C1.
