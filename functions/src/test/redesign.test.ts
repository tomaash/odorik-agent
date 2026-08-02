import assert from "node:assert/strict";
import test from "node:test";
import {
  actionEffectDigest,
  legacyActionEffectDigest,
  parseWorkflowAction,
} from "../actions/contracts.js";
import { workflowRuntimeFlags } from "../workflow/runtime.js";
import { projectedCallContactAccess } from "../calls.js";

test("internal workflow engine defaults on and retains its kill switch", () => {
  // The legacy call-to-CRM path is gone, so the engine is the only consumer of
  // a completed call and there is nothing left to fall back to.
  assert.deepEqual(workflowRuntimeFlags({}), { enabled: true });
  assert.deepEqual(
    workflowRuntimeFlags({ WORKFLOW_ENGINE_ENABLED: "false" }),
    { enabled: false },
  );
});

test("call-created contacts inherit and union only enabled source audiences", () => {
  assert.deepEqual(projectedCallContactAccess({
    existing: undefined,
    call: {
      access: { visibility: "restricted", memberIds: ["member-b", "member-a"] },
      indexingEnabled: true,
    },
  }), {
    access: { visibility: "restricted", memberIds: ["member-a", "member-b"] },
    indexingEnabled: true,
  });
  assert.deepEqual(projectedCallContactAccess({
    existing: {
      access: { visibility: "restricted", memberIds: ["member-a"] },
      indexingEnabled: true,
    },
    call: {
      access: { visibility: "company" },
      indexingEnabled: true,
    },
  }), {
    access: { visibility: "company" },
    indexingEnabled: true,
  });
  assert.deepEqual(projectedCallContactAccess({
    existing: {
      access: { visibility: "company" },
      indexingEnabled: false,
    },
    call: {
      access: { visibility: "restricted", memberIds: ["member-b"] },
      indexingEnabled: true,
    },
  }), {
    access: { visibility: "restricted", memberIds: ["member-b"] },
    indexingEnabled: true,
  });
  assert.deepEqual(projectedCallContactAccess({
    existing: undefined,
    call: {
      access: { visibility: "company" },
      indexingEnabled: false,
    },
  }), {
    access: { visibility: "restricted", memberIds: [] },
    indexingEnabled: false,
  });
});

test("typed workflow actions reject unsupported effects and use a stable digest", () => {
  const action = parseWorkflowAction({
    kind: "case.move",
    movementId: "movement-1",
    caseId: "case-1",
    caseTitle: "Renew ACME",
    pipelineId: "default",
    fromStageId: "new",
    fromStageName: "New",
    toStageId: "in_progress",
    toStageName: "In progress",
    expectedRevision: 2,
    contactId: "contact-1",
    callId: "call-1",
    context: {
      callerPhone: "+420777123456",
      callerName: "ACME",
    },
  });
  assert.equal(actionEffectDigest(action), actionEffectDigest({ ...action }));
  assert.throws(() => parseWorkflowAction({
    kind: "email.send",
    recipient: "customer@example.com",
  }));
  assert.throws(() => parseWorkflowAction({
    ...action,
    pipelineId: "unregistered-pipeline",
  }));
});

test("task action subjects disclose and enforce their relationship target", () => {
  const base = {
    kind: "task.create" as const,
    taskId: "task-1",
    title: "Call ACME back",
    instructions: null,
    assigneeUid: "member-1",
    assigneeName: "Member",
    dueAt: null,
    callId: "call-1",
    context: {
      callerPhone: "+420777123456",
      callerName: "ACME",
    },
  };

  const caseTask = parseWorkflowAction({
    ...base,
    contactId: "contact-1",
    caseId: "case-1",
    caseTitle: "Renew ACME",
    subject: {
      kind: "matching_case",
      pipelineId: "default",
      stageId: "new",
      stageName: "New",
    },
  });
  assert.equal(caseTask.kind, "task.create");
  assert.equal(caseTask.caseId, "case-1");

  assert.throws(() => parseWorkflowAction({
    ...base,
    contactId: null,
    caseId: null,
    subject: {
      kind: "matching_case",
      pipelineId: "default",
      stageId: "new",
      stageName: "New",
    },
  }));
  assert.throws(() => parseWorkflowAction({
    ...base,
    contactId: "contact-1",
    caseId: null,
    subject: { kind: "internal" },
  }));
});

test("deployed task actions without a subject keep their historical digest", () => {
  const legacyAction = {
    kind: "task.create" as const,
    taskId: "legacy-task",
    title: "Legacy follow-up",
    instructions: null,
    assigneeUid: "member-1",
    assigneeName: "Member",
    dueAt: null,
    contactId: "contact-1",
    callId: "call-1",
    context: {
      callerName: "ACME",
      callerPhone: "+420777123456",
    },
  };

  const parsed = parseWorkflowAction(legacyAction);
  assert.equal(parsed.kind, "task.create");
  assert.equal(parsed.subject, undefined);
  assert.equal(parsed.caseId, undefined);
  assert.equal(
    legacyActionEffectDigest(parsed),
    legacyActionEffectDigest(legacyAction),
  );
});
