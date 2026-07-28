import assert from "node:assert/strict";
import test from "node:test";
import {
  createCallTaskWorkflow,
  createIfBlock,
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
  conditional.then[0]!.task.title = "Prepare quote";
  conditional.else.push(createTaskBlock({
    id: "task_no_quote",
    title: "No quote requested",
    assigneeUid: "user-2",
    assigneeName: "Josef",
  }));
  spec.blocks = [conditional];

  const matching = previewWorkflowTasks(spec, {
    transcriptText: "Please send a quote tomorrow.",
  });
  const notMatching = previewWorkflowTasks(spec, {
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
  conditional.then[0]!.task.title = "Known customer";
  conditional.else.push(createTaskBlock({
    id: "task_unknown",
    title: "Unknown caller",
    assigneeUid: "user-1",
    assigneeName: "Tomáš",
  }));
  spec.blocks = [conditional];

  const preview = previewWorkflow(spec, { callerHasContact: false });
  assert.deepEqual(preview.tasks.map((task) => task.title), ["Unknown caller"]);
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
