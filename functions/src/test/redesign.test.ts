import assert from "node:assert/strict";
import test from "node:test";
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
