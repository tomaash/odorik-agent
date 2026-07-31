import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import {
  actionEffectDigest,
  legacyActionEffectDigest,
} from "../actions/contracts.js";
import {
  actionRegistry,
  createActionRegistry,
  executeRegisteredAction,
  type ActionDescriptor,
  type AnyActionDescriptor,
} from "../actions/registry.js";
import { caseMoveDescriptor } from "../actions/internal-actions.js";
import {
  approveAction,
  requestWorkflowActionApproval,
  type ApprovalDependencies,
} from "../approvals/repository.js";
import { MemoryFirestore } from "./firestore-harness.js";

const taskAction = {
  kind: "task.create",
  taskId: "task-1",
  title: "Call ACME back",
  instructions: null,
  assigneeUid: "member-1",
  assigneeName: "Member",
  dueAt: null,
  contactId: "contact-1",
  caseId: null,
  caseTitle: null,
  callId: "call-1",
  subject: { kind: "contact" },
  context: {
    callerName: "ACME",
    callerPhone: "+420777123456",
  },
};

const caseCreateAction = {
  kind: "case.create",
  caseId: "case-1",
  title: "Renew ACME",
  pipelineId: "default",
  stageId: "new",
  stageName: "New",
  ownerUid: "member-1",
  ownerName: "Member",
  contactId: "contact-1",
  callId: "call-1",
  context: { callerName: "ACME" },
};

const caseMoveAction = {
  kind: "case.move",
  movementId: "move-1",
  caseId: "case-1",
  caseTitle: "Renew ACME",
  pipelineId: "default",
  fromStageId: "new",
  fromStageName: "New",
  toStageId: "follow_up",
  toStageName: "Follow-up",
  expectedRevision: 0,
  contactId: "contact-1",
  callId: "call-1",
  context: { callerName: "ACME" },
};

test("production action registry is closed, approval-only, and digest compatible", () => {
  assert.deepEqual(
    actionRegistry.descriptors().map((descriptor) => ({
      kind: descriptor.kind,
      capabilityId: descriptor.capabilityId,
      category: descriptor.category,
      approval: descriptor.authorization.requiresApproval,
      idempotency: descriptor.idempotency,
      reconciliation: descriptor.reconciliation,
    })),
    [
      {
        kind: "task.create",
        capabilityId: "action.task.create",
        category: "company.write",
        approval: true,
        idempotency: "deterministic_internal",
        reconciliation: "deterministic_lookup",
      },
      {
        kind: "case.create",
        capabilityId: "action.case.create",
        category: "company.write",
        approval: true,
        idempotency: "deterministic_internal",
        reconciliation: "deterministic_lookup",
      },
      {
        kind: "case.move",
        capabilityId: "action.case.move",
        category: "company.write",
        approval: true,
        idempotency: "deterministic_internal",
        reconciliation: "deterministic_lookup",
      },
    ],
  );
  assert.throws(
    () => actionRegistry.resolve({ kind: "mail.send", recipient: "x@example.com" }),
    /Unregistered action kind/,
  );
  assert.throws(
    () => actionRegistry.resolve({ ...taskAction, undisclosed: true }),
  );

  assert.equal(
    actionEffectDigest(taskAction),
    "88f2b47336d9d9e04978112bdb890ff5b6fdffa32d4bc159f3b1c172aab70e40",
  );
  assert.equal(
    legacyActionEffectDigest(taskAction),
    "df607de3916b1b7b3d1f6580e29516cf7becf0c1a8c82cf0fd6e8008077799cd",
  );
  assert.equal(
    actionEffectDigest(caseCreateAction),
    "df101f68554ceb7139d3a2bc65aec103cc28a44d40862e3952f4fac84cc753bc",
  );
  assert.equal(
    legacyActionEffectDigest(caseCreateAction),
    "034d82263d479dcdd97f09e5c1c772ae87e22c865a9eb1b723c9a749ebe64faf",
  );
  assert.equal(
    actionEffectDigest(caseMoveAction),
    "8588bf25d15d04e6186d1fbf4770083b0b3345ba3a02bdcdd0ac4bcce04e1d4e",
  );
  assert.equal(
    legacyActionEffectDigest(caseMoveAction),
    "82db840bdd0412fe66d80ac26a93e0ab225fdd630b59667ada6ff46cce96dfca",
  );
});

const fakeActionSchema = z.object({
  kind: z.literal("external.test"),
  operationId: z.string().min(1),
  mode: z.enum(["success", "unknown", "invalid_result"]).default("success"),
}).strict();

const fakeResultSchema = z.object({
  providerResultId: z.string().min(1),
}).strict();

class UnknownProviderOutcome extends Error {}

function fakeExternalDescriptor(
  calls: { count: number },
): ActionDescriptor<
  z.infer<typeof fakeActionSchema>,
  z.infer<typeof fakeResultSchema>
> {
  return {
    kind: "external.test",
    capabilityId: "action.external.test",
    contractVersion: 1,
    category: "external.write",
    inputSchema: fakeActionSchema,
    resultSchema: fakeResultSchema,
    authorization: {
      requiresApproval: true,
      providerCapabilityId: "provider.test.write",
    },
    reversibility: "irreversible",
    idempotency: "provider_aware",
    reconciliation: "required_before_retry",
    async prepareForApproval(_context, action) {
      return action;
    },
    async assertRequestPreconditions() {},
    scope: () => ({ contactId: null, callId: "call-1", caseId: null }),
    async execute(_context, action) {
      calls.count += 1;
      if (action.mode === "unknown") {
        throw new UnknownProviderOutcome("Provider may have completed the operation");
      }
      if (action.mode === "invalid_result") {
        return { providerResultId: 42 } as unknown as {
          providerResultId: string;
        };
      }
      return { providerResultId: `provider-${action.operationId}` };
    },
    resultId: (_action, result) => result.providerResultId,
    resultReference: (_action, result) => ({
      kind: "external_test",
      id: result.providerResultId,
    }),
    classifyFailure: (error) => error instanceof UnknownProviderOutcome
      ? "outcome_unknown"
      : "failed_safe_to_retry",
  };
}

test("registry rejects duplicate, approval-optional, and incomplete external descriptors", () => {
  const calls = { count: 0 };
  const descriptor = fakeExternalDescriptor(calls);
  assert.throws(
    () => createActionRegistry([
      descriptor,
      descriptor,
    ] as unknown as AnyActionDescriptor[]),
    /Duplicate action kind/,
  );
  assert.throws(
    () => createActionRegistry([{
      ...descriptor,
      kind: "external.unapproved",
      capabilityId: "action.external.unapproved",
      authorization: { requiresApproval: false },
    } as unknown as AnyActionDescriptor]),
    /must require approval/,
  );
  assert.throws(
    () => createActionRegistry([{
      ...descriptor,
      kind: "external.no_grant",
      capabilityId: "action.external.no_grant",
      authorization: { requiresApproval: true },
    } as unknown as AnyActionDescriptor]),
    /must declare its provider capability/,
  );
});

test("registered execution requires an approval-bound context and validates results", async () => {
  const calls = { count: 0 };
  const registry = createActionRegistry([
    fakeExternalDescriptor(calls),
  ] as unknown as AnyActionDescriptor[]);
  const action = {
    kind: "external.test",
    operationId: "operation-1",
    mode: "success",
  };
  const source = {
    kind: "workflow" as const,
    callId: "call-1",
    workflowId: "workflow-1",
    workflowVersion: 1,
    runId: "run-1",
    blockId: "block-1",
  };
  await assert.rejects(
    executeRegisteredAction({
      registry,
      action,
      context: {
        companyId: "explorers",
        actorUid: "member-1",
        approvalId: "approval-1",
        approvedBy: "",
        attemptId: "attempt-1",
        source,
      },
    }),
    /Named approver is required/,
  );
  assert.equal(calls.count, 0);

  const executed = await executeRegisteredAction({
    registry,
    action,
    context: {
      companyId: "explorers",
      actorUid: "member-1",
      approvalId: "approval-1",
      approvedBy: "member-1",
      attemptId: "attempt-1",
      source,
    },
  });
  assert.equal(calls.count, 1);
  assert.deepEqual(executed.executionResult, {
    providerResultId: "provider-operation-1",
  });
  assert.deepEqual(executed.result, {
    kind: "external_test",
    id: "provider-operation-1",
  });
});

function approvalHarness(calls: { count: number }) {
  const memory = new MemoryFirestore();
  const registry = createActionRegistry([
    fakeExternalDescriptor(calls),
  ] as unknown as AnyActionDescriptor[]);
  const deps: ApprovalDependencies = {
    database: memory.asFirestore(),
    registry,
    resolveActiveMember: async (_companyId, uid) => ({
      uid,
      displayName: uid === "approver-1" ? "Approver One" : "Member",
      email: `${uid}@example.com`,
    }),
  };
  const source = {
    kind: "workflow" as const,
    callId: "call-1",
    workflowId: "workflow-1",
    workflowVersion: 1,
    runId: "run-1",
    blockId: "block-1",
  };
  return { memory, registry, deps, source };
}

test("approval kernel dispatches once and retains typed registry metadata", async () => {
  const calls = { count: 0 };
  const harness = approvalHarness(calls);
  await assert.rejects(
    requestWorkflowActionApproval({
      companyId: "explorers",
      actorUid: "workflow:workflow-1",
      approvalId: "approval-unregistered",
      approverUid: "approver-1",
      approverName: "Approver One",
      action: { kind: "external.unregistered" },
      source: harness.source,
    }, harness.deps),
    /Unregistered action kind/,
  );
  assert.equal(
    harness.memory.read(
      "companies/explorers/actionApprovals/approval-unregistered",
    ),
    undefined,
  );
  const input = {
    companyId: "explorers",
    actorUid: "workflow:workflow-1",
    approvalId: "approval-1",
    approverUid: "approver-1",
    approverName: "Stale name",
    action: {
      kind: "external.test",
      operationId: "operation-1",
      mode: "success",
    },
    source: harness.source,
  };
  const requested = await requestWorkflowActionApproval(
    input,
    harness.deps,
  ) as Record<string, unknown>;
  assert.equal(requested.duplicate, false);
  assert.equal(requested.approverName, "Approver One");
  assert.equal(requested.actionCapabilityId, "action.external.test");
  assert.equal(requested.actionContractVersion, 1);

  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "someone-else",
      approvalId: "approval-1",
    }, harness.deps),
    /Only the named approver/,
  );
  assert.equal(calls.count, 0);

  const executed = await approveAction({
    companyId: "explorers",
    actorUid: "approver-1",
    approvalId: "approval-1",
  }, harness.deps) as Record<string, unknown>;
  assert.equal(calls.count, 1);
  assert.equal(executed.duplicate, false);
  assert.deepEqual(executed.executionResult, {
    providerResultId: "provider-operation-1",
  });
  assert.deepEqual(
    harness.memory.read("companies/explorers/actionApprovals/approval-1")?.result,
    { kind: "external_test", id: "provider-operation-1" },
  );

  const repeated = await approveAction({
    companyId: "explorers",
    actorUid: "approver-1",
    approvalId: "approval-1",
  }, harness.deps) as Record<string, unknown>;
  assert.equal(repeated.duplicate, true);
  assert.equal(calls.count, 1);

  const duplicateRequest = await requestWorkflowActionApproval(
    input,
    harness.deps,
  ) as Record<string, unknown>;
  assert.equal(duplicateRequest.duplicate, true);
  assert.equal(calls.count, 1);
});

test("legacy approvals without registry metadata retain their original digest contract", async () => {
  const calls = { count: 0 };
  const harness = approvalHarness(calls);
  const action = {
    kind: "external.test",
    operationId: "legacy-operation",
    mode: "success",
  };
  harness.memory.seed("companies/explorers/actionApprovals/approval-legacy", {
    objectType: "action_approval",
    status: "pending",
    decisionStatus: "pending",
    executionStatus: "not_started",
    approverUid: "approver-1",
    approverName: "Approver One",
    action,
    scope: { contactId: null, callId: "call-1", caseId: null },
    result: null,
    effectDigest: actionEffectDigest(action),
    effectDigestVersion: "canonical-v1",
    source: harness.source,
    createdBy: "workflow:workflow-1",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  const result = await approveAction({
    companyId: "explorers",
    actorUid: "approver-1",
    approvalId: "approval-legacy",
  }, harness.deps) as Record<string, unknown>;
  assert.equal(result.status, "approved");
  assert.equal(calls.count, 1);
});

test("uncertain external outcomes cannot be blindly retried", async () => {
  const calls = { count: 0 };
  const harness = approvalHarness(calls);
  await requestWorkflowActionApproval({
    companyId: "explorers",
    actorUid: "workflow:workflow-1",
    approvalId: "approval-unknown",
    approverUid: "approver-1",
    approverName: "Approver One",
    action: {
      kind: "external.test",
      operationId: "operation-unknown",
      mode: "unknown",
    },
    source: harness.source,
  }, harness.deps);

  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "approver-1",
      approvalId: "approval-unknown",
    }, harness.deps),
    /Provider may have completed/,
  );
  assert.equal(calls.count, 1);
  assert.equal(
    harness.memory.read(
      "companies/explorers/actionApprovals/approval-unknown",
    )?.executionStatus,
    "outcome_unknown",
  );

  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "approver-1",
      approvalId: "approval-unknown",
    }, harness.deps),
    /outcome is unknown/,
  );
  assert.equal(calls.count, 1);
});

test("malformed executor results are never recorded as success", async () => {
  const calls = { count: 0 };
  const harness = approvalHarness(calls);
  await requestWorkflowActionApproval({
    companyId: "explorers",
    actorUid: "workflow:workflow-1",
    approvalId: "approval-invalid-result",
    approverUid: "approver-1",
    approverName: "Approver One",
    action: {
      kind: "external.test",
      operationId: "operation-invalid",
      mode: "invalid_result",
    },
    source: harness.source,
  }, harness.deps);

  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "approver-1",
      approvalId: "approval-invalid-result",
    }, harness.deps),
  );
  assert.equal(calls.count, 1);
  assert.equal(
    harness.memory.read(
      "companies/explorers/actionApprovals/approval-invalid-result",
    )?.executionStatus,
    "failed_safe_to_retry",
  );
});

test("tampered payloads and active leases call no executor", async () => {
  const calls = { count: 0 };
  const harness = approvalHarness(calls);
  const base = {
    companyId: "explorers",
    actorUid: "workflow:workflow-1",
    approverUid: "approver-1",
    approverName: "Approver One",
    source: harness.source,
  };
  await requestWorkflowActionApproval({
    ...base,
    approvalId: "approval-tampered",
    action: {
      kind: "external.test",
      operationId: "original",
      mode: "success",
    },
  }, harness.deps);
  harness.memory.patch(
    "companies/explorers/actionApprovals/approval-tampered",
    {
      action: {
        kind: "external.test",
        operationId: "changed",
        mode: "success",
      },
    },
  );
  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "approver-1",
      approvalId: "approval-tampered",
    }, harness.deps),
    /integrity validation/,
  );
  assert.equal(calls.count, 0);

  await requestWorkflowActionApproval({
    ...base,
    approvalId: "approval-leased",
    action: {
      kind: "external.test",
      operationId: "leased",
      mode: "success",
    },
  }, harness.deps);
  harness.memory.patch("companies/explorers/actionApprovals/approval-leased", {
    decisionStatus: "approved",
    executionStatus: "executing",
    status: "executing",
    executionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000),
  });
  await assert.rejects(
    approveAction({
      companyId: "explorers",
      actorUid: "approver-1",
      approvalId: "approval-leased",
    }, harness.deps),
    /already being executed/,
  );
  assert.equal(calls.count, 0);
});

test("case movement descriptor keeps exact stage and revision preconditions", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const casePath = "companies/explorers/cases/case-1";
  memory.seed(casePath, {
    objectType: "case",
    archived: false,
    contactId: "contact-1",
    pipelineId: "default",
    stageId: "new",
    revision: 0,
  });
  const action = caseMoveDescriptor.inputSchema.parse(caseMoveAction);

  await database.runTransaction(async (transaction) => {
    await caseMoveDescriptor.assertRequestPreconditions({
      companyId: "explorers",
      database,
      transaction,
    }, action);
  });

  memory.patch(casePath, { revision: 1 });
  await assert.rejects(
    database.runTransaction(async (transaction) => {
      await caseMoveDescriptor.assertRequestPreconditions({
        companyId: "explorers",
        database,
        transaction,
      }, action);
    }),
    /changed before the approval/,
  );
  assert.equal(memory.read(casePath)?.stageId, "new");
  assert.equal(memory.read(casePath)?.revision, 1);
});
