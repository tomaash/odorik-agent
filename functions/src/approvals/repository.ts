import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import type { TaskRecipePreview } from "@agent-erik/workflow";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember, createTask, type TaskSource } from "../tasks/repository.js";

export type ApprovalStatus =
  | "pending"
  | "executing"
  | "approved"
  | "rejected"
  | "execution_failed";

type WorkflowApprovalSource = TaskSource & {
  kind: "workflow";
  callId: string;
  workflowId: string;
  workflowVersion: number;
  runId: string;
  blockId: string;
};

function effectDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function requestWorkflowTaskApproval(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  taskId: string;
  preview: TaskRecipePreview;
  contactId?: string | null;
  callId: string;
  source: WorkflowApprovalSource;
}) {
  const [approver, assignee] = await Promise.all([
    activeMember(input.companyId, input.preview.approverUid),
    activeMember(input.companyId, input.preview.assigneeUid),
  ]);
  const approvalRef = db.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const auditRef = db.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  const action = {
    kind: "task.create",
    taskId: input.taskId,
    title: input.preview.title,
    instructions: input.preview.instructions,
    assigneeUid: assignee.uid,
    assigneeName: assignee.displayName,
    dueAt: input.preview.dueAt,
    contactId: input.contactId || null,
    callId: input.callId,
    context: input.preview.context,
  };
  const digest = effectDigest(action);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(approvalRef);
    if (existing.exists) {
      return jsonSafe({ id: existing.id, ...existing.data(), duplicate: true });
    }
    const now = Timestamp.now();
    const approval = {
      objectType: "action_approval",
      status: "pending" satisfies ApprovalStatus,
      approverUid: approver.uid,
      approverName: approver.displayName,
      action,
      effectDigest: digest,
      source: input.source,
      createdBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
    };
    transaction.create(approvalRef, approval);
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: approvalRef.id,
      type: "approval_requested",
      actor: { kind: "system", id: input.actorUid },
      after: {
        status: "pending",
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
  approverUid?: string;
  limit?: number;
}) {
  const snapshot = await db.collection(
    companyCollectionPath(input.companyId, "actionApprovals"),
  )
    .orderBy("createdAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return jsonSafe(snapshot.docs
    .filter((document) => {
      const data = document.data();
      if (data.objectType !== "action_approval") return false;
      if (input.status && data.status !== input.status) return false;
      if (input.approverUid && data.approverUid !== input.approverUid) return false;
      return true;
    })
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
    if (data.status === "approved") {
      return { ref: approvalRef, data, alreadyApproved: true };
    }
    if (data.status === "rejected") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This action was rejected and cannot execute.",
      });
    }
    if (
      data.status !== "pending"
      && data.status !== "executing"
      && data.status !== "execution_failed"
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This approval request cannot execute.",
      });
    }
    if (data.status === "executing" && data.approvedBy !== input.actorUid) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This approval request is already being executed.",
      });
    }
    const now = Timestamp.now();
    transaction.update(approvalRef, {
      status: "executing",
      approvedBy: input.actorUid,
      approvedAt: data.approvedAt || now,
      executionError: null,
      updatedAt: now,
    });
    return { ref: approvalRef, data, alreadyApproved: false };
  });
}

export async function approveAction(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
}) {
  const claimed = await claimApproval(input);
  if (claimed.alreadyApproved) {
    return jsonSafe({
      id: input.approvalId,
      ...claimed.data,
      duplicate: true,
    });
  }
  const action = claimed.data.action as {
    kind?: unknown;
    taskId?: unknown;
    title?: unknown;
    instructions?: unknown;
    assigneeUid?: unknown;
    dueAt?: unknown;
    contactId?: unknown;
    callId?: unknown;
    context?: unknown;
  };
  const source = claimed.data.source as WorkflowApprovalSource;
  if (
    action.kind !== "task.create"
    || typeof action.taskId !== "string"
    || typeof action.title !== "string"
    || typeof action.assigneeUid !== "string"
  ) {
    await claimed.ref.update({
      status: "execution_failed",
      executionError: "The approved action payload is invalid.",
      updatedAt: Timestamp.now(),
    });
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The approved action payload is invalid.",
    });
  }
  try {
    const task = await createTask({
      companyId: input.companyId,
      actorUid: input.actorUid,
      title: action.title,
      instructions: typeof action.instructions === "string"
        ? action.instructions
        : undefined,
      assigneeUid: action.assigneeUid,
      dueAt: typeof action.dueAt === "string" ? action.dueAt : null,
      contactId: typeof action.contactId === "string" ? action.contactId : null,
      callId: typeof action.callId === "string" ? action.callId : null,
      source: {
        ...source,
        approvalId: input.approvalId,
        approvedBy: input.actorUid,
      },
      context: action.context && typeof action.context === "object"
        ? action.context as Record<string, string | null>
        : undefined,
      deterministicId: action.taskId,
    });
    const auditRef = db.collection(
      companyCollectionPath(input.companyId, "auditEvents"),
    ).doc();
    const now = Timestamp.now();
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(claimed.ref);
      if (latest.data()?.status === "rejected") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This action was rejected before execution completed.",
        });
      }
      transaction.update(claimed.ref, {
        status: "approved",
        taskId: action.taskId,
        executedAt: now,
        executionError: null,
        updatedAt: now,
      });
      transaction.create(auditRef, {
        aggregateType: "action_approval",
        aggregateId: input.approvalId,
        type: "approval_executed",
        actor: { kind: "user", id: input.actorUid },
        before: { status: latest.data()?.status || "executing" },
        after: {
          status: "approved",
          taskId: action.taskId,
          effectDigest: latest.data()?.effectDigest || null,
        },
        createdAt: now,
      });
    });
    return jsonSafe({
      id: input.approvalId,
      status: "approved",
      task,
      duplicate: false,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") throw error;
    await claimed.ref.update({
      status: "execution_failed",
      executionError: error instanceof Error
        ? error.message.slice(0, 500)
        : "Action execution failed.",
      updatedAt: Timestamp.now(),
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
    if (data.status === "rejected") {
      return jsonSafe({ id: snapshot.id, ...data, duplicate: true });
    }
    if (data.status !== "pending") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only a pending action can be rejected.",
      });
    }
    const now = Timestamp.now();
    const note = String(input.note || "").trim().slice(0, 2_000) || null;
    transaction.update(approvalRef, {
      status: "rejected",
      rejectedBy: input.actorUid,
      rejectedAt: now,
      rejectionNote: note,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      type: "approval_rejected",
      actor: { kind: "user", id: input.actorUid },
      before: { status: "pending" },
      after: {
        status: "rejected",
        effectDigest: data.effectDigest || null,
        note,
      },
      createdAt: now,
    });
    return jsonSafe({
      id: input.approvalId,
      ...data,
      status: "rejected",
      rejectionNote: note,
      rejectedAt: now,
      duplicate: false,
    });
  });
}
