import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import {
  actionEffectDigest,
  legacyActionEffectDigest,
  type WorkflowActionSource,
} from "../actions/contracts.js";
import {
  actionRegistry,
  executeRegisteredAction,
  type AnyActionDescriptor,
  type ActionFailureStatus,
  type ActionRegistry,
  type RegisteredAction,
} from "../actions/registry.js";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember } from "../tasks/repository.js";

export type ApprovalStatus =
  | "pending"
  | "executing"
  | "approved"
  | "rejected"
  | "execution_failed";

type DecisionStatus = "pending" | "approved" | "rejected";
type ExecutionStatus =
  | "not_started"
  | "executing"
  | "succeeded"
  | "failed_safe_to_retry"
  | "outcome_unknown";

const executionLeaseMs = 5 * 60 * 1_000;

export type ApprovalDependencies = {
  database: FirebaseFirestore.Firestore;
  registry: ActionRegistry;
  resolveActiveMember: typeof activeMember;
};

const defaultApprovalDependencies: ApprovalDependencies = {
  database: db,
  registry: actionRegistry,
  resolveActiveMember: activeMember,
};

function dependencies(
  overrides?: Partial<ApprovalDependencies>,
): ApprovalDependencies {
  return {
    ...defaultApprovalDependencies,
    ...overrides,
  };
}

function caseIdForApproval(
  data: FirebaseFirestore.DocumentData,
  registry: ActionRegistry,
): string | null {
  if (typeof data.scope?.caseId === "string" && data.scope.caseId) {
    return data.scope.caseId;
  }
  try {
    const resolved = registry.resolve(data.action);
    return resolved.descriptor.scope(resolved.action).caseId;
  } catch {
    // Historical or malformed approvals without scope have no safe case link.
  }
  return null;
}

function inferredDecision(data: FirebaseFirestore.DocumentData): DecisionStatus {
  if (data.decisionStatus === "approved" || data.decisionStatus === "rejected") {
    return data.decisionStatus;
  }
  if (data.status === "rejected") return "rejected";
  if (data.status === "executing" || data.status === "approved" || data.status === "execution_failed") {
    return "approved";
  }
  return "pending";
}

function inferredExecution(data: FirebaseFirestore.DocumentData): ExecutionStatus {
  if (
    data.executionStatus === "not_started"
    || data.executionStatus === "executing"
    || data.executionStatus === "succeeded"
    || data.executionStatus === "failed_safe_to_retry"
    || data.executionStatus === "outcome_unknown"
  ) return data.executionStatus;
  if (data.status === "approved") return "succeeded";
  if (data.status === "executing") return "executing";
  if (data.status === "execution_failed") return "failed_safe_to_retry";
  return "not_started";
}

export async function requestWorkflowActionApproval(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  approverUid: string;
  approverName: string;
  action: unknown;
  source: WorkflowActionSource;
}, overrides?: Partial<ApprovalDependencies>) {
  const deps = dependencies(overrides);
  const approver = await deps.resolveActiveMember(
    input.companyId,
    input.approverUid,
  );
  const resolved = deps.registry.resolve(input.action);
  const prepared = await resolved.descriptor.prepareForApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    database: deps.database,
    resolveActiveMember: deps.resolveActiveMember,
  }, resolved.action);
  const action = resolved.descriptor.inputSchema.parse(prepared);
  const approvalRef = deps.database.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = deps.database.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  const digest = actionEffectDigest(action);
  const scope = resolved.descriptor.scope(action);
  const caseId = scope.caseId;
  return deps.database.runTransaction(async (transaction) => {
    const existing = await transaction.get(approvalRef);
    if (existing.exists) {
      return jsonSafe({ id: existing.id, ...existing.data(), duplicate: true });
    }
    await resolved.descriptor.assertRequestPreconditions({
      companyId: input.companyId,
      database: deps.database,
      transaction,
    }, action);
    const now = Timestamp.now();
    const approval = {
      objectType: "action_approval",
      status: "pending" satisfies ApprovalStatus,
      decisionStatus: "pending" satisfies DecisionStatus,
      executionStatus: "not_started" satisfies ExecutionStatus,
      approverUid: approver.uid,
      approverName: approver.displayName,
      action,
      actionCapabilityId: resolved.descriptor.capabilityId,
      actionContractVersion: resolved.descriptor.contractVersion,
      scope,
      result: null,
      effectDigest: digest,
      effectDigestVersion: "canonical-v1",
      source: input.source,
      createdBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
    };
    transaction.create(approvalRef, approval);
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: approvalRef.id,
      ...(caseId ? { caseId } : {}),
      type: "approval_requested",
      actor: { kind: "system", id: input.actorUid },
      after: {
        decisionStatus: "pending",
        executionStatus: "not_started",
        approverUid: approver.uid,
        actionKind: action.kind,
        actionCapabilityId: resolved.descriptor.capabilityId,
        actionContractVersion: resolved.descriptor.contractVersion,
        effectDigest: digest,
        source: input.source,
      },
      createdAt: now,
    });
    return jsonSafe({ id: approvalRef.id, ...approval, duplicate: false });
  });
}

export async function listActionApprovals(input: {
  companyId: string;
  status?: ApprovalStatus;
  statuses?: ApprovalStatus[];
  approverUid?: string;
  limit?: number;
}) {
  let query: FirebaseFirestore.Query = db.collection(
    companyCollectionPath(input.companyId, "actionApprovals"),
  );
  const statuses = [...new Set(input.statuses || (input.status ? [input.status] : []))];
  if (statuses.length === 1) query = query.where("status", "==", statuses[0]);
  if (statuses.length > 1) query = query.where("status", "in", statuses);
  if (input.approverUid) query = query.where("approverUid", "==", input.approverUid);
  const snapshot = await query
    .orderBy("createdAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return jsonSafe(snapshot.docs
    .filter((document) => document.data().objectType === "action_approval")
    .map((document) => ({ id: document.id, ...document.data() })));
}

async function claimApproval(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
}, deps: ApprovalDependencies) {
  const approvalRef = deps.database.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = deps.database.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  return deps.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(approvalRef);
    if (!snapshot.exists) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found." });
    }
    const data = snapshot.data() || {};
    if (data.approverUid !== input.actorUid) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the named approver can approve this action.",
      });
    }
    const decisionStatus = inferredDecision(data);
    const executionStatus = inferredExecution(data);
    if (decisionStatus === "rejected") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This action was rejected and cannot execute.",
      });
    }
    if (decisionStatus === "approved" && executionStatus === "succeeded") {
      return { ref: approvalRef, data, alreadyApproved: true, attemptId: null };
    }
    if (executionStatus === "outcome_unknown") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The prior execution outcome is unknown. Review the audit trail before retrying.",
      });
    }
    const leaseExpiresAt = data.executionLeaseExpiresAt?.toMillis?.() || 0;
    if (executionStatus === "executing" && leaseExpiresAt > Date.now()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This approved action is already being executed.",
      });
    }

    const attemptId = randomUUID();
    const now = Timestamp.now();
    const caseId = caseIdForApproval(data, deps.registry);
    transaction.update(approvalRef, {
      status: "executing",
      decisionStatus: "approved",
      executionStatus: "executing",
      approvedBy: data.approvedBy || input.actorUid,
      approvedAt: data.approvedAt || now,
      executionAttemptId: attemptId,
      executionLeaseExpiresAt: Timestamp.fromMillis(now.toMillis() + executionLeaseMs),
      executionError: null,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      ...(caseId ? { caseId } : {}),
      type: decisionStatus === "pending" ? "approval_approved" : "approval_execution_retried",
      actor: { kind: "user", id: input.actorUid },
      before: { decisionStatus, executionStatus },
      after: {
        decisionStatus: "approved",
        executionStatus: "executing",
        attemptId,
        effectDigest: data.effectDigest || null,
      },
      createdAt: now,
    });
    return { ref: approvalRef, data, alreadyApproved: false, attemptId };
  });
}

async function markExecutionFailed(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  ref: FirebaseFirestore.DocumentReference;
  attemptId: string | null;
  error: unknown;
  executionStatus: ActionFailureStatus;
}, deps: ApprovalDependencies) {
  if (!input.attemptId) return;
  const auditRef = deps.database.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  await deps.database.runTransaction(async (transaction) => {
    const latest = await transaction.get(input.ref);
    if (latest.data()?.executionAttemptId !== input.attemptId) return;
    const message = input.error instanceof Error
      ? input.error.message.slice(0, 500)
      : "Action execution failed.";
    const now = Timestamp.now();
    const caseId = caseIdForApproval(latest.data() || {}, deps.registry);
    transaction.update(input.ref, {
      status: "execution_failed",
      decisionStatus: "approved",
      executionStatus: input.executionStatus,
      executionError: message,
      executionLeaseExpiresAt: null,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      ...(caseId ? { caseId } : {}),
      type: "approval_execution_failed",
      actor: { kind: "user", id: input.actorUid },
      before: { executionStatus: "executing" },
      after: {
        decisionStatus: "approved",
        executionStatus: input.executionStatus,
        error: message,
      },
      createdAt: now,
    });
  });
}

export async function approveAction(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
}, overrides?: Partial<ApprovalDependencies>) {
  const deps = dependencies(overrides);
  const claimed = await claimApproval(input, deps);
  if (claimed.alreadyApproved) {
    return jsonSafe({ id: input.approvalId, ...claimed.data, duplicate: true });
  }

  let action: RegisteredAction;
  let descriptor: AnyActionDescriptor;
  try {
    const resolved = deps.registry.resolve(claimed.data.action);
    action = resolved.action;
    descriptor = resolved.descriptor;
    if (
      claimed.data.actionCapabilityId
      && claimed.data.actionCapabilityId !== descriptor.capabilityId
    ) {
      throw new Error("The approved action capability no longer matches its record.");
    }
    if (
      claimed.data.actionContractVersion !== undefined
      && Number(claimed.data.actionContractVersion) !== descriptor.contractVersion
    ) {
      throw new Error("The approved action contract version is not supported.");
    }
    const expectedDigest = claimed.data.effectDigestVersion === "canonical-v1"
      ? actionEffectDigest(action)
      : legacyActionEffectDigest(action);
    if (expectedDigest !== claimed.data.effectDigest) {
      throw new Error("The approved action no longer matches its recorded effect.");
    }
  } catch (error) {
    await markExecutionFailed({
      companyId: input.companyId,
      actorUid: input.actorUid,
      approvalId: input.approvalId,
      ref: claimed.ref,
      attemptId: claimed.attemptId,
      error: error instanceof Error ? error : new Error("Invalid action."),
      executionStatus: "failed_safe_to_retry",
    }, deps);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The approved action payload failed integrity validation.",
    });
  }

  try {
    const execution = await executeRegisteredAction({
      registry: deps.registry,
      action,
      context: {
        companyId: input.companyId,
        actorUid: input.actorUid,
        approvalId: input.approvalId,
        approvedBy: claimed.data.approvedBy || input.actorUid,
        attemptId: claimed.attemptId!,
        source: claimed.data.source as WorkflowActionSource,
      },
    });
    const auditRef = deps.database.collection(
      companyCollectionPath(input.companyId, "auditEvents"),
    ).doc();
    const now = Timestamp.now();
    const caseId = caseIdForApproval(
      { action, scope: claimed.data.scope },
      deps.registry,
    ) || (execution.result.kind === "case" ? execution.result.id : null);
    await deps.database.runTransaction(async (transaction) => {
      const latest = await transaction.get(claimed.ref);
      if (latest.data()?.executionAttemptId !== claimed.attemptId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A newer execution attempt replaced this one.",
        });
      }
      transaction.update(claimed.ref, {
        status: "approved",
        decisionStatus: "approved",
        executionStatus: "succeeded",
        resultId: execution.resultId,
        result: execution.result,
        executionResult: execution.executionResult,
        executedAt: now,
        executionLeaseExpiresAt: null,
        executionError: null,
        updatedAt: now,
      });
      transaction.create(auditRef, {
        aggregateType: "action_approval",
        aggregateId: input.approvalId,
        ...(caseId ? { caseId } : {}),
        type: "approval_executed",
        actor: { kind: "user", id: input.actorUid },
        before: { executionStatus: "executing" },
        after: {
          decisionStatus: "approved",
          executionStatus: "succeeded",
          actionKind: action.kind,
          actionCapabilityId: descriptor.capabilityId,
          actionContractVersion: descriptor.contractVersion,
          resultId: execution.resultId,
          effectDigest: latest.data()?.effectDigest || null,
        },
        createdAt: now,
      });
    });
    return jsonSafe({
      id: input.approvalId,
      status: "approved",
      actionKind: action.kind,
      resultId: execution.resultId,
      result: execution.result,
      executionResult: execution.executionResult,
      duplicate: false,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.message === "A newer execution attempt replaced this one.") {
      throw error;
    }
    await markExecutionFailed({
      companyId: input.companyId,
      actorUid: input.actorUid,
      approvalId: input.approvalId,
      ref: claimed.ref,
      attemptId: claimed.attemptId,
      error,
      executionStatus: descriptor.classifyFailure(error, "execution"),
    }, deps);
    throw error;
  }
}

export async function rejectAction(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  note?: string;
}, overrides?: Partial<ApprovalDependencies>) {
  const deps = dependencies(overrides);
  const approvalRef = deps.database.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = deps.database.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  return deps.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(approvalRef);
    if (!snapshot.exists) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found." });
    }
    const data = snapshot.data() || {};
    if (data.approverUid !== input.actorUid) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the named approver can reject this action.",
      });
    }
    if (inferredDecision(data) === "rejected") {
      return jsonSafe({ id: snapshot.id, ...data, duplicate: true });
    }
    if (inferredDecision(data) !== "pending") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "An approved action can no longer be rejected.",
      });
    }
    const now = Timestamp.now();
    const note = String(input.note || "").trim().slice(0, 2_000) || null;
    const caseId = caseIdForApproval(data, deps.registry);
    transaction.update(approvalRef, {
      status: "rejected",
      decisionStatus: "rejected",
      executionStatus: "not_started",
      rejectedBy: input.actorUid,
      rejectedAt: now,
      rejectionNote: note,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      ...(caseId ? { caseId } : {}),
      type: "approval_rejected",
      actor: { kind: "user", id: input.actorUid },
      before: { decisionStatus: "pending", executionStatus: "not_started" },
      after: {
        decisionStatus: "rejected",
        executionStatus: "not_started",
        effectDigest: data.effectDigest || null,
        note,
      },
      createdAt: now,
    });
    return jsonSafe({
      id: input.approvalId,
      ...data,
      status: "rejected",
      decisionStatus: "rejected",
      executionStatus: "not_started",
      rejectionNote: note,
      rejectedAt: now,
      duplicate: false,
    });
  });
}
