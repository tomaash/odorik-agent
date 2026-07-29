# Cases, tasks, approvals, and workflow results

This document is the implementation contract for how cases, tasks, approvals,
and workflow runs relate. It replaces the earlier proposal that required every
contact task to belong to a case.

## Product model

The four objects have different jobs:

| Object | Meaning |
| --- | --- |
| Case | One ongoing customer situation in the shared pipeline |
| Task | Work a person must perform |
| Approval | Permission for Erik to perform one exact disclosed mutation |
| Workflow run | The durable explanation of what matched, proposed, or skipped |

Tasks and approvals remain first-class records. They appear globally as work
assigned to a person and contextually inside a related case. The case does not
own copied versions of them.

## Relationship invariants

A task may be:

1. **Internal** — no contact and no case. A source call may still be retained
   as evidence and provenance.
2. **Contact work** — linked to a resolved contact but not necessarily to a
   case.
3. **Case work** — linked to one active case and therefore to exactly that
   case's contact.

The enforced invariant is one-way:

```text
task.caseId
→ task.contactId equals the linked case contact
```

The converse is deliberately false. A quick callback or contact-level
administrative task does not automatically manufacture an ongoing pipeline
case. The pipeline represents situations worth tracking through stages, not
every piece of customer-adjacent work.

Calls are evidence, not ownership. Case detail includes only calls explicitly
linked by the case, a case task, or a case-scoped approval.

## Direct work and proposed work

A deliberate human click to create a task, create a case, move a case, or
close a task is a direct user authorization. Requiring the same person to
approve that click again would add ceremony without adding control.

Workflow effects are different. Every workflow action contains one named
approver and creates an immutable approval request before it can execute.
Approval binds the exact typed payload and digest. Execution may not silently
substitute a different destination or weaker effect.

## Workflow task subjects

The create-task block exposes one explicit subject:

```ts
type TaskSubject =
  | { kind: "internal" }
  | { kind: "contact" }
  | {
      kind: "matching_case"
      pipelineId: "default"
      stageId: string
      stageName: string
    }
```

- **Internal** creates a standalone task and retains the source call only as
  provenance.
- **Contact** requires a resolved contact and creates contact-level work.
- **Matching case** requires a resolved contact and exactly one non-archived
  case in the selected pipeline and stage. Zero or multiple matches skip
  safely.

The selector is part of the task block. There is no free-floating `case.select`
block, no invisible nearest-preceding-block binding, and no generic read
primitive.

An action targeting a matching case carries the resolved case ID in the
approval payload. If that case becomes archived or otherwise invalid before
approval, execution fails closed. It never degrades to a standalone task.

## Independent workflow results

The current block language proposes independent actions. Visual order controls
evaluation and display order; it does not create execution dependencies
between separately approved actions.

Until dependency semantics exist, the editor should encourage one action per
branch and describe multiple results as independent proposals. A future common
need such as “create a case and its first task” must become one explicit typed
compound effect with disclosed atomic or compensating behavior. It must not be
simulated by positional references between two independently approved blocks.

## Approval relationship envelope

Approval context, action target, and execution result are separate:

```ts
type ApprovalScope = {
  contactId: string | null
  callId: string
  caseId: string | null // an existing related case only
}

type ApprovalResult = {
  kind: "task" | "case" | "case_movement"
  id: string
} | null
```

The immutable typed action and effect digest remain unchanged in purpose.

- A pending create-case approval has no scoped case. Its deterministic future
  ID stays inside the typed effect. After execution, `result` links to the new
  case.
- A move-case approval scopes the existing case.
- A case-targeted task approval scopes the existing case.
- An internal or contact-level task approval has no scoped case.

Case detail queries the approval scope, not an overloaded future result ID.
Existing approvals without the envelope are interpreted through a compatibility
projection and can be backfilled safely.

## Work information architecture

The primary destination is **Work**, not a fifth mobile navigation item:

```text
Work
├── My tasks
├── My approvals
├── Team
└── History
```

The initial interface may expose only the first two and history filters, but
the defaults are personal and actionable:

- **My tasks / To do:** open tasks assigned to the current user, overdue first.
- **My approvals / Waiting:** pending, executing, and failed-safe-to-retry
  approvals assigned to the current user.
- **History:** completed or dismissed tasks and approved or rejected
  approvals.
- **Team:** an explicit opt-in view, never mixed silently into the personal
  queue.

Approvals remain visually and semantically distinct from tasks even though
both appear in Work.

## Case workspace

The case workspace prioritizes:

1. identity, contact, owner, and stage;
2. **Needs attention** — actionable pending approvals and open/overdue tasks;
3. supporting calls explicitly linked to the case;
4. chronological history.

One typed approval-card component renders in Work and Case. It shows:

- workflow and call provenance;
- exact effect and destination;
- compact call evidence;
- named approver;
- separate decision and execution state;
- approve, reject-with-reason, and safe retry controls when permitted; and
- the result link after successful execution.

Historical approvals belong primarily in activity history rather than
permanently occupying the attention panel.

## Exceptions and skipped runs

Safe skips are operational results, not invisible absence. A live run records
and surfaces:

- missing resolved contact;
- no matching case;
- ambiguous matching cases;
- stale or archived targets; and
- failed action execution.

The workflow screen shows recent exceptions with the call, action, and reason:

```text
Could not create the case task
Two active cases matched “New”
No action was performed
```

No approval is needed for a skip because no mutation is proposed, but a person
must be able to see why expected work did not appear.

## Lifecycle and audit rules

- A case can be archived only from a terminal stage.
- A case with open tasks or unresolved scoped approvals cannot be archived.
- Archived cases accept no new tasks or workflow mutations.
- Task completion may remain possible during a concurrent archive attempt, but
  reopening work in an archived case is rejected.
- Task edits, approval execution failures, retries, decisions, case movements,
  and archival all produce audit events.
- Rejection supports an optional reason and the UI asks for it.

## Query and compatibility rules

- Task and approval filters execute in Firestore before limits are applied.
- Personal queues query assignee or approver and actionable state server-side.
- Paginated history is separate from actionable work.
- Existing workflow task blocks without a subject retain their deployed
  behavior through normalization; newly edited or created blocks must choose an
  explicit subject.
- Existing tasks and approvals remain readable. Migration adds relationship
  projections without fabricating cases or changing historical effects.

## Acceptance

This slice is complete when:

- a workflow can propose an internal, contact-level, or uniquely case-targeted
  task;
- a case-targeted task approval and resulting task appear in its case;
- pending create-case approval links never point to a nonexistent case;
- the same approval card is actionable in Work and Case;
- Work defaults to the current person's actionable tasks and approvals;
- decided records move to history and failed execution stays visible;
- live safe skips are visible with their reason;
- archival cannot strand active work;
- cross-object tests cover relationships, stale targets, query filtering,
  approval results, and lifecycle guards; and
- existing deployed workflows continue to normalize and execute safely.
