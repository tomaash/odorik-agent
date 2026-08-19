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

## Current product position — 2026-08-17

The repository has proved more of the kernel than the historical numbering
below suggests:

- permission-aware Calendar, Drive, Gmail, Outlook, Odorik, and GitHub evidence use one
  source and retrieval contract;
- private member-owned agent threads, hybrid search, exact tools, citations,
  durable index delivery, and factual-agent run traces are implemented;
- typed task, case, case-movement, and provider-neutral mail-draft effects share the mandatory
  approval and execution kernel;
- approval-gated Gmail draft creation has passed test-production acceptance;
- Slack workspace OAuth, channel selection, pointer-only approval delivery,
  delivery outcome classification, exact authenticated approval links, and
  operator recovery have passed automated and live test-production acceptance;
  H1 is complete; and
- Slack direct-message conversational correctness is deployed and accepted. It
  verifies Slack requests, links a Slack identity to an Erik member, routes
  before tools, persists inbound events first, serializes each DM, and records
  idempotent reply identities. Slice 9A adds bounded durable sessions and
  explicit memory controls; retrieval across older sessions remains 9B.
- Slice 10 is implemented and deployed. Automated acceptance is complete and
  live task acceptance passed on 2026-08-14; the Gmail live case is waiting only
  for the existing Google connection to be explicitly reauthorized. A linked
  private Slack DM can prepare either a fresh-evidence
  `task.create` proposal or a one-recipient `mail.draft.create` proposal. Exact
  Block Kit cards support approve, reject, and request changes. Every control is
  bound to workspace, Slack user, channel, message, named Erik member, proposal
  digest, action policy, and expiry. Requested changes close the old version and
  create a new immutable version from fresh evidence. Decisions on either the
  Erik page or Slack converge the Slack card to the canonical receipt; clicking
  a stale-but-untampered card is an idempotent success, not a conflicting second
  action. Slack still has no executor of its own.
- Gmail live acceptance is explicitly deferred while the existing Google
  connection requires reauthorization; it remains a named acceptance debt and
  does not block the Microsoft sequence.
- Slice 11 is implemented in code: tenant/member-bound Microsoft OAuth uses
  PKCE and validated OIDC identity, identity-only connection precedes separate
  Outlook grants, rotating refresh tokens replace encrypted credentials, and
  Sources exposes health, recovery, permissions, local capability controls,
  and disconnect. Outlook grants remain honestly `permission_granted` until
  Slice 12 supplies their operating loops.
  The registration now lives in the Agent Erik-controlled Entra tenant, has the
  canonical `/oauth/microsoft/callback` web redirect, and configures delegated
  `User.Read`, `Mail.Read`, and `Mail.ReadWrite` only. It accepts organizational
  and personal Microsoft accounts so development and dogfood are not blocked by
  a customer's app-registration policy. Customer-tenant consent policy remains
  authoritative whenever a customer identity is connected.
- Slice 12 is implemented, deployed, and accepted live as of 2026-08-18. Outlook Mail
  imports a fixed, member-restricted Inbox resource bounded to the last 90 days,
  then resumes from Graph's opaque delta link. Durable, replay-idempotent change
  notifications validate `clientState`, wake the same sync runtime, and renew
  before expiry; delta remains the ledger and rebuilds after an expired cursor.
  The existing one-recipient `mail.draft.create` envelope now routes through a
  provider adapter. Outlook uses create-message only, attaches a stable Erik
  request property for reconciliation, treats ambiguous outcomes as unknown,
  and has no send path or `Mail.Send` grant. Live acceptance imported and cited
  two messages from the connected personal mailbox, then prepared an exact
  Slack proposal and created one marked Outlook draft after approval. Graph
  confirmed the recipient, subject, text body, Drafts parent, `isDraft=true`,
  one unique Erik request marker, and zero matching Sent Items.
  Dogfood also caught a natural-language routing gap for “prepare … an email
  draft”; the corrected route is regression-tested and deployed.

The direct-message dogfood exposed a product-level defect: after a company
summary, the message “hello” was forced through a company search and produced
another version of the summary. The previous turns were loaded; the factual
loop's unconditional first-tool rule selected the wrong behavior for a social
turn. The prototype also has no per-conversation serialization, only eight
recent message documents, and no durable session memory. These are now explicit
roadmap requirements rather than prompt-tuning follow-ups.

### Priority decision after Slice 13

1. Treat the Microsoft identity, Outlook Mail, Outlook draft, and Outlook Calendar
   loops as one accepted Microsoft 365 foundation; harden them through normal use
   instead of adding broader mailbox or calendar permissions.
2. Build Teams personal conversation and decision parity next. Reuse the Slack
   conversation, proposal, approval, and receipt protocols rather than create a
   Teams-specific agent runtime.
3. Make cross-surface thread binding explicit, then measure coordination before
   adding initiative, Teams history ingestion, or shared-channel scope.
4. Keep SharePoint/OneDrive and calendar mutation behind observed-demand gates;
   neither is required to prove the next conversational surface.

Slice 9B older-session recall remains a deliberately deferred horizontal
capability. Pull it forward only if evaluations show that Microsoft dogfood is
blocked by returning after the six-hour session boundary. It must not delay the
Microsoft connector foundation merely to create more ambient memory.

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

- Private member-owned threads in the mobile-first **Agent** screen.
- Safe projections of calls, contacts, cases, tasks, normalized context items,
  and audit events.
- Four tools:
  - hybrid search;
  - exact record lookup;
  - filtered record listing; and
  - exact count/group aggregation.
- Bounded Gemini 3.5 Flash-Lite tool loop.
- Forced tool use on the first turn of the current factual endpoint. This is a
  grounding mechanism, not the correct router for a general conversation.
- Structured final answers with source-ID validation.
- Prompt-injection boundary: retrieved data is evidence, never instructions.
- Qdrant hybrid RAG with a stable temporary-unavailable response when the
  index cannot be reached.
- `gemini-embedding-2` dense retrieval at 1,536 dimensions.
- A single Qdrant `float16` dense representation without a second quantized
  copy or rescoring path.
- Durable per-record Qdrant delivery after Firestore writes, with generation
  fencing, bounded retry, stale-lease recovery, terminal attention, targeted
  replay, and measured context-to-search freshness.
- Qdrant indexing endpoint restricted to application administrators.
- Deterministic retrieval/unit evaluations plus optional live Gemini cases.
- Existing Intake, Requests, and Contacts remain available.

### Known limits

- The free Qdrant deployment is a single node without backup support.
- Firestore-to-Qdrant synchronization is eventually consistent. Its delivery
  queue and freshness metric are durable, but the two-minute target still
  requires test-production acceptance under real embedding and Qdrant load.
- Full reconciliation still deletes and rebuilds the target collection rather
  than building a shadow collection and switching an alias.
- Firestore projections and Qdrant operations enforce company and member source
  access. Permission behavior still needs ongoing adversarial and revocation
  evaluation as new sources are added.
- Member-owned thread creation and switching exist, but there is no ordered
  external event inbox, session lifecycle, summary, or long-term conversation
  retrieval.
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

## Slice 2: durable context index and ingestion contract — implemented

The index accepts company-scoped normalized `ContextItem` records. Existing
sources were backfilled into this contract and the generic Firestore-to-Qdrant
path is deployed. It now includes generation-fenced delivery leases, bounded
retry, stale-lease recovery, terminal attention, targeted operator replay,
one-time existing-record backfill, member eligibility, and measured
provider-to-context and context-to-search freshness.

Remaining hardening is no longer required to prove the kernel, but matters
before larger production scale:

- build a shadow collection and switch an alias for zero-downtime migrations;
- separate raw source records from derived chunks and embedding versions more
  explicitly;
- add corpus-size, freshness, missing-index, and access-revocation evaluations;
  and
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

## Slice 3b: Drive folder connector — implemented and hardened

The application reuses the connection/resource/context kernel for explicitly
selected Google Drive folders using `drive.readonly`. C5 added recursive folder
semantics, deterministic ownership for overlapping selected roots,
complete-snapshot stale cleanup, Google Docs/text/PDF extraction, honest
metadata-only fallbacks, durable recovery, scheduled reconciliation, freshness
observations, and permission-aware resource audiences. The slice passed
test-production acceptance on 2026-08-02.

## Slice 4: generic proposal and human-decision cards — kernel partially delivered

The current typed action approvals already bind a named approver, immutable
effect digest, execution attempt, result, and audit. Approve/reject and exact
task, case, case-movement, and Gmail-draft cards are implemented. What remains
is the broader proposal lifecycle originally intended by this slice:

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

Delivered by G2–G3 in `CONNECTOR_EPIC.md` and accepted in test production on
2026-08-06: the exact `mail.draft.create` proposal and approval-gated Gmail draft
creation behind a separate write grant, with reconciliation. Sending email
remains deferred by design — the human sends from the mailbox that owns the
draft.

A second write capability with a different business result — a calendar hold, or
a follow-up through a chosen call-centre channel — is no longer needed to prove
this slice. Add one only when a real workflow demands it.

- separate read and write grants;
- disclose the exact external effect on the proposal card;
- record approval before execution;
- implement provider-aware idempotency and reconciliation;
- surface `outcome_unknown` honestly; and
- provide an operator recovery path.

Exit criterion: a person can approve one external action and later prove what
was authorized and what the provider actually did.

## Next product sequence: from connector proof to operating relationship

The next roadmap is organized around one usable relationship with Erik, not
around accumulating providers. A later slice starts only after the previous
one passes both automated contracts and a real test-production scenario.

### Slice 7: finish H1 approval delivery

**Completed and accepted:** 2026-08-13. The normal install now requests only
`chat:write` and `channels:read`; `/approvals/:id` preserves the exact internal
route across login and re-authorizes the record on load. A real call-derived
pending task approval posted once to the selected `#all-headstart` channel. A
second delivery attempt posted zero messages, and the exact signed-in page
rendered the approval plus `Slack notification — Delivered`. Restricted-data,
ambiguous-outcome, retry, disabled destination, and disconnect/revocation
behavior remain covered by the full contract suite. The live workspace was not
destructively disconnected after acceptance.

**Usable outcome:** the named approver notices waiting work in a selected Slack
channel and one tap reaches the real decision surface.

- keep notification delivery separate from agent-authored chat actions;
- keep shared-channel content pointer-only and skip restricted approvals;
- finish atomic delivery claims, visible failure state, safe retry, disconnect
  revocation, and exact approval navigation;
- request only the notification scopes when direct conversation was not
  explicitly enabled; and
- dogfood one real call-derived approval through Slack.

Exit criterion: one real pending approval produces one safe message per selected
destination across duplicate trigger delivery, and disconnect stops further
delivery. Record the observation in `CONNECTOR_EPIC.md` before calling H1 done.

### Slice 8: conversational correctness in one Slack DM

**Completed and accepted:** 2026-08-13. Slack events now append to one durable
per-DM inbox, are ordered by provider timestamp plus event id, and drain under a
six-minute fenced lease after a short reorder window. Each inbound message is
persisted before generation; replies and runs use the Slack event id as their
stable identity and safe delivery retries reuse the stored reply. A deterministic
router separates `social`, `capability`, `company_fact`,
`contextual_followup`, and `action_request`; only the two factual routes can use
company tools. Late events are retained and flagged without moving the committed
cursor backward.

Test-production acceptance covered a greeting, grounded task count,
pronoun-based task-title follow-up, capability question, and rapid capability +
social messages. All five replies were visible once and in causal order. Run
traces showed zero tools for social/capability turns and two tools for both
factual turns.

**Usable outcome:** a linked member can hold a short, natural, read-only Slack
conversation without repeated, missing, duplicated, or reversed replies.

- introduce a turn router with explicit `social`, `capability`,
  `company_fact`, `contextual_followup`, and `action_request` modes;
- use no company tools for social/capability turns, require fresh evidence for
  factual modes, and keep action requests non-executing;
- persist each inbound event before generation and deduplicate on Slack event
  identity;
- serialize work with a per-conversation lease, fence stale workers, and process
  pending events by provider timestamp plus a stable tie-breaker;
- persist the chosen mode, context version, tool policy, and reply identity on
  every run; and
- keep direct-message access as an explicit capability independent of H1
  notification delivery.

Exit criterion: the acceptance conversation covers greeting, grounded company
question, pronoun-based follow-up, capability question, and two rapid messages;
the stored and visible order is causal and no answer repeats merely because a
tool call was forced.

### Slice 9A: bounded durable conversation sessions

**Completed and accepted:** 2026-08-13. Slack DM threads now use a
six-hour inactivity boundary and explicit `new topic` / `start fresh` controls.
Recent raw turns are assembled under a 6,000-token estimate rather than a fixed
message count. Each session stores versioned compact state with exact first and
last message IDs, discussed authorized records, unresolved questions, explicit
corrections, and conversation decisions. Every factual turn still uses fresh
authorized company tools; summaries cannot satisfy citations.

`what do you remember?` exposes the active state. `forget this conversation`
rotates a memory generation immediately; Slice 15B also redacts the older
provider payload and derived content so it cannot silently re-enter future
prompts. Session selection and state completion are idempotent
per inbound Slack message, and every run records the exact session, state
version, selected raw message IDs, estimated token use, and selected memory IDs.

**Usable outcome:** a person can continue one working discussion across a
normal break, inspect what Erik is carrying, and deliberately reset or forget
it.

Exit criterion: a real Slack discussion persists across a later follow-up,
`what do you remember?` reports only the current session, updated facts are
retrieved again, `start fresh` removes prior discussion state, and membership or
source revocation fails closed on the next turn.

Test production proved the open-task title, inspectable remembered record,
pronoun-based status follow-up with a fresh citation, explicit session reset,
generation-fenced forget, and empty post-forget inspection. Firestore recorded
three sessions, memory generation `1 → 2`, exact message selections, and fresh
tool traces for both factual turns. Automated acceptance is 204 Functions tests
and 22 frontend tests.

### Slice 9B: relevant older-session recall

**Usable outcome:** a person can return after hours or days and Erik remembers
the useful discussion state without confusing memory with current company
truth.

- retrieve older sessions by semantic, lexical, entity, and temporal relevance;
- re-fetch authoritative company evidence for every current factual claim;
- support explicit correction of derived older-session state; and
- rebuild or exclude older memories when their source dependencies or policy
  version change.

Do not start with a universal autonomous memory framework. Recent turns,
provenance-bound summaries, conservative retrieval, and explicit deletion are
the smallest supportable design.

Exit criterion: deterministic and live evaluations cover relevant older-session
recall, time references, contradictions, revocation, and abstention. No summary
is accepted as a citation.

### Slice 10: conversation-to-proposal handoff

**Implemented and deployed. Task path accepted live; Gmail live acceptance is
waiting for explicit Google reauthorization.**
After discussing a customer or desired result, a linked person can ask Erik to
prepare an internal task or one Gmail draft, review the exact proposal in the
same private Slack DM, approve or reject it, request a fresh revision, and see
the canonical outcome on both Slack and Erik.

- use only the already-proven `task.create` and `mail.draft.create` effects;
- resolve conversational references to exact records and current evidence;
- disclose the proposed payload, assumptions, approver, and effects before any
  decision;
- company-channel notifications remain pointer-only, while the linked private
  DM can disclose the proposal and host its bounded approval control;
- bind each control to the exact workspace, linked user, DM, Slack message,
  named Erik approver, action digest, and expiry, and recheck all of them before
  queuing the decision;
- keep evidence inspection and recovery available in the authenticated Erik
  application; and
- converge every decision and execution transition to an outcome receipt on all
  known proposal cards; an exact already-resolved click returns that receipt,
  while identity, message, digest, policy, or expiry tampering still fails;
- treat reject as terminal and request changes as terminal for that immutable
  version; generate the successor from the original request, explicit feedback,
  active session, fresh company tools, and a new effect digest;
- snapshot an application-owned policy on each proposal. The task boundary is
  exactly one internal task. The mail boundary is exactly one Gmail draft to one
  validated literal or cited-contact recipient and never sends; and
- keep evidence inspection and recovery available in Erik.

Exit criterion: real Slack discussions produce one task proposal and one Gmail
draft proposal. Approve, reject, and request-changes each work in Slack;
request-changes produces a linked version 2; a web decision refreshes its Slack
card; duplicate delivery executes no second effect. Wrong-user, stale-digest,
expired-ticket, revoked-link, and message-tampering attempts fail closed.

Live task acceptance on 2026-08-14 proved all three decision paths without a
new task side effect: a legacy web-approved card converged from its old active
button to the canonical `Task created` receipt; a new v1 proposal accepted
request-changes feedback; a distinct v2 appeared with a new digest and lineage;
and rejection closed v2 with its reason while the Slack modal cleared normally.
The live Google Workspace connection is currently `reauthorization_required`,
so Gmail proposal/approval acceptance remains an environment prerequisite, not
an untested-code claim.

### Slice 11: Microsoft 365 connection foundation — implemented in code

**Usable outcome:** an administrator connects one Microsoft 365 account and can
see exactly which tenant, member, delegated permissions, resources, and
capabilities Erik may use, with reliable refresh, health, and disconnect.

- add a `microsoft_365` adapter using server-side authorization-code flow with
  PKCE/OIDC, encrypted rotating refresh tokens, tenant ID, Entra object ID, and
  provider account identity;
- request least privilege incrementally: connection identity first, then a
  separate grant per Outlook read or draft capability; never request mail send;
- model admin consent required, user consent denied, conditional-access failure,
  revoked grant, expired refresh, and tenant mismatch as explicit connection
  states with recovery actions;
- keep the delegated Microsoft 365 data connection separate from a future Teams
  bot installation even when both belong to the same Entra tenant; and
- prove connect, refresh-token replacement, capability enable/disable,
  disconnect/revocation, and cross-company tenant isolation in test production.

Microsoft Graph recommends least-privileged access and authorization-code flow
with PKCE. Refresh tokens must be treated as replaceable secrets; the old token
is securely discarded after a new one is stored. This foundation is therefore
the next slice, not an Outlook UI shortcut.

### Slice 12: Outlook evidence and draft loop — implemented, deployed, and accepted live

**Usable outcome:** Erik can answer a permission-aware question from one Outlook
mailbox and, from that grounded conversation, propose exactly one Outlook draft
that appears in Drafts only after approval.

- ingest a deliberately narrow, fixed Inbox resource for the last 90 days with stable Graph IDs,
  provenance, audience, and selected fields; start with read-only mail evidence;
- combine Graph change notifications with durable queueing and delta queries.
  A webhook is a wake-up signal, not the ledger: acknowledge quickly, validate
  `clientState`, expect replays, renew subscriptions, and use delta/full sync to
  recover missed, removed, or expired subscriptions;
- reuse the existing `mail.draft.create` action envelope through a provider
  adapter, or introduce a provider-neutral draft action version only if the
  current Gmail-specific result contract cannot remain honest;
- use Graph's create-message operation, which saves to Drafts. Do not grant or
  call the separate send operation; and
- automated tests prove exact recipient, mailbox, body, provider reconciliation,
  `outcome_unknown`, replay resistance, cursor recovery, and no-send invariants;
  live acceptance on 2026-08-18 proved Inbox ingestion and citations, durable
  subscription setup, Slack-originated approval, exactly one Outlook draft,
  and zero matching Sent Items.

### Slice 13: Outlook calendar continuity — implemented, deployed, and accepted live

**Usable outcome:** one connected Microsoft account contributes current,
permission-aware calendar context to the same Erik conversation and proposal
evidence model.

- add selected-calendar discovery and explicit resource enablement;
- sync events with the same notification-plus-delta recovery protocol;
- preserve organizer/attendee semantics, recurrence, time zones, cancellations,
  and restricted visibility without flattening them into model text; and
- remain read-only until a specific calendar mutation loop justifies its own
  typed action, policy, approval, idempotency, and reconciliation contract;
- live acceptance on 2026-08-18 proved incremental `Calendars.Read` consent on
  the existing Microsoft identity, explicit selection of the primary and Czech
  holidays calendars, owner-restricted audiences, a 52-item two-resource
  recovery sync, and an active `/me/events` change subscription; and
- the natural date-only question that initially missed a known event now returns
  a cited answer after indexing a lexical weekday/date alongside Graph's exact
  timestamps. The citation is branded Outlook Calendar, opens the Outlook event,
  and no calendar write permission is granted.

### Slice 14: Teams personal conversation and decision parity

**Usable outcome:** a linked member can talk to the same Erik runtime in a
Teams personal chat and receive the same versioned proposal decisions and
canonical receipts already proven in Slack.

- create a separate Teams bot-installation connection and verify every inbound
  Bot/Teams activity; map tenant ID plus Entra object ID through an explicit,
  revocable Erik identity link;
- persist the Teams conversation reference once and treat app installation as a
  prerequisite for proactive personal messages;
- adapt the existing event journal, reorder/idempotency, session, router,
  proposal ticket, and convergence contracts rather than fork reasoning;
- use Adaptive Cards with approve, reject, and request-changes input, keeping
  the canonical decision transaction and executor in Erik; and
- test desktop and mobile card behavior, duplicate invokes, stale cards,
  revoked installation/link, and web/Slack/Teams convergence.

Teams comes after the Graph and identity foundation. It is a new interaction
adapter, not a shortcut for broad Teams history ingestion. Shared chats and
channels remain out of scope until their participant-audience intersection and
membership-change semantics are explicit.

**Implementation state (2026-08-19): code and backend deployed, but Teams is
unavailable and cannot be tested in a real Teams client.** Microsoft must first
resolve Partner Center support request `2608180010001212`; publisher enrollment,
Store submission, and publication must then complete before any desktop or
mobile acceptance is possible. Automated contract tests and direct endpoint
checks are implementation evidence only, not live Teams acceptance.
The repository now has a separate tenant-bound `microsoft_teams` installation,
personal-only authenticated ingress through the current Microsoft Teams SDK,
an exact allowlisted conversation reference, short-lived tenant + Entra object
identity linking, a duplicate-safe ordered activity journal, shared Erik
sessions/retrieval/proposal generation, and `Action.Execute` Adaptive Cards.
Approve, reject, and request-changes invokes bind the tenant, channel-scoped
Teams user, Entra object, conversation, source activity, approver, effect digest,
and policy before entering the canonical decision kernel. Request changes closes
the immutable version and posts a newly approved-policy successor; approval
updates replace all matching Teams cards with factual receipts, so web, Slack,
and Teams still converge on Firestore's one authoritative approval record.
Work and school accounts retain tenant routing. Microsoft consumer accounts use
an identity-scoped global link instead: the shared consumer tenant is never
claimed by a company, and no company context is available until the exact Teams
channel identity completes a short-lived authenticated Erik link. This preserves
multi-company isolation while supporting Teams Free identities whose activities
may not include an Entra object ID.

Automated coverage proves personal-message filtering, service-URL fail-closed
behavior, event deduplication, one-company tenant ownership, one-use identity
links, exact card binding, and duplicate invoke behavior. The UI exposes Teams
from the verified Microsoft tenant and includes a responsive identity-link page.
The personal Azure subscription now hosts the single-tenant Bot Service and
Teams channel, while its app registration accepts organisational and personal
Microsoft identities. Production credentials are in Google Secret Manager, all
five Teams/API functions and hosting routes are deployed, and the live endpoint
rejects unsigned requests. The versioned package at
`teams-app/agent-erik-teams-1.0.0.zip` contains only its validated manifest and
required icons; its privacy and terms URLs are live. Remaining acceptance work
is external: enroll and submit through Partner Center, wait for Teams Store
publication, then exercise personal chat, desktop/mobile cards, identity-link
revocation, installation removal, and connector deletion against the published
app. Do not mark Slice 14 accepted until those live checks pass.

Partner Center publication is blocked as of 2026-08-18. Automated trust
evaluation rejected enrollment before creating a workspace, and a later clean
`tomas@headstart.cz` session reached the correct Microsoft 365 and Copilot
program selector but did not complete enrollment. The verified custom domain,
primary UPN, tenant identity, bot deployment, and Lark mail routing are healthy;
do not churn them as an authentication workaround. The exact failure IDs,
no-workspace support route, escalation text, and restart checklist live in
`MICROSOFT_PARTNER_CENTER_BLOCKER.md`. This is an external acceptance debt, not
permission to mark Slice 14 complete or to keep retrying the same enrollment
flow blindly.

Current Microsoft implementation references:

- [Microsoft identity authorization-code flow with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft Graph authentication and least privilege](https://learn.microsoft.com/en-us/graph/auth/auth-concepts)
- [Microsoft identity refresh-token lifecycle](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
- [Graph change-notification webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Graph lifecycle notifications and recovery](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)
- [Graph delta synchronization](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Graph event delta synchronization](https://learn.microsoft.com/en-us/graph/delta-query-events)
- [Create an Outlook draft message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)
- [Teams proactive personal messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Teams card capabilities and constraints](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference)
- [Microsoft Teams SDK for TypeScript](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-ai-library/typescript/in-depth-guides/overview)
- [Adaptive Card universal actions](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/universal-action-model)

### Slice 15: intentional multi-surface continuity

**Usable outcome:** a person can deliberately continue the same conversation
between Slack, Teams, and the Erik application without accidental history
merging.

- model external bindings separately from logical threads and sessions;
- make “continue in Erik,” “new topic,” and binding state visible;
- add exact deep links to the thread, proposal, and approval being discussed;
- define retention and deletion behavior for provider events and derived
  memory; and
- add mentions or shared channels only when a named loop and privacy model
  require them.

**Slice 15A implementation state (2026-08-18): implemented locally and
verified, independent of Teams Store publication.** External private replies expose an exact
`/ask?thread=...` handoff plus the existing explicit `new topic` control. The
Ask page resolves only a thread already owned by the signed-in member, keeps the
exact thread in the URL, labels whether it is bound to Slack DM, Teams personal
chat, or Erik, and explains when a web message is continuing an external
session. Web turns on a bound thread reuse the active bounded session, current
memory generation, token-budgeted authorized context, fresh-evidence policy,
and idempotent session completion rather than falling back to an ambient recent
history merge. This is the smallest useful continuity proof; provider-event
retention and deletion controls are completed by 15B below. Real Teams-client
acceptance remains separate and externally blocked.

**Slice 15B implementation state (2026-08-19): implementation and automated
acceptance complete; live acceptance pending.** Conversation content now carries policy version
`conversation-retention-v1` and expires 30 days after activity. An hourly,
bounded maintenance job first adopts pre-policy records through resumable
collection cursors, then redacts expired provider events, member messages,
session state, agent-run content, thread titles, and external conversation
identities in place. The remaining envelope contains the stable hashed document
identity, ordering/delivery outcome, and references required for replay safety;
approval and execution records are not altered.

“Forget content” is available to the owning member from the Ask page. It rotates
the memory generation, redacts all older message text, citations, provider
payloads, compact state, and agent-run content, and records a content-free audit
event. Slack and Teams `forget this conversation` use the same generation-fenced
redaction after preparing the new-generation receipt. Connector deletion and a
verified Teams uninstall immediately revoke the binding and redact provider
copies. Tests prove member/company isolation, exact retention bounds, legacy
adoption, preservation of approval audit, connector cleanup, and that a late
duplicate provider event cannot restore redacted content. Live Teams validation
is not claimed and cannot occur before Microsoft resolves support request
`2608180010001212` and Store publication completes.

Direct messages do not justify reading general channel history. A future shared
conversation must define audience intersection, participant identity, mention
semantics, and what happens when membership changes before implementation.

### Slice 16: measured coordination and carefully bounded initiative

**Usable outcome:** Erik helps work progress without becoming noisy or silently
autonomous.

- measure unanswered questions, proposal conversion, decision latency,
  repetition, correction, memory usefulness, and notification fatigue;
- use workflow-owned triggers for reminders and exception notices rather than
  letting a model send arbitrary proactive messages;
- let administrators configure destination, cadence, quiet hours, and stop
  controls;
- add another agent package or provider only when it improves a measured loop;
  and
- consider delegated low-risk automation only as a separate governance product
  with explicit limits, revocation, and audit—not as an extension of memory.

Exit criterion: a bounded proactive behavior measurably shortens one operating
loop, can be disabled immediately, and does not increase unauthorized,
duplicated, or unwanted effects.

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
