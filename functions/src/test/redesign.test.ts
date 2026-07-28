import assert from "node:assert/strict";
import test from "node:test";
import { workflowRuntimeFlags } from "../workflow/runtime.js";

test("internal workflow engine defaults on and retains explicit kill switches", () => {
  assert.deepEqual(workflowRuntimeFlags({}), {
    enabled: true,
    legacyCrmEnabled: true,
  });
  assert.deepEqual(workflowRuntimeFlags({
    WORKFLOW_ENGINE_ENABLED: "false",
    LEGACY_CRM_ENABLED: "false",
  }), {
    enabled: false,
    legacyCrmEnabled: false,
  });
});
