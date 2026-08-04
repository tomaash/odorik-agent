import assert from "node:assert/strict";
import test from "node:test";
import {
  createCallTaskWorkflow,
  createCaseBlock,
  createIfBlock,
  createMailDraftBlock,
  createMoveCaseBlock,
  createTaskBlock,
  normalizeWorkflowSpec,
  previewWorkflow,
  previewWorkflowTasks,
  validateWorkflow,
} from "../index.js";

test("default call task recipe is valid", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  assert.deepEqual(validateWorkflow(spec), {
    valid: true,
    errors: [],
    holes: [],
  });
});

test("validator fails closed and returns stable paths", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  const first = spec.blocks[0]!;
  assert.equal(first.kind, "action.task.create");
  if (first.kind !== "action.task.create") return;
  first.task.title = "";
  first.task.dueAfterDays = -1;
  const validation = validateWorkflow(spec);
  assert.equal(validation.valid, false);
  assert.ok(validation.holes.some((entry) => entry.path === "blocks[0].task.title"));
  assert.ok(validation.errors.some((entry) => entry.path === "blocks[0].task.dueAfterDays"));
  assert.equal(validateWorkflow({}).valid, false);
});

test("every action requires a named approver", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  const first = spec.blocks[0]!;
  assert.equal(first.kind, "action.task.create");
  if (first.kind !== "action.task.create") return;
  first.approval.approverUid = "";
  first.approval.approverName = "";
  const validation = validateWorkflow(spec);
  assert.equal(validation.valid, false);
  assert.ok(validation.holes.some((entry) => (
    entry.path === "blocks[0].approval.approverUid"
  )));
});

test("ordered blocks render caller fallback, context and due date", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  spec.blocks.push(createTaskBlock({
    id: "task_second",
    title: "Record outcome for {caller.phone}",
    assigneeUid: "user-2",
    assigneeName: "Josef",
  }));
  const preview = previewWorkflowTasks(spec, {
    callerHasContact: true,
    callerName: null,
    callerPhone: "+420123456789",
    callSummary: "Customer asked for a follow-up.",
    transcriptExcerpt: "Please call me tomorrow.",
  }, new Date("2026-07-28T10:00:00.000Z"));
  assert.equal(preview[0]?.title, "Follow up after call with +420123456789");
  assert.equal(preview[0]?.dueAt, "2026-07-29T10:00:00.000Z");
  assert.equal(preview[1]?.title, "Record outcome for +420123456789");
  assert.equal(preview[1]?.assigneeUid, "user-2");
});

test("simple conditions select one task branch from persisted call data", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  const conditional = createIfBlock({
    id: "if_duration",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  conditional.condition = {
    field: "transcript.text",
    operator: "contains",
    value: "quote",
  };
  const matchingTask = conditional.then[0]!;
  if (matchingTask.kind !== "action.task.create") return;
  matchingTask.task.title = "Prepare quote";
  conditional.else.push(createTaskBlock({
    id: "task_no_quote",
    title: "No quote requested",
    assigneeUid: "user-2",
    assigneeName: "Josef",
  }));
  spec.blocks = [conditional];

  const matching = previewWorkflowTasks(spec, {
    callerHasContact: true,
    transcriptText: "Please send a quote tomorrow.",
  });
  const notMatching = previewWorkflowTasks(spec, {
    callerHasContact: true,
    transcriptText: "Just checking our appointment.",
  });
  assert.deepEqual(matching.map((task) => task.title), ["Prepare quote"]);
  assert.deepEqual(notMatching.map((task) => task.title), ["No quote requested"]);
});

test("duration and contact conditions use only supplied factual call data", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  const conditional = createIfBlock({
    id: "if_contact",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  conditional.condition = {
    field: "caller.hasContact",
    operator: "eq",
    value: true,
  };
  const knownCustomerTask = conditional.then[0]!;
  if (knownCustomerTask.kind !== "action.task.create") return;
  knownCustomerTask.task.title = "Known customer";
  conditional.else.push(createTaskBlock({
    id: "task_unknown",
    title: "Unknown caller",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  }));
  const unknownTask = conditional.else[0];
  if (unknownTask?.kind === "action.task.create") {
    unknownTask.task.subject = { kind: "internal" };
  }
  spec.blocks = [conditional];

  const preview = previewWorkflow(spec, { callerHasContact: false });
  assert.deepEqual(preview.actions.map((action) => (
    action.kind === "task.create" ? action.title : null
  )), ["Unknown caller"]);
  assert.deepEqual(preview.conditions.map((condition) => ({
    result: condition.result,
    branch: condition.branch,
    actual: condition.actual,
  })), [{ result: false, branch: "else", actual: false }]);

  conditional.condition = {
    field: "call.durationSeconds",
    operator: "gte",
    value: 30,
  };
  assert.equal(previewWorkflow(spec, { callDurationSeconds: null }).conditions[0]?.result, false);
  assert.equal(previewWorkflow(spec, { callDurationSeconds: 30 }).conditions[0]?.result, true);
});

test("task subjects distinguish internal, contact and exact case work", () => {
  const internal = createTaskBlock({
    id: "task_internal",
    title: "Review the call routing",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  internal.task.subject = { kind: "internal" };
  const contact = createTaskBlock({
    id: "task_contact",
    title: "Call the contact",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  contact.task.subject = { kind: "contact" };
  const matchingCase = createTaskBlock({
    id: "task_case",
    title: "Prepare the case follow-up",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  matchingCase.task.subject = {
    kind: "matching_case",
    pipelineId: "default",
    stageId: "new",
    stageName: "New",
  };
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  spec.blocks = [internal, contact, matchingCase];

  const unresolved = previewWorkflow(spec, { callerHasContact: false });
  assert.deepEqual(unresolved.actions.map((action) => action.blockId), ["task_internal"]);
  assert.deepEqual(unresolved.skippedActions.map((skip) => skip.reason), [
    "contact_required",
    "contact_required",
  ]);

  const exact = previewWorkflow(spec, {
    callerHasContact: true,
    cases: [{
      id: "case-1",
      title: "Renewal",
      pipelineId: "default",
      stageId: "new",
      stageName: "New",
      revision: 2,
    }],
  });
  assert.deepEqual(exact.actions.map((action) => action.blockId), [
    "task_internal",
    "task_contact",
    "task_case",
  ]);
  const caseTask = exact.actions[2];
  assert.equal(caseTask?.kind, "task.create");
  if (caseTask?.kind === "task.create") {
    assert.equal(caseTask.caseId, "case-1");
    assert.equal(caseTask.caseTitle, "Renewal");
  }

  const ambiguous = previewWorkflow(spec, {
    callerHasContact: true,
    cases: [
      {
        id: "case-1",
        title: "First",
        pipelineId: "default",
        stageId: "new",
        stageName: "New",
        revision: 0,
      },
      {
        id: "case-2",
        title: "Second",
        pipelineId: "default",
        stageId: "new",
        stageName: "New",
        revision: 0,
      },
    ],
  });
  assert.equal(ambiguous.actions.some((action) => action.blockId === "task_case"), false);
  assert.deepEqual(ambiguous.skippedActions.at(-1), {
    blockId: "task_case",
    kind: "action.task.create",
    reason: "ambiguous_case",
    matches: 2,
  });
});

test("case actions require a contact and exact unambiguous case movement", () => {
  const spec = createCallTaskWorkflow({
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  });
  spec.blocks = [
    createCaseBlock({
      ownerUid: "user-1",
      ownerName: "Tomáš",
      pipelineId: "default",
      stageId: "new",
      stageName: "New",
    }),
    createMoveCaseBlock({
      approverUid: "user-2",
      approverName: "Josef",
      pipelineId: "default",
      fromStageId: "new",
      fromStageName: "New",
      toStageId: "in_progress",
      toStageName: "In progress",
    }),
  ];

  const noContact = previewWorkflow(spec, { callerHasContact: false });
  assert.equal(noContact.actions.length, 0);
  assert.deepEqual(noContact.skippedActions.map((item) => item.reason), [
    "contact_required",
    "contact_required",
  ]);

  const exact = previewWorkflow(spec, {
    callerHasContact: true,
    callerName: "ACME",
    cases: [{
      id: "case-1",
      title: "ACME renewal",
      pipelineId: "default",
      stageId: "new",
      stageName: "New",
      revision: 3,
    }],
  });
  assert.deepEqual(exact.actions.map((action) => action.kind), ["case.create", "case.move"]);
  const movement = exact.actions[1];
  assert.equal(movement?.kind, "case.move");
  if (movement?.kind === "case.move") {
    assert.equal(movement.caseId, "case-1");
    assert.equal(movement.expectedRevision, 3);
    assert.equal(movement.approverUid, "user-2");
  }

  const ambiguous = previewWorkflow(spec, {
    callerHasContact: true,
    cases: [
      {
        id: "case-1",
        title: "First",
        pipelineId: "default",
        stageId: "new",
        stageName: "New",
        revision: 0,
      },
      {
        id: "case-2",
        title: "Second",
        pipelineId: "default",
        stageId: "new",
        stageName: "New",
        revision: 0,
      },
    ],
  });
  assert.equal(ambiguous.actions.filter((action) => action.kind === "case.move").length, 0);
  assert.deepEqual(ambiguous.skippedActions, [{
    blockId: spec.blocks[1]?.id,
    kind: "action.case.move",
    reason: "ambiguous_case",
    matches: 2,
  }]);
});

test("validator rejects malformed branches without throwing", () => {
  const malformed = {
    schemaVersion: 3,
    name: "Malformed",
    trigger: {
      id: "trigger",
      kind: "event.call.transcribed",
    },
    blocks: [{
      id: "if_bad",
      kind: "control.if",
      condition: {
        field: "caller.hasContact",
        operator: "eq",
        value: true,
      },
    }],
  };
  const validation = validateWorkflow(malformed);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === "branch.invalid"));
});

test("schema 2 recipes upgrade to one approval-gated task block", () => {
  const upgraded = normalizeWorkflowSpec({
    schemaVersion: 2,
    name: "Existing workflow",
    trigger: { kind: "call.transcribed" },
    task: {
      title: "Follow up",
      assigneeUid: "user-1",
      assigneeName: "Tomáš",
      dueAfterDays: 2,
    },
  });
  assert.equal(upgraded?.schemaVersion, 4);
  assert.equal(upgraded?.blocks.length, 1);
  assert.equal(upgraded?.blocks[0]?.id, "task_primary");
  assert.equal(upgraded?.blocks[0]?.kind, "action.task.create");
  if (upgraded?.blocks[0]?.kind === "action.task.create") {
    assert.equal(upgraded.blocks[0].approval.approverUid, "user-1");
  }
  assert.equal(validateWorkflow(upgraded).valid, true);
});

test("schema 3 blocks inherit the assignee as their required approver", () => {
  const upgraded = normalizeWorkflowSpec({
    schemaVersion: 3,
    name: "Existing block workflow",
    trigger: {
      id: "trigger_call_transcribed",
      kind: "event.call.transcribed",
    },
    blocks: [{
      id: "task_existing",
      kind: "action.task.create",
      task: {
        title: "Follow up",
        assigneeUid: "user-2",
        assigneeName: "Josef",
        dueAfterDays: 1,
      },
    }],
  });
  assert.equal(upgraded?.schemaVersion, 4);
  assert.equal(upgraded?.blocks[0]?.kind, "action.task.create");
  if (upgraded?.blocks[0]?.kind === "action.task.create") {
    assert.deepEqual(upgraded.blocks[0].approval, {
      kind: "required",
      approverUid: "user-2",
      approverName: "Josef",
    });
  }
  assert.equal(validateWorkflow(upgraded).valid, true);
});

const mailbox = {
  connectionId: "google_1",
  address: "ops@acme.cz",
  providerAccountId: "google-sub-1",
  active: true,
};

function mailSpec(overrides: Parameters<typeof createMailDraftBlock>[0]) {
  const spec = createCallTaskWorkflow({ assigneeUid: "user-1", assigneeName: "Tomáš" });
  spec.blocks = [createMailDraftBlock(overrides)];
  return spec;
}

test("a draft to a literal address needs no resolved contact", () => {
  const spec = mailSpec({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId: "google_1",
    recipient: { kind: "literal", email: "Ops@Acme.cz" },
  });
  assert.deepEqual(validateWorkflow(spec), { valid: true, errors: [], holes: [] });

  // Every other non-task block skips without a contact; a literal recipient is
  // a complete instruction on its own and must not.
  const preview = previewWorkflow(spec, {
    callerHasContact: false,
    callSummary: "Asked for a quote.",
    mailConnections: [mailbox],
  });
  assert.deepEqual(preview.skippedActions, []);
  assert.equal(preview.actions.length, 1);
  const action = preview.actions[0]!;
  assert.equal(action.kind, "mail.draft.create");
  if (action.kind !== "mail.draft.create") return;
  assert.deepEqual(action.to, ["ops@acme.cz"]);
  assert.equal(action.mailboxAddress, "ops@acme.cz");
  assert.equal(action.approverUid, "user-1");
});

test("a draft fails closed on recipient, mailbox and evidence", () => {
  const contactSpec = mailSpec({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId: "google_1",
    recipient: { kind: "contact" },
  });
  const blockId = contactSpec.blocks[0]!.id;

  const noEmail = previewWorkflow(contactSpec, {
    callerHasContact: true,
    callSummary: "Asked for a quote.",
    contactEmail: null,
    mailConnections: [mailbox],
  });
  assert.deepEqual(noEmail.skippedActions, [{
    blockId,
    kind: "action.mail.draft.create",
    reason: "recipient_missing",
    matches: 0,
  }]);

  const noMailbox = previewWorkflow(contactSpec, {
    callerHasContact: true,
    callSummary: "Asked for a quote.",
    contactEmail: "buyer@acme.cz",
    mailConnections: [{ ...mailbox, active: false }],
  });
  assert.deepEqual(noMailbox.skippedActions.map((item) => item.reason), ["mailbox_unavailable"]);

  // The body template resolves entirely from call evidence, so a call with no
  // summary leaves nothing to say.
  const empty = previewWorkflow(mailSpec({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId: "google_1",
    recipient: { kind: "literal", email: "ops@acme.cz" },
    body: "{call.summary}",
  }), {
    callerHasContact: true,
    callSummary: null,
    mailConnections: [mailbox],
  });
  assert.deepEqual(empty.skippedActions.map((item) => item.reason), ["insufficient_context"]);
});

test("a draft block is rejected without an approver, a mailbox or a valid address", () => {
  const spec = mailSpec({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId: "",
    recipient: { kind: "literal", email: "not-an-address" },
  });
  const block = spec.blocks[0]!;
  if (block.kind !== "action.mail.draft.create") return;
  block.approval.approverUid = "";

  const validation = validateWorkflow(spec);
  assert.equal(validation.valid, false);
  const paths = [...validation.errors, ...validation.holes].map((entry) => entry.path);
  assert.ok(paths.includes("blocks[0].approval.approverUid"));
  assert.ok(paths.includes("blocks[0].mail.connectionId"));
  assert.ok(paths.includes("blocks[0].mail.recipient.email"));
});

test("a draft block is validated the same way inside an if branch", () => {
  const spec = createCallTaskWorkflow({ assigneeUid: "user-1", assigneeName: "Tomáš" });
  const branchBlock = createMailDraftBlock({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId: "google_1",
    recipient: { kind: "literal", email: "broken" },
  });
  spec.blocks = [{
    id: "if_1",
    kind: "control.if",
    condition: { field: "call.durationSeconds", operator: "gt", value: 30 },
    then: [branchBlock],
    else: [],
  }];

  // The validator has two dispatches; a kind wired into only one would pass at
  // the top level and be rejected here, or the reverse.
  const validation = validateWorkflow(spec);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => (
    entry.path === "blocks[0].then[0].mail.recipient.email"
  )));
});
