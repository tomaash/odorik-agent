import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember } from "../tasks/repository.js";

export type PipelineStage = {
  id: string;
  name: string;
  position: number;
  color: string;
  terminal: boolean;
  archived: boolean;
};

export type PipelineView = {
  id: string;
  name: string;
  schemaVersion: 2;
  revision: number;
  initialStageId: string;
  stages: PipelineStage[];
};

export type CaseSource = {
  kind: "manual" | "call" | "workflow";
  callId?: string;
  workflowId?: string;
  workflowVersion?: number;
  runId?: string;
  blockId?: string;
  approvalId?: string;
  approvedBy?: string;
};

type RawRecord = { id: string } & FirebaseFirestore.DocumentData;

export const defaultPipelineId = "default";
export const defaultStages: PipelineStage[] = [
  { id: "new", name: "New", position: 0, color: "slate", terminal: false, archived: false },
  { id: "follow_up", name: "Follow-up", position: 1, color: "indigo", terminal: false, archived: false },
  { id: "in_progress", name: "In progress", position: 2, color: "emerald", terminal: false, archived: false },
  { id: "waiting", name: "Waiting", position: 3, color: "amber", terminal: false, archived: false },
  { id: "done", name: "Done", position: 4, color: "green", terminal: true, archived: false },
];

const stageIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const allowedColors = new Set([
  "slate",
  "indigo",
  "emerald",
  "amber",
  "green",
  "rose",
  "blue",
  "violet",
]);

function clean(value: string | undefined, maximum: number): string {
  return String(value || "").trim().slice(0, maximum);
}

function normalizeLegacyStages(value: unknown): PipelineStage[] {
  if (!Array.isArray(value) || value.length === 0) return defaultStages.map((stage) => ({ ...stage }));
  return value.map((entry, index) => {
    const candidate = entry && typeof entry === "object"
      ? entry as Record<string, unknown>
      : {};
    const id = String(candidate.id || `stage_${index + 1}`);
    const category = String(candidate.category || "");
    return {
      id,
      name: clean(String(candidate.name || id), 100) || id,
      position: index,
      color: allowedColors.has(String(candidate.color)) ? String(candidate.color) : "slate",
      terminal: typeof candidate.terminal === "boolean"
        ? candidate.terminal
        : category === "won" || category === "lost",
      archived: candidate.archived === true,
    };
  });
}

async function ensurePipeline(companyId: string): Promise<PipelineView> {
  const ref = db.doc(companyDocumentPath(companyId, "pipelines", defaultPipelineId));
  let snapshot = await ref.get();
  if (!snapshot.exists) {
    try {
      await ref.create({
        objectType: "pipeline",
        schemaVersion: 2,
        revision: 0,
        name: "Cases",
        initialStageId: defaultStages[0]!.id,
        stages: defaultStages,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code !== 6 && code !== "already-exists") throw error;
    }
    snapshot = await ref.get();
  }

  const data = snapshot.data() || {};
  if (data.schemaVersion !== 2) {
    const stages = normalizeLegacyStages(data.stages);
    const initialStageId = stages.find((stage) => !stage.archived)?.id || stages[0]!.id;
    const legacyName = clean(String(data.name || ""), 100);
    await ref.set({
      objectType: "pipeline",
      schemaVersion: 2,
      revision: Number(data.revision || 0),
      name: !legacyName || legacyName.toLocaleLowerCase() === "sales pipeline"
        ? "Cases"
        : legacyName,
      initialStageId,
      stages,
      migratedFromSalesPipelineAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    snapshot = await ref.get();
  }

  const current = snapshot.data() || {};
  return {
    id: ref.id,
    name: clean(String(current.name || "Cases"), 100) || "Cases",
    schemaVersion: 2,
    revision: Number(current.revision || 0),
    initialStageId: String(current.initialStageId || defaultStages[0]!.id),
    stages: normalizeLegacyStages(current.stages),
  };
}

export async function getPipeline(companyId: string): Promise<PipelineView> {
  return jsonSafe(await ensurePipeline(companyId)) as PipelineView;
}

function validatePipelineInput(input: {
  name: string;
  initialStageId: string;
  stages: PipelineStage[];
}) {
  const name = clean(input.name, 100);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Pipeline name is required." });
  if (input.stages.length < 1 || input.stages.length > 20) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A pipeline must have between 1 and 20 stages." });
  }
  const ids = new Set<string>();
  const stages = input.stages.map((stage, index) => {
    const id = String(stage.id || "").trim();
    if (!stageIdPattern.test(id) || ids.has(id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Stage IDs must be unique and stable." });
    }
    ids.add(id);
    const stageName = clean(stage.name, 100);
    if (!stageName) throw new TRPCError({ code: "BAD_REQUEST", message: "Every stage needs a name." });
    return {
      id,
      name: stageName,
      position: index,
      color: allowedColors.has(stage.color) ? stage.color : "slate",
      terminal: stage.terminal === true,
      archived: stage.archived === true,
    };
  });
  const initial = stages.find((stage) => stage.id === input.initialStageId);
  if (!initial || initial.archived || initial.terminal) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an active, non-terminal initial stage.",
    });
  }
  return { name, initialStageId: initial.id, stages };
}

export async function updatePipeline(input: {
  companyId: string;
  actorUid: string;
  expectedRevision: number;
  name: string;
  initialStageId: string;
  stages: PipelineStage[];
}) {
  const current = await ensurePipeline(input.companyId);
  const next = validatePipelineInput(input);
  const currentById = new Map(current.stages.map((stage) => [stage.id, stage]));
  for (const stage of next.stages) {
    const previous = currentById.get(stage.id);
    if (!previous || previous.terminal === stage.terminal) continue;
    const used = await db.collection(companyCollectionPath(input.companyId, "cases"))
      .where("stageId", "==", stage.id)
      .limit(1)
      .get();
    if (!used.empty) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Move cases out of “${previous.name}” before changing whether it is terminal.`,
      });
    }
  }
  const nextIds = new Set(next.stages.map((stage) => stage.id));
  const removedUsedStages = current.stages.filter((stage) => !nextIds.has(stage.id));
  if (removedUsedStages.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Archive stages instead of deleting them.",
    });
  }

  const ref = db.doc(companyDocumentPath(input.companyId, "pipelines", defaultPipelineId));
  const auditRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const revision = Number(snapshot.data()?.revision || 0);
    if (revision !== input.expectedRevision) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "The pipeline changed. Reload before saving stage settings.",
      });
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      ...next,
      schemaVersion: 2,
      revision: revision + 1,
      updatedBy: input.actorUid,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "pipeline",
      aggregateId: defaultPipelineId,
      type: "pipeline_updated",
      actor: { kind: "user", id: input.actorUid },
      before: {
        revision,
        name: snapshot.data()?.name || null,
        initialStageId: snapshot.data()?.initialStageId || null,
        stages: snapshot.data()?.stages || [],
      },
      after: { revision: revision + 1, ...next },
      createdAt: now,
    });
    return jsonSafe({
      id: defaultPipelineId,
      schemaVersion: 2,
      revision: revision + 1,
      ...next,
    });
  });
}

export async function pipelineStage(
  companyId: string,
  stageId: string,
  options: { allowArchived?: boolean } = {},
): Promise<PipelineStage> {
  const pipeline = await ensurePipeline(companyId);
  const selected = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!selected || (selected.archived && !options.allowArchived)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Pipeline stage not found." });
  }
  return selected;
}

async function caseContact(companyId: string, contactId: string) {
  const snapshot = await db.doc(companyDocumentPath(companyId, "contacts", contactId)).get();
  if (!snapshot.exists) throw new TRPCError({ code: "BAD_REQUEST", message: "Contact not found." });
  return {
    id: snapshot.id,
    displayName: clean(
      String(snapshot.data()?.displayName || snapshot.data()?.phoneE164 || "Unknown contact"),
      200,
    ),
    phone: clean(String(snapshot.data()?.phoneE164 || snapshot.data()?.phoneRaw || ""), 100),
  };
}

export async function listCases(input: {
  companyId: string;
  contactId?: string;
  limit?: number;
  includeArchived?: boolean;
}) {
  const snapshot = await db.collection(companyCollectionPath(input.companyId, "cases"))
    .orderBy("updatedAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return jsonSafe(snapshot.docs
    .filter((document) => (
      (input.includeArchived || document.data().archived !== true)
      && (!input.contactId || document.data().contactId === input.contactId)
    ))
    .map((document) => ({ id: document.id, ...document.data() })));
}

export async function getCaseDetails(input: {
  companyId: string;
  caseId: string;
}) {
  const caseRef = db.doc(companyDocumentPath(input.companyId, "cases", input.caseId));
  const caseSnapshot = await caseRef.get();
  if (!caseSnapshot.exists) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Case not found." });
  }
  const caseData = caseSnapshot.data() || {};
  const contactId = String(caseData.contactId || "");
  if (!contactId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This case does not have a valid contact.",
    });
  }

  const [
    pipeline,
    contactSnapshot,
    taskSnapshot,
    scopedApprovalSnapshot,
    legacyApprovalSnapshot,
    resultApprovalSnapshot,
    caseActivitySnapshot,
    relatedActivitySnapshot,
  ] = await Promise.all([
    ensurePipeline(input.companyId),
    db.doc(companyDocumentPath(input.companyId, "contacts", contactId)).get(),
    db.collection(companyCollectionPath(input.companyId, "workItems"))
      .where("caseId", "==", input.caseId)
      .limit(200)
      .get(),
    db.collection(companyCollectionPath(input.companyId, "actionApprovals"))
      .where("scope.caseId", "==", input.caseId)
      .limit(100)
      .get(),
    db.collection(companyCollectionPath(input.companyId, "actionApprovals"))
      .where("action.caseId", "==", input.caseId)
      .limit(100)
      .get(),
    db.collection(companyCollectionPath(input.companyId, "actionApprovals"))
      .where("result.id", "==", input.caseId)
      .limit(100)
      .get(),
    db.collection(companyCollectionPath(input.companyId, "auditEvents"))
      .where("aggregateId", "==", input.caseId)
      .limit(200)
      .get(),
    db.collection(companyCollectionPath(input.companyId, "auditEvents"))
      .where("caseId", "==", input.caseId)
      .limit(200)
      .get(),
  ]);

  const tasks = taskSnapshot.docs
    .filter((document) => document.data().objectType === "task")
    .map((document) => ({ id: document.id, ...document.data() }) as RawRecord)
    .sort((left, right) => (
      (right.createdAt?.toMillis?.() || 0) - (left.createdAt?.toMillis?.() || 0)
    ));
  const approvalById = new Map(
    [
      ...scopedApprovalSnapshot.docs,
      ...legacyApprovalSnapshot.docs.filter((document) => {
        const data = document.data();
        if (data.scope !== undefined) return false;
        if (data.action?.kind === "case.move" || data.action?.kind === "task.create") return true;
        return data.action?.kind === "case.create" && data.status === "approved";
      }),
      ...resultApprovalSnapshot.docs.filter((document) => (
        document.data().result?.kind === "case"
      )),
    ].map((document) => [document.id, document] as const),
  );
  const approvals = [...approvalById.values()]
    .filter((document) => document.data().objectType === "action_approval")
    .map((document) => ({ id: document.id, ...document.data() }) as RawRecord)
    .sort((left, right) => (
      (right.createdAt?.toMillis?.() || 0) - (left.createdAt?.toMillis?.() || 0)
    ));

  const callIds = new Set<string>();
  const addCallId = (value: unknown) => {
    if (typeof value === "string" && value.trim()) callIds.add(value);
  };
  addCallId(caseData.callId);
  addCallId(caseData.source?.callId);
  for (const task of tasks) {
    addCallId(task.callId);
    addCallId(task.source?.callId);
  }
  for (const approval of approvals) {
    addCallId(approval.action?.callId);
    addCallId(approval.source?.callId);
  }
  const callSnapshots = callIds.size
    ? await db.getAll(...[...callIds].map((callId) => (
        db.doc(companyDocumentPath(input.companyId, "calls", callId))
      )))
    : [];
  const calls = callSnapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data()! }) as RawRecord)
    .sort((left, right) => {
      const leftAt = left.odorikTime
        || left.processedAt?.toDate?.()?.toISOString?.()
        || left.uploadedAt?.toDate?.()?.toISOString?.()
        || "";
      const rightAt = right.odorikTime
        || right.processedAt?.toDate?.()?.toISOString?.()
        || right.uploadedAt?.toDate?.()?.toISOString?.()
        || "";
      return String(rightAt).localeCompare(String(leftAt));
    });

  const activityById = new Map(
    [
      ...caseActivitySnapshot.docs.filter((document) => (
        document.data().aggregateType === "case"
        || document.data().aggregateType === "deal"
      )),
      ...relatedActivitySnapshot.docs,
    ]
      .map((document) => [
        document.id,
        { id: document.id, ...document.data() } as RawRecord,
      ] as const),
  );
  const activity = [...activityById.values()].sort((left, right) => (
    (right.createdAt?.toMillis?.() || 0) - (left.createdAt?.toMillis?.() || 0)
  ));

  return jsonSafe({
    case: { id: caseSnapshot.id, ...caseData },
    pipeline,
    contact: contactSnapshot.exists
      ? { id: contactSnapshot.id, ...contactSnapshot.data()! }
      : {
          id: contactId,
          displayName: caseData.contactName || "Unknown contact",
          phoneE164: caseData.contactPhone || null,
          missing: true,
        },
    tasks,
    approvals,
    calls,
    activity,
  });
}

export async function createCase(input: {
  companyId: string;
  actorUid: string;
  title: string;
  contactId: string;
  ownerUid: string;
  stageId?: string;
  source?: CaseSource;
  callId?: string | null;
  deterministicId?: string;
}) {
  const title = clean(input.title, 300);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Case title is required." });
  const pipeline = await ensurePipeline(input.companyId);
  const selectedStageId = input.stageId || pipeline.initialStageId;
  const [selectedStage, selectedContact, owner] = await Promise.all([
    pipelineStage(input.companyId, selectedStageId),
    caseContact(input.companyId, input.contactId),
    activeMember(input.companyId, input.ownerUid),
  ]);
  const caseRef = input.deterministicId
    ? db.doc(companyDocumentPath(input.companyId, "cases", input.deterministicId))
    : db.collection(companyCollectionPath(input.companyId, "cases")).doc();
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(caseRef);
    if (existing.exists) {
      return jsonSafe({ id: existing.id, ...existing.data(), duplicate: true });
    }
    const now = Timestamp.now();
    const source = input.source || {
      kind: input.callId ? "call" : "manual",
      ...(input.callId ? { callId: input.callId } : {}),
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
    const caseRecord = {
      objectType: "case",
      pipelineId: defaultPipelineId,
      stageId: selectedStage.id,
      title,
      contactId: selectedContact.id,
      contactName: selectedContact.displayName,
      contactPhone: selectedContact.phone || null,
      ownerUid: owner.uid,
      ownerName: owner.displayName,
      revision: 0,
      source,
      authorization,
      callId: input.callId || null,
      createdBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
      stageChangedAt: now,
      ...(selectedStage.terminal ? { closedAt: now } : {}),
    };
    transaction.create(caseRef, caseRecord);
    transaction.create(activityRef, {
      aggregateType: "case",
      aggregateId: caseRef.id,
      caseId: caseRef.id,
      type: "case_created",
      actor: { kind: "user", id: input.actorUid },
      after: {
        title,
        stageId: selectedStage.id,
        contactId: selectedContact.id,
        ownerUid: owner.uid,
        source,
        authorization,
      },
      createdAt: now,
    });
    return jsonSafe({ id: caseRef.id, ...caseRecord, duplicate: false });
  });
}

export async function moveCase(input: {
  companyId: string;
  actorUid: string;
  caseId: string;
  stageId: string;
  expectedRevision: number;
  expectedStageId: string;
  movementId?: string;
  authorization?: {
    approvalId: string;
    approvedBy: string;
  };
}) {
  const selectedStage = await pipelineStage(input.companyId, input.stageId);
  const caseRef = db.doc(companyDocumentPath(input.companyId, "cases", input.caseId));
  const movementRef = input.movementId
    ? db.doc(companyDocumentPath(input.companyId, "caseMovements", input.movementId))
    : null;
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  return db.runTransaction(async (transaction) => {
    const [snapshot, movementSnapshot] = await Promise.all([
      transaction.get(caseRef),
      movementRef ? transaction.get(movementRef) : Promise.resolve(null),
    ]);
    if (!snapshot.exists || snapshot.data()?.archived === true) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Case not found." });
    }
    const data = snapshot.data() || {};
    if (movementSnapshot?.exists) {
      return jsonSafe({
        id: snapshot.id,
        ...movementSnapshot.data()?.result,
        duplicate: true,
      });
    }
    const revision = Number(data.revision || 0);
    const currentStageId = String(data.stageId || "");
    if (revision !== input.expectedRevision || currentStageId !== input.expectedStageId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This case changed after approval was requested. Review it again before moving it.",
      });
    }
    if (currentStageId === selectedStage.id) {
      return jsonSafe({ id: snapshot.id, ...data, duplicate: true });
    }
    const now = Timestamp.now();
    const nextRevision = revision + 1;
    const authorization = input.authorization
      ? {
          kind: "approval",
          approvalId: input.authorization.approvalId,
          approvedBy: input.authorization.approvedBy,
          approvedAt: now,
        }
      : {
          kind: "direct_user_action",
          approvedBy: input.actorUid,
          approvedAt: now,
        };
    transaction.update(caseRef, {
      stageId: selectedStage.id,
      previousStageId: currentStageId,
      revision: nextRevision,
      stageChangedAt: now,
      stageChangedBy: input.actorUid,
      updatedAt: now,
      lastMovementId: input.movementId || null,
      lastMovementAuthorization: authorization,
      closedAt: selectedStage.terminal ? now : FieldValue.delete(),
    });
    if (movementRef) {
      transaction.create(movementRef, {
        objectType: "case_movement",
        movementId: input.movementId,
        caseId: input.caseId,
        fromStageId: currentStageId,
        toStageId: selectedStage.id,
        fromRevision: revision,
        toRevision: nextRevision,
        authorization,
        result: {
          stageId: selectedStage.id,
          revision: nextRevision,
          closedAt: selectedStage.terminal ? now : null,
        },
        createdBy: input.actorUid,
        createdAt: now,
      });
    }
    transaction.create(activityRef, {
      aggregateType: "case",
      aggregateId: input.caseId,
      caseId: input.caseId,
      type: "case_stage_changed",
      actor: { kind: "user", id: input.actorUid },
      before: { stageId: currentStageId, revision },
      after: {
        stageId: selectedStage.id,
        revision: nextRevision,
        authorization,
      },
      createdAt: now,
    });
    return jsonSafe({
      id: input.caseId,
      stageId: selectedStage.id,
      revision: nextRevision,
      closedAt: selectedStage.terminal ? now : null,
      duplicate: false,
    });
  });
}

export async function archiveCase(input: {
  companyId: string;
  actorUid: string;
  caseId: string;
}) {
  const pipeline = await ensurePipeline(input.companyId);
  const terminalStageIds = new Set(
    pipeline.stages.filter((stage) => stage.terminal).map((stage) => stage.id),
  );
  const ref = db.doc(companyDocumentPath(input.companyId, "cases", input.caseId));
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  const openTasksQuery = db.collection(companyCollectionPath(input.companyId, "workItems"))
    .where("caseId", "==", input.caseId)
    .where("status", "==", "open")
    .limit(1);
  const scopedApprovalsQuery = db.collection(
    companyCollectionPath(input.companyId, "actionApprovals"),
  )
    .where("scope.caseId", "==", input.caseId)
    .where("status", "in", ["pending", "executing", "execution_failed"])
    .limit(1);
  const legacyApprovalsQuery = db.collection(
    companyCollectionPath(input.companyId, "actionApprovals"),
  )
    .where("action.caseId", "==", input.caseId)
    .where("status", "in", ["pending", "executing", "execution_failed"]);
  return db.runTransaction(async (transaction) => {
    const [snapshot, openTasks, scopedApprovals, legacyApprovals] = await Promise.all([
      transaction.get(ref),
      transaction.get(openTasksQuery),
      transaction.get(scopedApprovalsQuery),
      transaction.get(legacyApprovalsQuery),
    ]);
    if (!snapshot.exists) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Case not found." });
    }
    if (snapshot.data()?.archived === true) {
      return { id: input.caseId, archived: true as const, duplicate: true };
    }
    if (!terminalStageIds.has(String(snapshot.data()?.stageId || ""))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Move the case to a terminal stage before archiving it.",
      });
    }
    if (!openTasks.empty) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Complete or dismiss the case's open tasks before archiving it.",
      });
    }
    const unresolvedLegacyApproval = legacyApprovals.docs.some((document) => {
      const data = document.data();
      return (
        data.scope === undefined
        && (data.action?.kind === "case.move" || data.action?.kind === "task.create")
        && (
          data.status === "pending"
          || data.status === "executing"
          || data.status === "execution_failed"
        )
      );
    });
    if (!scopedApprovals.empty || unresolvedLegacyApproval) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Resolve the case's pending approvals before archiving it.",
      });
    }
    const now = Timestamp.now();
    transaction.update(ref, {
      archived: true,
      archivedAt: now,
      archivedBy: input.actorUid,
      updatedAt: now,
    });
    transaction.create(activityRef, {
      aggregateType: "case",
      aggregateId: input.caseId,
      caseId: input.caseId,
      type: "case_archived",
      actor: { kind: "user", id: input.actorUid },
      before: { archived: false },
      after: { archived: true },
      createdAt: now,
    });
    return { id: input.caseId, archived: true as const, duplicate: false };
  });
}
