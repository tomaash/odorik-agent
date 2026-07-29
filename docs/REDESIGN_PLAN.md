# Agent Erik: streamlined product plan

This file is the authority for the current product. The redesign PDF is visual
direction, not a mandate to reproduce unsupported concepts.

## Product decision

Agent Erik is useful today as a small internal operating system around calls:

1. a call becomes durable company context;
2. a workflow evaluates factual call data and proposes exact internal actions;
3. every proposed action names one required human approver;
4. only the approval executor may create a task, create a case, or move a case;
5. team members work from the task queue and one configurable case pipeline;
6. every automatic result points back to its call, workflow version, block, and
   approval.

This is more honest and useful than generic read, evidence, draft, or external
action blocks with no connector, execution contract, or inspectable result.

## Product boundaries

### The block palette proves implemented behavior, not hypothetical flexibility

Every available block must have runtime semantics, validation, preview,
approval, idempotent execution, and audit behavior. The first language has one
trigger, three internal action types, and one-level conditions over factual call
data. Nested logic, inferred fields, and generic sockets are deferred.

### Approval is structurally mandatory

No workflow action executes without its named approver. Approval is embedded in
every action block and cannot be wired around. A workflow may evaluate data and
persist an immutable approval request; the approval request itself is a control
artifact and does not recursively need approval.

### The internal CRM is deliberately small

Erik owns one shared, generically named case pipeline and contact-linked tasks.
Admins can name, order, mark terminal, and archive stages because those
properties are intrinsic to a useful pipeline outside sales. Multiple
pipelines, custom fields, forecasting, email sequences, and reporting are out
of scope.

Legacy service requests are not automatically converted to cases because that
would manufacture meaning and stage state. The old call-to-CRM mutation
workflow is retired rather than presented as a product primitive. Existing
deal-shaped board records are a mechanical predecessor of cases and are
migrated one-to-one, preserving IDs and links.

## Information architecture

Primary navigation:

- **Tasks** — default destination, team work queue, and action approvals.
- **Pipeline** — one board of cases in company-defined stages.
- **Contacts** — customer identity, cases, tasks, calls, and transcripts.
- **Ask** — cited, read-only questions over company data.

Secondary navigation:

- **Workflows** — executable programs built only from supported blocks.
- **Sources** — connector management.
- **Team** — membership and invitations.

Decisions, Operations, Intake, and Requests are not product destinations.

## Internal objects

### Task

A task has a title, optional instructions, one active team-member assignee,
`open` / `completed` / `dismissed` status, optional due date, optional contact,
case, and source call, and an optional closing note. It retains origin,
authorization, attribution, and audit events. Closing is reversible.

A manual task is authorized by the person pressing Create. A workflow task can
only reference an executed approval.

### Case and pipeline

A case has a title, exactly one contact, one active owner, one stable pipeline
and stage, a monotonic revision, origin and authorization, and stage-change
audit history.

The single pipeline starts as:

`New → Follow-up → In progress → Waiting → Done`

An admin may rename, reorder, add, mark terminal, or archive stages. Stage IDs
remain stable so workflows and history cannot silently change meaning. Desktop
supports drag and drop; mobile uses an explicit stage selector.

### Action approval

An approval stores one typed action payload, its canonical SHA-256 effect
digest, one active approver, workflow/run/block/call provenance, and separate:

- decision state: `pending`, `approved`, or `rejected`;
- execution state: `not_started`, `executing`, `succeeded`,
  `failed_safe_to_retry`, or `outcome_unknown`.

The executor records approval before the business effect, rechecks the payload
against its digest, takes a bounded execution lease, and uses deterministic
result/movement IDs. Rejection creates no effect. A stale exact case move does
not execute.

## First workflow language

Trigger:

```text
When a completed call has a transcript
→ evaluate ordered blocks from top to bottom
```

Supported blocks:

1. **Create internal task** — title template, optional instructions, assignee,
   optional due offset, and required approver.
2. **Create case** — title template, owner, initial stage, and required
   approver. It is skipped when the call has no resolved contact.
3. **Move case** — exact current stage, destination stage, and required
   approver. The evaluator proceeds only if the contact has exactly one
   non-archived case in that pipeline and current stage. Zero or multiple
   matches are shown as skipped; Erik never guesses.
4. **If / else** — choose any supported action blocks using one stored-data
   comparison. Branches cannot nest.

Conditions may inspect only:

- call duration in seconds;
- whether the caller resolved to a contact;
- actual transcript text (`contains` or exact comparison).

Templates support only `{caller.name}` and `{caller.phone}`. “Try on history”
uses the live evaluator without writes and shows exact actions, skips,
conditions, and approvers. “Turn on” creates an immutable workflow version.
Runs, approvals, result objects, and movements are deterministic. “Pause”
stops future runs.

Schema-v2 and schema-v3 task workflows normalize to schema v4 and inherit the
assignee as approver. Schema-v1 experiments remain visibly disabled and cannot
be saved, enabled, or executed.

## Explicitly removed or deferred

- generic read/evidence and AI draft blocks;
- generic or externally simulated actions;
- optional or free-floating approval blocks;
- nested conditions and arbitrary expressions;
- arbitrary assignee text;
- model-generated workflow code;
- external writes without a connector-specific authorization, preview,
  idempotency, retry, uncertainty, compensation, and audit contract.

The read-only Ask agent may cite evidence. That is a separate implemented
capability, not a workflow primitive.

## Safety invariants

1. The workflow runtime can create approval requests but cannot directly mutate
   tasks or cases.
2. Only the named approver can approve or reject.
3. The registered typed executor is the only workflow mutation path.
4. Save, enable, request, and execution revalidate members and referenced
   stages server-side.
5. Case moves bind the exact case ID, current stage, and revision seen at
   proposal time.
6. Zero, ambiguous, stale, or archived case matches fail closed.
7. Audit records accompany workflow enablement, approval decisions and
   execution, tasks, cases, movements, and pipeline configuration.
8. Connector ingestion remains company-scoped source observation, not a
   business approval.

## Acceptance

The slice is complete when:

- Tasks is the signed-in default on desktop and mobile.
- Members can create, complete, dismiss, and reopen tasks.
- Members can create and move contact-linked cases.
- Admins can configure the single pipeline without changing stage identity.
- Contact detail shows cases, tasks, and calls.
- Authors can add, remove, reorder, and configure all supported action blocks
  and one-level IF/ELSE on mobile and desktop.
- Preview and live execution use the same evaluator and explain safe skips.
- A future matching call creates exactly the selected approval requests.
- No workflow action mutates state before its approver accepts.
- Approval executes only the disclosed effect; rejection executes nothing.
- Retry cannot duplicate an approval, task, case, or movement.
- Legacy workflow definitions remain disabled.
- Czech and English layouts work at 390px and desktop widths.
- shared, Functions, and frontend tests/builds pass before deployment.

## Criteria for another primitive

Add a trigger, field, or action only when the data and effect already exist as
normal product behavior; the result is inspectable and attributable; retries
are idempotent; and failure or uncertainty can be explained to a user. Never
add a block solely to make the canvas look more capable. Every future action
remains approval-gated.
