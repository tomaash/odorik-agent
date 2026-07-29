import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";

export type TaskStatus = "open" | "completed" | "dismissed";

export type TaskSource = {
  kind: "manual" | "call" | "case" | "workflow";
  callId?: string;
  caseId?: string;
  workflowId?: string;
  workflowVersion?: number;
  runId?: string;
  blockId?: string;
  approvalId?: string;
  approvedBy?: string;
};

export type CreateTaskInput = {
  companyId: string;
  actorUid: string;
  title: string;
  instructions?: string;
  assigneeUid: string;
  dueAt?: string | null;
  contactId?: string | null;
  caseId?: string | null;
  callId?: string | null;
  source?: TaskSource;
  context?: {
    contactName?: string | null;
    contactPhone?: string | null;
    callerName?: string | null;
    callerPhone?: string | null;
    callSummary?: string | null;
    transcriptExcerpt?: string | null;
  };
  deterministicId?: string;
};

function clean(value: string | undefined, maximum: number): string {
  return String(value || "").trim().slice(0, maximum);
}

function dueTimestamp(value?: string | null): Timestamp | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The task due date is invalid." });
  }
  return Timestamp.fromDate(date);
}

export async function activeMember(
  companyId: string,
  uid: string,
): Promise<{ uid: string; displayName: string; email: string }> {
  const snapshot = await db.doc(
    `companies/${companyId}/memberships/${uid}`,
  ).get();
  if (!snapshot.exists || snapshot.data()?.status !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active team member." });
  }
  return {
    uid,
    displayName: clean(
      String(snapshot.data()?.displayName || snapshot.data()?.email || "Team member"),
      200,
    ),
    email: clean(String(snapshot.data()?.email || ""), 320),
  };
}

export async function createTask(input: CreateTaskInput) {
  const title = clean(input.title, 300);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Task title is required." });
  const [member, linkedCase] = await Promise.all([
    activeMember(input.companyId, input.assigneeUid),
    input.caseId
      ? db.doc(companyDocumentPath(input.companyId, "cases", input.caseId)).get()
      : Promise.resolve(null),
  ]);
  if (linkedCase && (
    !linkedCase.exists
    || linkedCase.data()?.objectType !== "case"
    || linkedCase.data()?.archived === true
  )) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active case." });
  }
  const caseContactId = linkedCase ? String(linkedCase.data()?.contactId || "") : null;
  if (linkedCase && !caseContactId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The selected case does not have a valid contact.",
    });
  }
  if (caseContactId && input.contactId && input.contactId !== caseContactId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The selected task contact does not match its case.",
    });
  }
  const contactId = caseContactId || input.contactId || null;
  const taskRef = input.deterministicId
    ? db.doc(companyDocumentPath(input.companyId, "workItems", input.deterministicId))
    : db.collection(companyCollectionPath(input.companyId, "workItems")).doc();
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  const dueAt = dueTimestamp(input.dueAt);

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(taskRef);
    if (existing.exists) {
      return jsonSafe({ id: existing.id, ...existing.data(), duplicate: true });
    }
    const now = Timestamp.now();
    const source = input.source || {
      kind: input.callId ? "call" : input.caseId ? "case" : "manual",
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
    };
    const authorization = input.source?.approvalId
      ? {
          kind: "approval",
          approvalId: input.source.approvalId,
          approvedBy: input.source.approvedBy || input.actorUid,
          approvedAt: now,
        }
      : {
          kind: "direct_user_action",
          approvedBy: input.actorUid,
          approvedAt: now,
        };
    const task = {
      objectType: "task",
      status: "open" satisfies TaskStatus,
      title,
      instructions: clean(input.instructions, 5_000) || null,
      assigneeUid: member.uid,
      assigneeName: member.displayName,
      dueAt,
      contactId,
      caseId: input.caseId || null,
      callId: input.callId || null,
      source,
      authorization,
      context: input.context || null,
      createdBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
    };
    transaction.create(taskRef, task);
    transaction.create(activityRef, {
      aggregateType: "task",
      aggregateId: taskRef.id,
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(contactId ? { contactId } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
      type: "task_created",
      actor: {
        kind: input.source?.kind === "workflow" && !input.source.approvalId
          ? "system"
          : "user",
        id: input.actorUid,
      },
      after: {
        title,
        assigneeUid: member.uid,
        dueAt,
        source,
        authorization,
      },
      createdAt: now,
    });
    return jsonSafe({ id: taskRef.id, ...task, duplicate: false });
  });
}

export async function listTasks(input: {
  companyId: string;
  status?: TaskStatus;
  assigneeUid?: string;
  contactId?: string;
  caseId?: string;
  limit?: number;
}) {
  const snapshot = await db.collection(companyCollectionPath(input.companyId, "workItems"))
    .orderBy("createdAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return jsonSafe(snapshot.docs
    .filter((document) => {
      const data = document.data();
      if (data.objectType !== "task") return false;
      if (input.status && data.status !== input.status) return false;
      if (input.assigneeUid && data.assigneeUid !== input.assigneeUid) return false;
      if (input.contactId && data.contactId !== input.contactId) return false;
      if (input.caseId && data.caseId !== input.caseId) return false;
      return true;
    })
    .map((document) => ({ id: document.id, ...document.data() })));
}

export async function updateTask(input: {
  companyId: string;
  actorUid: string;
  taskId: string;
  title?: string;
  instructions?: string;
  assigneeUid?: string;
  dueAt?: string | null;
}) {
  const ref = db.doc(companyDocumentPath(input.companyId, "workItems", input.taskId));
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
  if (snapshot.data()?.status !== "open") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only open tasks can be edited." });
  }
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (input.title !== undefined) {
    const title = clean(input.title, 300);
    if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Task title is required." });
    update.title = title;
  }
  if (input.instructions !== undefined) {
    update.instructions = clean(input.instructions, 5_000) || null;
  }
  if (input.assigneeUid !== undefined) {
    const member = await activeMember(input.companyId, input.assigneeUid);
    update.assigneeUid = member.uid;
    update.assigneeName = member.displayName;
  }
  if (input.dueAt !== undefined) update.dueAt = dueTimestamp(input.dueAt);
  await ref.update(update);
  const current = await ref.get();
  return jsonSafe({ id: current.id, ...current.data() });
}

export async function transitionTask(input: {
  companyId: string;
  actorUid: string;
  taskId: string;
  to: TaskStatus;
  note?: string;
}) {
  const taskRef = db.doc(companyDocumentPath(input.companyId, "workItems", input.taskId));
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  return db.runTransaction(async (transaction) => {
    const task = await transaction.get(taskRef);
    if (!task.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
    const before = String(task.data()?.status || "open") as TaskStatus;
    if (before === input.to) return jsonSafe({ id: task.id, ...task.data() });
    if (input.to === "open" && before !== "completed" && before !== "dismissed") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This task cannot be reopened." });
    }
    if (input.to !== "open" && before !== "open") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Only open tasks can be closed." });
    }
    const now = Timestamp.now();
    transaction.update(taskRef, {
      status: input.to,
      outcomeNote: clean(input.note, 2_000) || null,
      updatedAt: now,
      completedAt: input.to === "completed" ? now : FieldValue.delete(),
      completedBy: input.to === "completed" ? input.actorUid : FieldValue.delete(),
      dismissedAt: input.to === "dismissed" ? now : FieldValue.delete(),
      dismissedBy: input.to === "dismissed" ? input.actorUid : FieldValue.delete(),
      reopenedAt: input.to === "open" ? now : FieldValue.delete(),
      reopenedBy: input.to === "open" ? input.actorUid : FieldValue.delete(),
    });
    transaction.create(activityRef, {
      aggregateType: "task",
      aggregateId: input.taskId,
      ...(typeof task.data()?.caseId === "string" ? { caseId: task.data()?.caseId } : {}),
      ...(typeof task.data()?.contactId === "string" ? { contactId: task.data()?.contactId } : {}),
      ...(typeof task.data()?.callId === "string" ? { callId: task.data()?.callId } : {}),
      type: input.to === "open" ? "task_reopened" : `task_${input.to}`,
      actor: { kind: "user", id: input.actorUid },
      before: { status: before },
      after: { status: input.to, note: clean(input.note, 2_000) || null },
      createdAt: now,
    });
    return { id: input.taskId, status: input.to };
  });
}
