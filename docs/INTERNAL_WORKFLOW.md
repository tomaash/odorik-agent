# Approval-gated workflow block-language contract

The dependency-free implementation is
`functions/shared/src/index.ts`. The browser and server both use its validator
and evaluator. The server remains authoritative.

## Non-negotiable invariant

No workflow action executes without a named human approver. Approval is an
inseparable property of every action block, not an optional control-flow block.
A workflow run may create approval requests; only the approval executor may
create the disclosed task.

An approval request is a control artifact and has no product effect by itself,
so creating it does not recursively require approval.

## Schema

```ts
type WorkflowSpec = {
  schemaVersion: 4
  name: string
  trigger: {
    id: string
    kind: "event.call.transcribed"
  }
  blocks: Array<CreateTaskBlock | IfBlock>
}

type CreateTaskBlock = {
  id: string
  kind: "action.task.create"
  task: {
    title: string
    instructions?: string
    assigneeUid: string
    assigneeName: string
    dueAfterDays?: number | null
  }
  approval: {
    kind: "required"
    approverUid: string
    approverName: string
  }
}

type IfBlock = {
  id: string
  kind: "control.if"
  condition: {
    field:
      | "call.durationSeconds"
      | "caller.hasContact"
      | "transcript.text"
    operator: "eq" | "contains" | "gt" | "gte" | "lt" | "lte"
    value: string | number | boolean
  }
  then: CreateTaskBlock[]
  else: CreateTaskBlock[]
}
```

Root blocks evaluate in array order. IF branches may contain action blocks only;
conditions cannot nest. Unknown block, field, operator, or approval values fail
validation.

## Validation

- Name and every task title are required.
- Name is at most 200 characters; title at most 300.
- Instructions are at most 5,000 characters.
- Every block id is non-empty and unique across the root and both branches.
- A workflow and each branch can contain at most 10 blocks.
- A workflow can define at most 20 action blocks across all branches.
- At least one root block and at least one action across an IF block's branches
  are required.
- Every action requires `approval.kind = "required"` and a named approver.
- The server verifies both assignee and approver are active members of the
  current company and replaces submitted display names with server-resolved
  names.
- Due offset is null or an integer from 0 through 365.
- Duration comparisons use a non-negative numeric second value.
- Contact matching compares a boolean with `eq`.
- Transcript matching uses a non-empty string with `contains` or `eq`.

The assignee and approver may be the same person. This means the assignee must
accept the work before the task enters the queue; it does not bypass approval.

## Available factual data

- `call.durationSeconds` comes from the stored completed call.
- `caller.hasContact` is true only when the caller resolves to a stored contact.
- `transcript.text` is the stored transcript, or joined stored transcript
  segments when the single transcript field is absent.

A missing duration never satisfies numeric comparisons. Transcript comparisons
are case-insensitive. No model inference runs during condition evaluation.

## Preview

History preview selects completed calls and runs the same shared evaluator used
by live execution. For every call it returns:

- the selected branch for each IF block;
- every exact action that would request approval, in evaluation order;
- rendered title and instructions;
- server-validated assignee and approver;
- absolute due time; and
- compact call context.

Preview persists nothing. Full transcript text may be inspected by a condition
but is not copied into task, approval, or workflow-run context.

## Approval request

For every selected action, the runtime stores one deterministic
`actionApprovals` document containing:

- status `pending`;
- approver uid and server-resolved display name;
- exact task payload and future deterministic task id;
- SHA-256 effect digest;
- workflow id, immutable version, run id, block id, and call id; and
- compact call context and timestamps.

Only the named approver can approve or reject. Rejection changes status to
`rejected` and creates no task. Approval first claims the request as `executing`,
then creates the exact task, and finally records `approved`. Execution failure
is visible as `execution_failed` and can be retried by the same approver.

## Idempotency

For every enabled workflow version and completed call:

1. derive one run id from `companyId + workflowId + version + callId`;
2. derive each approval id from that key plus `blockId`;
3. derive each future task id from that same key plus `blockId`;
4. request approval only if the deterministic request does not exist; and
5. create the task only after approval and only if its deterministic id does
   not exist.

Retries can duplicate neither request nor task. An empty selected branch records
`no_actions`.

## Direct human actions

A person pressing Create task is an immediate direct authorization and is stored
on the task as `authorization.kind = "direct_user_action"` with that user and
timestamp. A workflow-created task must instead store
`authorization.kind = "approval"` with the executed approval id and approver.

## Version and migration rules

Turning on a workflow stores an immutable version. Editing the draft does not
affect the enabled version until it is turned on again. Pausing prevents future
matching.

- The exact seeded schema-v1 demo can be replaced with a schema-v4 draft.
- Other schema-v1 records remain `legacy`, cannot be edited, and cannot execute.
- Schema-v2 recipes and schema-v3 block drafts upgrade in place to schema v4.
- Each upgraded action initially uses its existing assignee as approver.
- Immutable schema-v2 and schema-v3 versions are not rewritten. They normalize
  in memory to the same required approval rule, so old enabled versions can no
  longer create tasks directly.
