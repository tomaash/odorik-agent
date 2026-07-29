import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import {
  actionEffectDigest,
  executeWorkflowAction,
  legacyActionEffectDigest,
  parseWorkflowAction,
  type WorkflowAction,
  type WorkflowActionSource,
} from "../actions/contracts.js";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember } from "../tasks/repository.js";
import { pipelineStage } from "../pipeline/repository.js";

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

type ApprovalScope = {
  contactId: string | null;
  callId: string;
  caseId: string | null;
};

function scopeForAction(value: unknown): ApprovalScope {
  if (!value || typeof value !== "object") {
    return { contactId: null, callId: "", caseId: null };
  }
  const action = value as {
    kind?: unknown;
    contactId?: unknown;
    callId?: unknown;
    caseId?: unknown;
  };
  const caseId = (
    (action.kind === "case.move" || action.kind === "task.create")
    && typeof action.caseId === "string"
    && action.caseId
  )
    ? action.caseId
    : null;
  return {
    contactId: typeof action.contactId === "string" && action.contactId
      ? action.contactId
      : null,
    callId: typeof action.callId === "string" ? action.callId : "",
    caseId,
  };
}

function caseIdForApproval(data: FirebaseFirestore.DocumentData): string | null {
  if (typeof data.scope?.caseId === "string" && data.scope.caseId) {
    return data.scope.caseId;
  }
  const action = data.action as { kind?: unknown; caseId?: unknown } | undefined;
  if (
    (action?.kind === "case.move" || action?.kind === "task.create")
    && typeof action.caseId === "string"
    && action.caseId
  ) return action.caseId;
  return null;
}

function resultForAction(action: WorkflowAction): { kind: string; id: string } {
  if (action.kind === "task.create") return { kind: "task", id: action.taskId };
  if (action.kind === "case.create") return { kind: "case", id: action.caseId };
  return { kind: "case_movement", id: action.movementId };
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
  action: WorkflowAction;
  source: WorkflowActionSource;
}) {
  const approver = await activeMember(input.companyId, input.approverUid);
  let action = parseWorkflowAction(input.action);
  let linkedCaseRef: FirebaseFirestore.DocumentReference | null = null;
  let matchingCasesQuery: FirebaseFirestore.Query | null = null;
  if (action.kind === "task.create") {
    const assignee = await activeMember(input.companyId, action.assigneeUid);
    action = { ...action, assigneeName: assignee.displayName };
    if (action.caseId) {
      linkedCaseRef = db.doc(
        companyDocumentPath(input.companyId, "cases", action.caseId),
      );
    }
    if (action.subject?.kind === "matching_case" && action.contactId) {
      matchingCasesQuery = db.collection(
        companyCollectionPath(input.companyId, "cases"),
      ).where("contactId", "==", action.contactId);
    }
  } else if (action.kind === "case.create") {
    const [owner, stage] = await Promise.all([
      activeMember(input.companyId, action.ownerUid),
      pipelineStage(input.companyId, action.stageId),
    ]);
    action = { ...action, ownerName: owner.displayName, stageName: stage.name };
  } else {
    const [from, to] = await Promise.all([
      pipelineStage(input.companyId, action.fromStageId),
      pipelineStage(input.companyId, action.toStageId),
    ]);
    action = {
      ...action,
      fromStageName: from.name,
      toStageName: to.name,
    };
    linkedCaseRef = db.doc(
      companyDocumentPath(input.companyId, "cases", action.caseId),
    );
  }
  const approvalRef = db.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = db.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  const digest = actionEffectDigest(action);
  const scope = scopeForAction(action);
  const caseId = scope.caseId;
  const taskMatchingSubject = action.kind === "task.create"
    && action.subject?.kind === "matching_case"
    ? action.subject
    : null;
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(approvalRef);
    if (existing.exists) {
      return jsonSafe({ id: existing.id, ...existing.data(), duplicate: true });
    }
    const linkedCase = linkedCaseRef && !matchingCasesQuery
      ? await transaction.get(linkedCaseRef)
      : null;
    const matchingCases = matchingCasesQuery
      ? await transaction.get(matchingCasesQuery)
      : null;
    if (action.kind === "task.create" && action.caseId) {
      const selectedCase = matchingCases
        ? matchingCases.docs.find((document) => document.id === action.caseId) || null
        : linkedCase;
      const activeMatches = matchingCases?.docs.filter((document) => {
        const data = document.data();
        return data.objectType === "case"
          && data.archived !== true
          && String(data.pipelineId || "default") === taskMatchingSubject?.pipelineId
          && data.stageId === taskMatchingSubject?.stageId;
      });
      if (
        !selectedCase?.exists
        || selectedCase.data()?.objectType !== "case"
        || selectedCase.data()?.archived === true
        || selectedCase.data()?.contactId !== action.contactId
        || (
          taskMatchingSubject
          && (
            activeMatches?.length !== 1
            || activeMatches[0]?.id !== action.caseId
          )
        )
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The task's selected case is no longer an active unique match.",
        });
      }
    }
    if (action.kind === "case.move") {
      if (
        !linkedCase?.exists
        || linkedCase.data()?.objectType !== "case"
        || linkedCase.data()?.archived === true
        || linkedCase.data()?.contactId !== action.contactId
        || String(linkedCase.data()?.pipelineId || "default") !== action.pipelineId
        || linkedCase.data()?.stageId !== action.fromStageId
        || Number(linkedCase.data()?.revision || 0) !== action.expectedRevision
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The selected case changed before the approval could be requested.",
        });
      }
    }
    const now = Timestamp.now();
    const approval = {
      objectType: "action_approval",
      status: "pending" satisfies ApprovalStatus,
      decisionStatus: "pending" satisfies DecisionStatus,
      executionStatus: "not_started" satisfies ExecutionStatus,
      approverUid: approver.uid,
      approverName: approver.displayName,
      action,
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
}) {
  const approvalRef = db.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  return db.runTransaction(async (transaction) => {
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
    const caseId = caseIdForApproval(data);
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
}) {
  if (!input.attemptId) return;
  const auditRef = db.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(input.ref);
    if (latest.data()?.executionAttemptId !== input.attemptId) return;
    const message = input.error instanceof Error
      ? input.error.message.slice(0, 500)
      : "Action execution failed.";
    const now = Timestamp.now();
    transaction.update(input.ref, {
      status: "execution_failed",
      decisionStatus: "approved",
      executionStatus: "failed_safe_to_retry",
      executionError: message,
      executionLeaseExpiresAt: null,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      ...(caseIdForApproval(latest.data() || {}) ? {
        caseId: caseIdForApproval(latest.data() || {}),
      } : {}),
      type: "approval_execution_failed",
      actor: { kind: "user", id: input.actorUid },
      before: { executionStatus: "executing" },
      after: {
        decisionStatus: "approved",
        executionStatus: "failed_safe_to_retry",
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
}) {
  const claimed = await claimApproval(input);
  if (claimed.alreadyApproved) {
    return jsonSafe({ id: input.approvalId, ...claimed.data, duplicate: true });
  }

  let action: WorkflowAction;
  try {
    action = parseWorkflowAction(claimed.data.action);
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
    });
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The approved action payload failed integrity validation.",
    });
  }

  try {
    const execution = await executeWorkflowAction({
      companyId: input.companyId,
      actorUid: input.actorUid,
      approvalId: input.approvalId,
      action,
      source: claimed.data.source as WorkflowActionSource,
    });
    const auditRef = db.collection(
      companyCollectionPath(input.companyId, "auditEvents"),
    ).doc();
    const now = Timestamp.now();
    const caseId = caseIdForApproval({ action, scope: claimed.data.scope })
      || (action.kind === "case.create" ? action.caseId : null);
    const result = resultForAction(action);
    await db.runTransaction(async (transaction) => {
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
        result,
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
      result,
      executionResult: execution.result,
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
    });
    throw error;
  }
}

export async function rejectAction(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  note?: string;
}) {
  const approvalRef = db.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = db.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  return db.runTransaction(async (transaction) => {
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
    const caseId = caseIdForApproval(data);
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
