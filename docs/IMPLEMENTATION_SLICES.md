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

## Current product position — 2026-08-13

The repository has proved more of the kernel than the historical numbering
below suggests:

- permission-aware Calendar, Drive, Gmail, Odorik, and GitHub evidence use one
  source and retrieval contract;
- private member-owned agent threads, hybrid search, exact tools, citations,
  durable index delivery, and factual-agent run traces are implemented;
- typed task, case, case-movement, and Gmail-draft effects share the mandatory
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

The direct-message dogfood exposed a product-level defect: after a company
summary, the message “hello” was forced through a company search and produced
another version of the summary. The previous turns were loaded; the factual
loop's unconditional first-tool rule selected the wrong behavior for a social
turn. The prototype also has no per-conversation serialization, only eight
recent message documents, and no durable session memory. These are now explicit
roadmap requirements rather than prompt-tuning follow-ups.

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
rotates a memory generation, so retained provider/audit records cannot silently
re-enter future prompts. Session selection and state completion are idempotent
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

**Usable outcome:** after discussing a customer or desired result, a person can
ask Erik to prepare one existing typed action and receive an exact decision
card in the application.

- begin with an already proven effect such as `task.create` or
  `mail.draft.create` rather than a new action;
- resolve conversational references to exact records and current evidence;
- disclose the proposed payload, assumptions, approver, and effects before any
  decision;
- post only a pointer and proposal status into Slack;
- perform approval, edits, evidence inspection, execution, and recovery in the
  authenticated Erik application; and
- resume the conversation with the observed result.

Exit criterion: one Slack discussion produces one immutable proposal, the named
person approves it in Erik, exactly one effect occurs, and both surfaces show
the same factual outcome.

### Slice 11: intentional multi-surface continuity

**Usable outcome:** a person can deliberately continue the same conversation
between Slack and the Erik application without accidental history merging.

- model external bindings separately from logical threads and sessions;
- make “continue in Erik,” “new topic,” and binding state visible;
- add exact deep links to the thread, proposal, and approval being discussed;
- define retention and deletion behavior for provider events and derived
  memory; and
- add mentions, shared channels, or another provider only when a named loop and
  privacy model require them.

Direct messages do not justify reading general channel history. A future shared
conversation must define audience intersection, participant identity, mention
semantics, and what happens when membership changes before implementation.

### Slice 12: measured coordination and carefully bounded initiative

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
