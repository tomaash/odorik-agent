import assert from "node:assert/strict";
import test from "node:test";
import {
  actionEffectDigest,
  parseWorkflowAction,
} from "../actions/contracts.js";
import { workflowRuntimeFlags } from "../workflow/runtime.js";

test("internal workflow engine defaults on and retains its kill switch", () => {
  // The legacy call-to-CRM path is gone, so the engine is the only consumer of
  // a completed call and there is nothing left to fall back to.
  assert.deepEqual(workflowRuntimeFlags({}), { enabled: true });
  assert.deepEqual(
    workflowRuntimeFlags({ WORKFLOW_ENGINE_ENABLED: "false" }),
    { enabled: false },
  );
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
