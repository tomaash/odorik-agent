# Product vision

## End state

The product is the smallest useful interface between people, AI agents, and a
company's operating systems. Erik should feel like one dependable colleague
whose context and responsibility survive across days and interfaces, not like
a collection of unrelated chatbots attached to connectors.

People should not have to learn a separate screen for every process. They
should be able to tell an agent what they need, inspect what the agent proposes,
and take responsibility for the consequential result with a clear decision.

The interaction borrows the useful properties of two familiar products:

- **Slack-like conversation:** the primary way to ask, explain, delegate, and
  refine work is a message to an agent in shared company context.
- **Card-like decisions:** work requiring responsibility arrives as a focused
  proposal that can be approved, rejected, edited, or returned for another
  iteration. Swipe gestures may be an optional mobile shortcut, but explicit
  buttons, accessible controls, and visible consequences are the product—not
  the Tinder gesture itself.

The product is not a chatbot placed in front of a fixed CRM. It is a governed
agent workspace in which workflows can be described conversationally,
proposed as versioned specifications, approved, and then executed through a
small set of safe application capabilities.

The Agent Erik application is the control and inspection surface: it owns
identity linking, source configuration, evidence, proposal cards, decisions,
execution recovery, and audit. Slack and future chat or email integrations are
transport surfaces. They should make Erik available where work already happens
without turning the external product into an authorization boundary or a
second, inconsistent system of record.

## Strategic product wedge

The near-term product is one connected operating relationship, proved in
increasingly valuable steps:

```text
notice me where I work
→ answer a grounded question there
→ remember what we are discussing
→ prepare exact work from the discussion
→ hand responsibility to the right person
→ execute only the approved effect
→ report and recover the real outcome
```

Approval notification is the entry point, not the destination. Read-only
conversation makes the notification channel useful between decisions. The
decisive product step is conversation-to-proposal handoff: a person should be
able to discuss a customer or outcome in Slack, ask Erik to prepare the next
step, and receive a typed proposal whose evidence and consequences are reviewed
in the application. This joins the factual-agent and approval kernels into one
daily loop without weakening either.

## Product promise

For a person operating a company:

> Tell the system the outcome you want. Agents gather the relevant company
> context and prepare the work. You remain the accountable decision-maker for
> every consequential change.

For a call centre:

> Calls become permission-aware company context. Configurable agents can
> summarize, classify, check quality, route work, draft follow-ups, or propose
> updates without forcing every customer into one predefined CRM workflow.

## The six product loops

### 1. Ingest context

Connectors ingest calls, calendars, documents, messages, and later other
systems. Every item retains its company, source, original identity, timestamps,
permissions, raw artifact reference, and ingestion version.

The system must never flatten all company data into an untraceable model
memory. Agents retrieve only relevant, authorized context and cite the source
items used for a proposal.

### 2. Converse

A person creates a thread with an agent, mentions company objects, asks a
question, gives an instruction, or explains a desired recurring process. The
thread is durable working context, but it is not itself authoritative company
state.

A logical conversation may be reached from the Agent Erik application or bound
to an external surface such as one linked Slack direct message. The surface
adapter authenticates the external identity, appends events to the same durable
conversation protocol, and renders a channel-appropriate response. It does not
own agent reasoning or memory policy.

Conversation must support ordinary human turns as well as data questions. A
greeting should receive a greeting; a capability question should explain what
Erik can do; a contextual follow-up should resolve its references and retrieve
fresh evidence; a consequential request should become a proposal rather than a
side effect. Tool use is therefore selected by the meaning of the turn, not
forced merely because the message arrived at an agent endpoint.

### 3. Propose

The agent can respond conversationally or create a typed proposal. A proposal
must show:

- what the agent recommends;
- why it recommends it;
- which source evidence it used;
- what is unknown or assumed;
- exactly which records or external systems would change; and
- whether the action is reversible.

Free-form model text is never an executable instruction. Proposal payloads are
validated against application-owned schemas and refer only to allowlisted
capabilities.

### 4. Decide

The responsible person chooses one of four decisions:

- **Approve:** authorize this exact proposal version and its disclosed effects.
- **Reject:** close it without execution, optionally with a reason.
- **Request changes:** give feedback and return the work to an agent. A new
  immutable proposal version must be produced.
- **Edit and approve:** make an explicit bounded correction, then approve the
  corrected version.

An approval is not a mutable boolean. It records the person, proposal version
and digest, decision, timestamp, company, and effects authorized.

### 5. Execute

Only application-owned action handlers can change authoritative business state
or call an external system. The handler rechecks company membership,
permissions, proposal status, version, preconditions, and idempotency before it
acts.

Connector outcomes distinguish `succeeded`, `failed_safe_to_retry`, and
`outcome_unknown`. An uncertain external result is reconciled or reviewed; it
is not blindly repeated.

### 6. Learn and improve

The system measures approvals, rejections, requested changes, edits, execution
outcomes, and source evidence. This improves prompts and workflow templates
without quietly expanding an agent's authority.

It also measures conversation quality: repeated answers, wrong response mode,
lost references, out-of-order replies, memory retrieval, abstention, latency,
and whether a conversation successfully reaches a useful cited answer or typed
proposal. A fluent answer is not evidence of a correct conversation runtime.

## Conversation, memory, and authority

Long-duration conversation requires several memory classes with different
authority. They must not be collapsed into one vector index or one ever-growing
prompt.

| Memory class | Purpose | Authority |
| --- | --- | --- |
| Event journal | Immutable inbound and outbound turns, provider IDs, timestamps, delivery state | Exact record of the conversation transport |
| Working context | Recent ordered turns and the currently discussed objects or task | Temporary conversational state |
| Episodic memory | Versioned summaries of completed sessions, decisions, corrections, and unresolved topics | Derived and provenance-bound; useful for recall, never company evidence |
| Member preferences | Explicit durable preferences or instructions accepted from that member | Scoped to that member and revocable; never silently inferred from agent text |
| Company knowledge | Current permission-filtered calls, mail, documents, cases, tasks, and other connected records | Authoritative evidence for factual answers and proposals |

The default context assembly is recent raw turns plus a compact session state
plus relevant older memories. Older memory is retrieved by subject, entities,
time, and recency rather than appended indiscriminately. Session summaries cite
the exact message range they compress and can be rebuilt when the summarizer or
policy changes.

Assistant answers are never promoted into company truth. When a later turn
depends on a company fact, Erik retrieves the current source again even if an
older answer or summary remembers it. User corrections are retained as
conversation state with timestamp and authorship, but they do not overwrite a
connected system of record. Revoked source access immediately removes that
source from new prompts and memory retrieval.

External events are asynchronous and at-least-once. Each conversation therefore
has an idempotent inbox, provider ordering key, single active processing lease,
and durable cursor. The user turn is recorded before generation. Only the
oldest eligible event is processed; retries reuse the same event and response
identity. This is product behavior, not invisible infrastructure: people must
not receive duplicated, missing, or causally reversed replies.

A period of inactivity or an explicit “new topic” closes a working session.
The durable conversation remains available, but old sessions enter prompts
only when relevant. People can inspect, correct, forget, or start fresh; memory
must not become an inescapable hidden profile.

## Human responsibility boundary

The platform separates three kinds of writes:

| Write | May happen automatically? | Authority |
| --- | --- | --- |
| Source observations such as a received call or synced calendar event | Yes | The connector and original source |
| Derived state such as transcripts, indexes, summaries, drafts, and agent run logs | Yes | Non-authoritative, with provenance |
| Authoritative company mutations and external effects | No, not in the baseline product | One explicit human decision over a disclosed proposal |

This distinction keeps ingestion and agent work practical while preserving the
rule that consequential company action belongs to a person. Any future policy
for delegated automatic actions would itself require an explicit product and
governance decision; it is not implied by this vision.

## Conversational workflow creation is a hypothesis

The longer-term idea that a person can define workflows entirely through
conversation remains plausible, but it is not yet a product or architecture
commitment. We first need evidence that agents can reliably navigate company
context, select tools, cite facts, and expose uncertainty.

A possible later interaction is:

> After each sales call, check whether the customer asked for a follow-up. If
> so, draft a task for the account owner and ask me before creating it.

If pursued, the agent must not generate and deploy arbitrary code. It would
propose a declarative workflow assembled from supported primitives:

```text
trigger
→ context requirements
→ agent work
→ decision gate
→ allowlisted action
→ completion or exception
```

Such a proposal would include example behavior, required connector permissions,
failure handling, and every intended side effect. The workflow becomes active
only after approval. Changes produce a new version and go through the same
decision loop.

A small call-to-task block language is now being tested after factual retrieval.
It contains only implemented behavior: the completed-call trigger, internal task
creation behind a mandatory named approver, and one-level branches over stored
call duration, contact match, and transcript text. The workflow creates an
immutable approval request; only the approver can create the disclosed task.
Conversational authoring and broader primitives remain later hypotheses that
require typed, revertible changes and proven runtime semantics.

## Call centres as the first product surface

The existing Odorik integration is an advantage, not a constraint. A completed
call becomes a generic context item and can trigger different workflow
packages, including:

- summarization and disposition;
- quality or compliance review;
- intent and sentiment classification;
- follow-up drafting;
- escalation and routing;
- task or case proposals; and
- coaching feedback.

The platform kernel must not assume that every call creates a service request,
requires photos, or follows the current five CRM statuses. Those are optional
workflow and record schemas owned by a particular company or package.

## Context and connector model

Connectors have separate read and action capabilities. Granting access to read
a calendar must not implicitly grant permission to create an event. A source
connector is responsible for:

- authenticating to the external system;
- importing or receiving source objects idempotently;
- preserving source identity and provenance;
- mapping source permissions into company access rules;
- exposing declared read capabilities; and
- exposing separately declared action capabilities when supported.

Initial source families are:

1. calls and recordings—the working Odorik connector;
2. calendars;
3. documents and files; and
4. messages or email.

The platform should add a second independent connector early to prove that the
abstraction is real rather than an Odorik adapter with a generic name.

## Experience principles

- **Mobile first:** conversation and decisions must work comfortably on a
  narrow screen.
- **One decision at a time:** cards reveal enough evidence and consequence to
  decide without forcing navigation across the application.
- **Progressive detail:** summary first; sources, payload, history, and run logs
  remain inspectable.
- **Visible agency:** the interface distinguishes human statements, agent
  analysis, proposed actions, approved actions, and execution results.
- **No dark approvals:** consequential actions never hide inside a generic
  “continue” button or a conversational reply.
- **Accessible without gestures:** swiping can accelerate a decision but never
  be the only way to make it.
- **Private conversation, shared accountability:** member threads are private
  by default; proposals, decisions, and outcomes become visible to exactly the
  authorized people who own or review that work.
- **Continuity without captivity:** a conversation can resume across time and
  surfaces, while the person can start a new topic or clear remembered context.
- **Right response mode:** social turns, factual questions, proposals, and
  decisions are visibly different and use only the capabilities they require.
- **Channel-appropriate disclosure:** external messages reveal the minimum
  useful content; sensitive evidence and consequential decisions return to the
  authenticated application unless that surface has an explicitly proven
  equivalent boundary.
- **Graceful handoff:** when a compact chat response is insufficient, one link
  opens the exact thread, evidence, proposal, or recovery state—not merely a
  generic page.

## Non-goals for the next releases

- a universal or free-form visual workflow builder;
- arbitrary agent-generated code execution;
- autonomous external actions;
- full replacement of document, calendar, accounting, or messaging products;
- a general CRM schema;
- photo-specific intake;
- multi-agent theatre without a measurable operating outcome;
- loading all company data into every model prompt;
- treating every incoming message as a company-data query;
- treating an assistant's prior answer or a conversation summary as factual
  evidence;
- ingesting broad chat history merely to make the assistant appear more aware;
  and
- hidden permanent memory that a member cannot inspect, correct, or delete.

## Success measures

The platform is succeeding when it reduces the interface and coordination cost
of company work without obscuring responsibility. Early measures are:

- time from instruction to an approved workflow;
- percentage of proposals approved, edited, rejected, or returned;
- iterations required before approval;
- time spent per decision;
- unsupported or uncited claims in proposals;
- duplicate or unauthorized action rate;
- execution and reconciliation outcomes;
- number of distinct workflows and source types using the same kernel without
  changes to its core contracts;
- percentage of turns assigned the correct response mode;
- repeated-answer and out-of-order-reply rate;
- contextual follow-up resolution and long-term memory recall;
- stale or unauthorized memory use—the target is zero; and
- time from an external conversation to a useful cited answer, exact proposal,
  and completed human decision.
