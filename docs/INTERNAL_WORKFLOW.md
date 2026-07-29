# Approval-gated workflow block-language contract

The dependency-free schema, validator, and evaluator live in
`functions/shared/src/index.ts` and run in both browser and server. The server
is authoritative.

## Invariant

No workflow action executes without one named human approver. Approval is an
inseparable field on every action block, not optional control flow. A workflow
run may persist approval requests; only the typed approval executor may apply
the disclosed result.

## Schema

Schema v4 has one `event.call.transcribed` trigger and ordered root blocks.
Action blocks are:

- `action.task.create`: title template, instructions, assignee, due offset, and
  explicit internal/contact/unique-matching-case subject;
- `action.case.create`: title template, pipeline, initial stage, owner;
- `action.case.move`: pipeline, exact current stage, destination stage.

Each includes:

```ts
approval: {
  kind: "required"
  approverUid: string
  approverName: string
}
```

`control.if` compares one of `call.durationSeconds`, `caller.hasContact`, or
`transcript.text` with the allowlisted typed operators. Its `then` and `else`
arrays may contain any action block but no nested control block.

Unknown block, field, operator, stage, member, or approval values fail
validation. Block IDs are non-empty and unique. Root and branch counts are
bounded. The server resolves submitted member and stage names from current
company records on save.

## Evaluation

Conditions use stored facts only; no model inference runs. Templates support
only `{caller.name}` and `{caller.phone}`.

The evaluator returns ordered `actions`, `skippedActions`, and condition traces:

- an internal task always yields a proposal when valid;
- a contact task requires a resolved contact;
- a case task requires a resolved contact and exactly one non-archived case in
  the selected pipeline and stage;
- create-case requires a resolved contact;
- move-case requires a resolved contact and exactly one non-archived case in
  the selected pipeline and exact current stage;
- zero or multiple movement matches yield `no_matching_case` or
  `ambiguous_case`, not a guessed proposal.

The move proposal binds case ID, current stage, and current revision. Full
transcript text may drive a condition but is not copied into action context.

History preview calls this same evaluator and writes nothing.

Action blocks produce independent proposals. Their visual order controls
evaluation and presentation, not execution dependencies. A future compound
effect must have its own typed and disclosed execution contract.

## Approval and execution

Each selected action creates one deterministic `actionApprovals` document with
the exact typed payload, canonical SHA-256 effect digest, approver, immutable
workflow provenance, `scope` over existing related objects, `result` after
successful execution, and:

- decision state: `pending`, `approved`, `rejected`;
- execution state: `not_started`, `executing`, `succeeded`,
  `failed_safe_to_retry`, `outcome_unknown`.

Approval is recorded transactionally before execution. The executor:

1. verifies the actor is the named approver;
2. verifies the canonical action digest;
3. claims a five-minute execution lease with a unique attempt ID;
4. dispatches only `task.create`, `case.create`, or `case.move`;
5. records the result and audit event.

Rejection creates no effect. An active lease prevents concurrent execution.
All current internal actions are idempotent; an unknown-outcome state is
reserved for future external effects where blind retry would be dishonest.

A pending create-case approval has no case scope. A move or case-task approval
scopes the existing case. Successful execution records the created task, case,
or movement in the result envelope.

## Idempotency and concurrency

For a company, immutable workflow version, and completed call:

1. the run ID derives from company + workflow + version + call;
2. each approval ID derives from that key + block ID;
3. a task/case/movement ID derives from the same key + block ID;
4. result repositories treat that ID as idempotency key;
5. a case movement additionally requires the proposed stage and revision.

Retries duplicate neither approval nor effect. A case changed after proposal
fails closed and needs a fresh run/approval rather than applying stale intent.

## Direct human actions

Pressing Create task, Create case, or moving a case on the board is itself a
direct user authorization and is stored as `direct_user_action`. A
workflow-created result stores approval ID and approver instead.

## Versions

Turning on stores an immutable version; draft changes do not affect it until
turned on again. Pausing prevents future runs. Supported schema-v2 and
schema-v3 task definitions normalize to schema v4 with their assignee as
approver. Schema-v1 experiments remain disabled and cannot execute.
