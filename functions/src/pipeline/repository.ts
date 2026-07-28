import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { activeMember } from "../tasks/repository.js";

export type PipelineStage = {
  id: string;
  name: string;
  category: "open" | "won" | "lost";
  position: number;
  color: string;
};

export const defaultPipelineId = "default";
export const defaultStages: PipelineStage[] = [
  { id: "new", name: "New", category: "open", position: 0, color: "slate" },
  { id: "follow_up", name: "Follow-up", category: "open", position: 1, color: "indigo" },
  { id: "in_progress", name: "In progress", category: "open", position: 2, color: "emerald" },
  { id: "waiting", name: "Waiting", category: "open", position: 3, color: "amber" },
  { id: "won", name: "Won", category: "won", position: 4, color: "green" },
  { id: "lost", name: "Lost", category: "lost", position: 5, color: "rose" },
];

function clean(value: string | undefined, maximum: number): string {
  return String(value || "").trim().slice(0, maximum);
}

export async function getPipeline(companyId: string) {
  const ref = db.doc(companyDocumentPath(companyId, "pipelines", defaultPipelineId));
  let snapshot = await ref.get();
  if (!snapshot.exists) {
    try {
      await ref.create({
        name: "Sales pipeline",
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
  return jsonSafe({
    id: ref.id,
    name: snapshot.data()?.name || "Sales pipeline",
    stages: snapshot.data()?.stages || defaultStages,
  });
}

async function stage(companyId: string, stageId: string): Promise<PipelineStage> {
  const pipeline = await getPipeline(companyId) as {
    stages: PipelineStage[];
  };
  const selected = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!selected) throw new TRPCError({ code: "BAD_REQUEST", message: "Pipeline stage not found." });
  return selected;
}

async function contact(companyId: string, contactId: string) {
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

export async function listDeals(input: {
  companyId: string;
  contactId?: string;
  limit?: number;
}) {
  const snapshot = await db.collection(companyCollectionPath(input.companyId, "deals"))
    .orderBy("updatedAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return jsonSafe(snapshot.docs
    .filter((document) => (
      document.data().archived !== true
      && (!input.contactId || document.data().contactId === input.contactId)
    ))
    .map((document) => ({ id: document.id, ...document.data() })));
}

export async function createDeal(input: {
  companyId: string;
  actorUid: string;
  title: string;
  contactId: string;
  ownerUid: string;
  stageId?: string;
}) {
  const title = clean(input.title, 300);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Deal title is required." });
  const [selectedStage, selectedContact, owner] = await Promise.all([
    stage(input.companyId, input.stageId || defaultStages[0]!.id),
    contact(input.companyId, input.contactId),
    activeMember(input.companyId, input.ownerUid),
  ]);
  const dealRef = db.collection(companyCollectionPath(input.companyId, "deals")).doc();
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  const now = Timestamp.now();
  const deal = {
    objectType: "deal",
    pipelineId: defaultPipelineId,
    stageId: selectedStage.id,
    stageName: selectedStage.name,
    stageCategory: selectedStage.category,
    title,
    contactId: selectedContact.id,
    contactName: selectedContact.displayName,
    contactPhone: selectedContact.phone || null,
    ownerUid: owner.uid,
    ownerName: owner.displayName,
    createdBy: input.actorUid,
    createdAt: now,
    updatedAt: now,
    stageChangedAt: now,
  };
  await db.runTransaction(async (transaction) => {
    transaction.create(dealRef, deal);
    transaction.create(activityRef, {
      aggregateType: "deal",
      aggregateId: dealRef.id,
      type: "deal_created",
      actor: { kind: "user", id: input.actorUid },
      after: { title, stageId: selectedStage.id, contactId: selectedContact.id },
      createdAt: now,
    });
  });
  return jsonSafe({ id: dealRef.id, ...deal });
}

export async function moveDeal(input: {
  companyId: string;
  actorUid: string;
  dealId: string;
  stageId: string;
}) {
  const selectedStage = await stage(input.companyId, input.stageId);
  const dealRef = db.doc(companyDocumentPath(input.companyId, "deals", input.dealId));
  const activityRef = db.collection(companyCollectionPath(input.companyId, "auditEvents")).doc();
  return db.runTransaction(async (transaction) => {
    const deal = await transaction.get(dealRef);
    if (!deal.exists || deal.data()?.archived === true) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found." });
    }
    const before = {
      stageId: String(deal.data()?.stageId || ""),
      stageName: String(deal.data()?.stageName || ""),
    };
    if (before.stageId === selectedStage.id) return jsonSafe({ id: deal.id, ...deal.data() });
    const now = Timestamp.now();
    transaction.update(dealRef, {
      stageId: selectedStage.id,
      stageName: selectedStage.name,
      stageCategory: selectedStage.category,
      previousStageId: before.stageId,
      stageChangedAt: now,
      stageChangedBy: input.actorUid,
      updatedAt: now,
    });
    transaction.create(activityRef, {
      aggregateType: "deal",
      aggregateId: input.dealId,
      type: "deal_stage_changed",
      actor: { kind: "user", id: input.actorUid },
      before,
      after: { stageId: selectedStage.id, stageName: selectedStage.name },
      createdAt: now,
    });
    return {
      id: input.dealId,
      stageId: selectedStage.id,
      stageName: selectedStage.name,
      stageCategory: selectedStage.category,
    };
  });
}

export async function archiveDeal(input: {
  companyId: string;
  actorUid: string;
  dealId: string;
}) {
  const ref = db.doc(companyDocumentPath(input.companyId, "deals", input.dealId));
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found." });
  await ref.set({
    archived: true,
    archivedAt: FieldValue.serverTimestamp(),
    archivedBy: input.actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id: input.dealId, archived: true as const };
}
