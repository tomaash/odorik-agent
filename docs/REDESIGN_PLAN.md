# Agent Erik: streamlined product plan

This file is the authority for the current product. The PDF is visual direction,
not a mandate to reproduce unsupported concepts.

## Product decision

Agent Erik is useful today as a small internal operating system around calls:

1. a call becomes durable company context;
2. a workflow proposes exact internal actions to a named approver;
3. only an approved action creates an internal task;
4. a team member owns and closes that task;
5. a contact can have deals in one simple pipeline; and
6. every automatic result points back to its call, workflow, and approval.

This is more honest and more useful than showing generic “read”, “draft”,
“decision”, or external-action blocks that have no connector, execution contract,
or clear user outcome.

## Assumptions challenged

### “A large workflow palette proves flexibility”

No. The block language is a useful product surface, but every available block
must have implemented runtime semantics. The first language therefore has one
trigger, one result type, and one-level conditions over factual call data. It is
deliberately a small executable language rather than a gallery of hypothetical
reads, drafts, or external actions.

### “A low-risk internal action can skip approval”

No. The governing invariant is stronger than risk-based convenience: no
workflow action executes without a named human approver. An internal task is
still a mutation of the team's operating state. A workflow may determine that
the action applies and prepare its exact payload, but it may only create an
immutable approval request.

Approval is attached structurally to every action block rather than offered as a
separate optional block. This prevents authors from accidentally wiring around
it. The approval request itself is a control artifact, not an action effect, so
it does not recursively require another approval.

### “The CRM should replace a full CRM”

No. The useful interim is one shared pipeline and a contact-linked task list.
Custom pipelines, custom fields, forecasting, email sequences, and reporting
would recreate mature products without evidence that Erik should own them.

### “Legacy service requests should become deals”

No automatic migration. Their semantics differ and a lossy conversion would
manufacture pipeline state. Existing requests remain readable as legacy records
on contact pages and at their existing URLs, but are not primary navigation.

## Current information architecture

Primary navigation:

- **Tasks** — default destination, team work queue, and concrete action approvals.
- **Pipeline** — one board for open, won, and lost deals.
- **Contacts** — customer identity, calls, deals, tasks, and legacy requests.
- **Ask** — cited, read-only questions over company data.

Secondary navigation:

- **Workflows** — executable internal-task programs built from supported blocks.
- **Sources** — connector management.
- **Team** — membership and invitations.

The old Decisions and Operations destinations are removed. Their historical
backend records may remain readable for compatibility, but they are not part of
the product contract.

## Internal objects

### Task

A task has:

- title and optional instructions;
- exactly one active team-member assignee;
- `open`, `completed`, or `dismissed` status;
- optional due date, contact, deal, and source call;
- optional outcome note when closed;
- origin (`manual`, `call`, `deal`, or `workflow`);
- authorization (`direct_user_action` or an executed approval id);
- created/updated/closed attribution and audit events.

Closing is reversible through “reopen”. Automatic tasks expose the call summary
and transcript excerpt; they never pretend that an external follow-up happened.
A manually submitted task is approved by the person pressing Create. A workflow
task can only reference an executed approval request.

### Action approval

An action approval has:

- one exact action payload and immutable effect digest;
- exactly one active team-member approver;
- `pending`, `executing`, `approved`, `rejected`, or `execution_failed` status;
- workflow version, run, block, call, and intended task ids;
- timestamps and actor attribution for request, decision, and execution.

Only the named approver can approve or reject. Approval executes the disclosed
payload using its deterministic task id. Rejection creates no task.

### Deal

A deal has:

- title;
- exactly one contact and one active team-member owner;
- one stage in the shared pipeline;
- stage-change attribution and audit events.

The only pipeline is:

`New → Follow-up → In progress → Waiting → Won / Lost`

Desktop supports drag-and-drop. Mobile uses an explicit stage selector so the
same action remains accessible and predictable.

### Contact

A contact is the customer spine. Its detail page shows, in order:

1. deals;
2. internal tasks;
3. call history and transcripts; and
4. collapsed legacy service requests.

## First workflow language

The supported trigger is:

```text
When a completed call has a transcript
→ run ordered blocks from top to bottom
```

Two block kinds are executable:

1. **Create internal task** — title template, instructions, active-team-member
   assignee, optional due offset, and mandatory active-team-member approver.
   `{caller.name}` and `{caller.phone}` are the only template tokens. The
   approver is an inseparable part of the action block.
2. **If / else** — choose task blocks using exactly one stored-data comparison.
   Branches contain task blocks only and cannot nest.

Conditions may inspect only:

- call duration in seconds;
- whether the caller resolved to a stored contact; and
- the actual transcript text (`contains` or exact text match).

An empty branch honestly means “request no action.” A workflow may request
approval for multiple actions when multiple ordered blocks select them.

“Try on history” is read-only and shows the exact actions and approvers that
would be requested. It uses the same evaluator as live execution and explains
each selected branch. “Turn on” creates an immutable workflow version. Future
matching calls create deterministic approval requests per block. Only approval
creates the equally deterministic task, so retries cannot duplicate either
object.
“Pause” stops future runs.

See [INTERNAL_WORKFLOW.md](INTERNAL_WORKFLOW.md) for the executable contract.

## Removed concepts

These are intentionally absent until a concrete connector and execution plan
justify them:

- generic read/evidence blocks;
- AI drafting blocks;
- generic action blocks;
- nested conditions, arbitrary expressions, inferred fields, and sockets;
- free-floating or optional approval blocks;
- “send”, “move in external CRM”, and similar simulated exits;
- arbitrary assignee text;
- agent-generated workflow code.

The read-only Ask agent may still cite evidence. That is a different, already
implemented capability and is not presented as a workflow primitive.

## Legacy workflow handling

- The exact untouched demo draft is upgraded to the internal call-to-task recipe.
- Supported schema-v2 and schema-v3 drafts upgrade in place to a schema-v4
  approval-gated program without changing status or deployed version. The
  existing assignee becomes the initial approver and can be changed in draft.
- Immutable schema-v2 and schema-v3 versions are never rewritten. Runtime
  normalization attaches the existing assignee as approver, so even old enabled
  versions can only request approval and can no longer create a task directly.
- Edited or deployed schema-v1 experiments are preserved, labelled legacy, and
  disabled.
- No schema-v1 definition can be saved, enabled, or executed.
- Existing legacy CRM call processing stays enabled independently during this
  transition.

## Safety boundary

The workflow engine can only create an internal `action_approval` request. It
cannot create a task, send messages, update external systems, create generic
proposals, or invoke arbitrary registered capabilities. Only the approval
executor can create the disclosed internal task after the named approver acts.

Server-side checks revalidate the block program and require active assignee and
approver members for every action on save, enable, request, and execution.
Workflow runs are deterministic per company/workflow-version/call; approval and
task ids additionally include the selected block id. Audit records accompany
approval requests and decisions, task creation and transitions, deal creation
and moves, and workflow enablement.

## Delivery and acceptance

The slice is complete when:

- Tasks is the signed-in default on desktop and mobile.
- A member can create, complete, dismiss, and reopen a task.
- A member can create a contact-linked deal and move it through every stage.
- Contact detail shows its deals and tasks.
- A workflow preview shows concrete action title, assignee, approver, due date,
  and call context without writing data.
- A member can add, remove, and reorder task and IF/ELSE blocks on desktop and
  mobile.
- Preview and live execution choose the same branches for duration, contact,
  and transcript conditions.
- Turning on a workflow causes a future completed call to create exactly the
  selected approval requests, including zero when an empty branch is selected.
- No workflow action creates a task before its named approver accepts it.
- Approving creates the exact disclosed task; rejecting creates no task.
- Retrying cannot duplicate either an approval request or its task.
- Legacy workflow definitions are visibly disabled.
- Decisions and Operations are not reachable.
- Czech and English layouts work at 390px and desktop widths.
- shared, Functions, and frontend tests/builds pass before production deploy.

## Criteria for the next primitive

Add a trigger, condition field, or result block only when its data and effect
are already implemented as normal product behavior, the result is inspectable
and attributable, retries are idempotent, and failure can be explained to a
user. Never add a block solely to make the canvas look more capable.

Add an external connector action only after its authorization scope, preview,
execution record, retry behavior, and compensation story are implemented.
Every future action remains approval-gated regardless of its risk. Higher-risk
actions may additionally require stronger authorization or multiple approvers.
