import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import {
  cloneWorkflow,
  createCallTaskWorkflow,
  normalizeWorkflowSpec,
  validateWorkflow,
  type CreateTaskBlock,
  type WorkflowSpec,
} from "@agent-erik/workflow";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember } from "../tasks/repository.js";

function versionId(version: number): string {
  return String(version).padStart(6, "0");
}

function isWorkflowSpec(value: unknown): value is WorkflowSpec {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { schemaVersion?: unknown }).schemaVersion === 4,
  );
}

function supportedSpec(value: unknown): WorkflowSpec | null {
  return normalizeWorkflowSpec(value);
}

function taskBlocks(spec: WorkflowSpec): CreateTaskBlock[] {
  return spec.blocks.flatMap((block) => (
    block.kind === "action.task.create" ? [block] : [...block.then, ...block.else]
  ));
}

function isUntouchedDemo(data: FirebaseFirestore.DocumentData): boolean {
  const draft = data.draft as {
    schemaVersion?: unknown;
    name?: unknown;
    body?: Array<{ id?: unknown }>;
  } | undefined;
  return (
    data.status === "draft"
    && draft?.schemaVersion === 1
    && draft.name === "Call follow-up offer"
    && draft.body?.length === 1
    && draft.body[0]?.id === "if_qualified_call"
  );
}

async function ownerRecipe(
  companyId: string,
  actorUid: string,
  name?: string,
): Promise<WorkflowSpec> {
  const member = await activeMember(companyId, actorUid);
  return createCallTaskWorkflow({
    assigneeUid: member.uid,
    assigneeName: member.displayName,
    name,
  });
}

async function upgradeUntouchedDemo(
  companyId: string,
  snapshot: FirebaseFirestore.DocumentSnapshot,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const data = snapshot.data();
  if (!data || !isUntouchedDemo(data)) return snapshot;
  const createdBy = String(data.createdBy || data.draftEditedBy || "");
  if (!createdBy) return snapshot;
  const spec = await ownerRecipe(companyId, createdBy, "Call follow-up");
  const now = Timestamp.now();
  await snapshot.ref.set({
    name: spec.name,
    status: "draft",
    draft: spec,
    schemaVersion: 4,
    deployedVersion: null,
    versionCount: 0,
    migratedFromDemoAt: now,
    updatedAt: now,
  }, { merge: true });
  return snapshot.ref.get();
}

async function upgradeSupportedDraft(
  companyId: string,
  snapshot: FirebaseFirestore.DocumentSnapshot,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const demoUpgraded = await upgradeUntouchedDemo(companyId, snapshot);
  const data = demoUpgraded.data();
  if (!data || isWorkflowSpec(data.draft)) return demoUpgraded;
  const normalized = supportedSpec(data.draft);
  if (!normalized) return demoUpgraded;
  const now = Timestamp.now();
  await demoUpgraded.ref.set({
    name: normalized.name,
    draft: normalized,
    schemaVersion: 4,
    migratedToApprovalSchemaAt: now,
    updatedAt: now,
  }, { merge: true });
  return demoUpgraded.ref.get();
}

export async function createWorkflowDraft(input: {
  companyId: string;
  actorUid: string;
  name?: string;
}) {
  const ref = db.collection(companyCollectionPath(input.companyId, "workflows")).doc();
  const spec = await ownerRecipe(input.companyId, input.actorUid, input.name);
  const now = Timestamp.now();
  await ref.create({
    companyId: input.companyId,
    name: spec.name,
    schemaVersion: 4,
    status: "draft",
    draft: spec,
    deployedVersion: null,
    versionCount: 0,
    createdBy: input.actorUid,
    createdAt: now,
    updatedAt: now,
  });
  return jsonSafe({ id: ref.id, spec, status: "draft", deployedVersion: null });
}

export async function listWorkflows(companyId: string) {
  const snapshot = await db.collection(companyCollectionPath(companyId, "workflows"))
    .orderBy("updatedAt", "desc")
    .limit(50)
    .get();
  const documents = await Promise.all(
    snapshot.docs.map((document) => upgradeSupportedDraft(companyId, document)),
  );
  const items = await Promise.all(documents.map(async (document) => {
    const data = document.data() || {};
    const supported = isWorkflowSpec(data.draft);
    const runs = supported
      ? await db.collection(companyCollectionPath(companyId, "workflowRuns"))
        .where("workflowId", "==", document.id)
        .limit(20)
        .get()
      : null;
    const statuses = runs?.docs.reduce<Record<string, number>>((counts, run) => {
      const status = String(run.data().status || "unknown");
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}) || {};
    return {
      id: document.id,
      ...data,
      status: supported ? data.status : "legacy",
      legacy: !supported,
      draft: supported ? data.draft : null,
      recentRuns: statuses,
    };
  }));
  return jsonSafe(items);
}

export async function getWorkflow(companyId: string, workflowId: string) {
  const ref = db.doc(companyDocumentPath(companyId, "workflows", workflowId));
  const initial = await ref.get();
  if (!initial.exists) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
  }
  const snapshot = await upgradeSupportedDraft(companyId, initial);
  const data = snapshot.data() || {};
  if (!isWorkflowSpec(data.draft)) {
    return jsonSafe({
      id: snapshot.id,
      ...data,
      status: "legacy",
      legacy: true,
      draft: null,
      warning: "This experimental block workflow is disabled and preserved for reference.",
    });
  }
  return jsonSafe({ id: snapshot.id, ...data, legacy: false });
}

export async function saveWorkflowDraft(input: {
  companyId: string;
  actorUid: string;
  workflowId: string;
  spec: WorkflowSpec;
}) {
  const validation = validateWorkflow(input.spec);
  if (!validation.valid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Workflow has ${validation.errors.length + validation.holes.length} unresolved issue(s).`,
      cause: validation,
    });
  }
  const spec = cloneWorkflow(input.spec);
  await Promise.all(taskBlocks(spec).map(async (block) => {
    const [assignee, approver] = await Promise.all([
      activeMember(input.companyId, block.task.assigneeUid),
      activeMember(input.companyId, block.approval.approverUid),
    ]);
    block.task.assigneeName = assignee.displayName;
    block.approval.approverName = approver.displayName;
  }));
  const ref = db.doc(companyDocumentPath(input.companyId, "workflows", input.workflowId));
  const initial = await ref.get();
  const snapshot = initial.exists ? await upgradeSupportedDraft(input.companyId, initial) : initial;
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
  if (!isWorkflowSpec(snapshot.data()?.draft)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This legacy workflow is disabled and cannot be edited.",
    });
  }
  const now = Timestamp.now();
  await ref.set({
    name: spec.name.trim(),
    schemaVersion: 4,
    draft: spec,
    draftValidation: validation,
    draftEditedBy: input.actorUid,
    draftUpdatedAt: now,
    updatedAt: now,
  }, { merge: true });
  return jsonSafe({ id: input.workflowId, spec, validation });
}

export async function enableWorkflow(input: {
  companyId: string;
  actorUid: string;
  workflowId: string;
}) {
  const ref = db.doc(companyDocumentPath(input.companyId, "workflows", input.workflowId));
  const initial = await ref.get();
  const snapshot = initial.exists ? await upgradeSupportedDraft(input.companyId, initial) : initial;
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
  const spec = supportedSpec(snapshot.data()?.draft);
  const validation = validateWorkflow(spec);
  if (!spec || !validation.valid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only a complete internal task recipe can be turned on.",
      cause: validation,
    });
  }
  await Promise.all(taskBlocks(spec).map((block) => (
    Promise.all([
      activeMember(input.companyId, block.task.assigneeUid),
      activeMember(input.companyId, block.approval.approverUid),
    ])
  )));
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    const currentSpec = supportedSpec(current.data()?.draft);
    if (!currentSpec || !validateWorkflow(currentSpec).valid) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy workflow is disabled." });
    }
    const nextVersion = Number(current.data()?.versionCount || 0) + 1;
    const now = Timestamp.now();
    transaction.create(ref.collection("versions").doc(versionId(nextVersion)), {
      version: nextVersion,
      schemaVersion: 4,
      spec: currentSpec,
      enabledBy: input.actorUid,
      createdAt: now,
    });
    transaction.update(ref, {
      name: currentSpec.name,
      schemaVersion: 4,
      status: "enabled",
      deployedVersion: nextVersion,
      versionCount: nextVersion,
      enabledBy: input.actorUid,
      enabledAt: now,
      updatedAt: now,
    });
    transaction.create(
      db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc(),
      {
        aggregateType: "workflow",
        aggregateId: input.workflowId,
        type: "workflow_enabled",
        actor: { kind: "user", id: input.actorUid },
        after: {
          version: nextVersion,
          capabilities: ["approval.request", "task.create", "condition.evaluate"],
        },
        createdAt: now,
      },
    );
    return { id: input.workflowId, version: nextVersion, status: "enabled" as const };
  });
}

export async function pauseWorkflow(input: {
  companyId: string;
  actorUid: string;
  workflowId: string;
}) {
  const ref = db.doc(companyDocumentPath(input.companyId, "workflows", input.workflowId));
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
  if (snapshot.data()?.status !== "enabled") {
    return { id: input.workflowId, status: String(snapshot.data()?.status || "draft") };
  }
  const now = Timestamp.now();
  await ref.set({
    status: "paused",
    pausedBy: input.actorUid,
    pausedAt: now,
    updatedAt: now,
  }, { merge: true });
  return { id: input.workflowId, status: "paused" as const };
}

export async function enabledWorkflows(companyId: string, limit = 10) {
  const snapshot = await db.collection(companyCollectionPath(companyId, "workflows"))
    .where("status", "==", "enabled")
    .limit(Math.min(limit, 10))
    .get();
  const workflows = await Promise.all(snapshot.docs.map(async (document) => {
    const version = Number(document.data().deployedVersion || 0);
    if (!version) return null;
    const versionSnapshot = await document.ref.collection("versions").doc(versionId(version)).get();
    const spec = supportedSpec(versionSnapshot.data()?.spec);
    if (!spec || !validateWorkflow(spec).valid) return null;
    return {
      id: document.id,
      name: String(document.data().name || "Workflow"),
      version,
      spec,
    };
  }));
  return workflows.filter((item): item is NonNullable<typeof item> => item !== null);
}

export async function workflowVersion(
  companyId: string,
  workflowId: string,
  version?: number,
) {
  const ref = db.doc(companyDocumentPath(companyId, "workflows", workflowId));
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
  const selectedVersion = version || Number(snapshot.data()?.deployedVersion || 0);
  if (!selectedVersion) {
    const draft = supportedSpec(snapshot.data()?.draft);
    if (!draft) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy workflow is disabled." });
    }
    return { id: workflowId, name: draft.name, version: 0, spec: draft };
  }
  const versionSnapshot = await ref.collection("versions").doc(versionId(selectedVersion)).get();
  const spec = supportedSpec(versionSnapshot.data()?.spec);
  if (!spec || !validateWorkflow(spec).valid) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy workflow version is disabled." });
  }
  return {
    id: workflowId,
    name: String(snapshot.data()?.name || "Workflow"),
    version: selectedVersion,
    spec,
  };
}
