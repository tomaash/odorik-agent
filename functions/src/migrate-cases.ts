import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { defaultPipelineId, defaultStages, type PipelineStage } from "./pipeline/repository.js";

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim()
  || "odorik-tx-260720-c58d";

const apply = process.argv.includes("--apply");
const removeLegacy = process.argv.includes("--remove-legacy");

function pipelineStages(value: unknown): PipelineStage[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultStages.map((stage) => ({ ...stage }));
  }
  return value.map((raw, position) => {
    const stage = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const category = String(stage.category || "");
    return {
      id: String(stage.id || `stage_${position + 1}`),
      name: String(stage.name || stage.id || `Stage ${position + 1}`),
      position,
      color: String(stage.color || "slate"),
      terminal: stage.terminal === true || category === "won" || category === "lost",
      archived: stage.archived === true,
    };
  });
}

async function commit(
  writes: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
) {
  if (!apply) return;
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    writes.slice(offset, offset + 400).forEach((write) => write(batch));
    await batch.commit();
  }
}

const companies = await db.collection("companies").get();
const totals = {
  companies: companies.size,
  deals: 0,
  casesWritten: 0,
  tasksLinked: 0,
  pipelinesUpgraded: 0,
};

for (const company of companies.docs) {
  const deals = await company.ref.collection("deals").get();
  const tasks = await company.ref.collection("workItems").get();
  const pipelineRef = company.ref.collection("pipelines").doc(defaultPipelineId);
  const pipeline = await pipelineRef.get();
  const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  totals.deals += deals.size;

  for (const deal of deals.docs) {
    const data = deal.data();
    const {
      stageName: _legacyStageName,
      stageCategory: _legacyStageCategory,
      ...caseData
    } = data;
    const caseRef = company.ref.collection("cases").doc(deal.id);
    const createdAt = data.createdAt || Timestamp.now();
    const updatedAt = data.updatedAt || createdAt;
    writes.push((batch) => batch.set(caseRef, {
      ...caseData,
      objectType: "case",
      pipelineId: String(data.pipelineId || defaultPipelineId),
      revision: Number(data.revision || 0),
      source: data.source || { kind: "manual" },
      authorization: data.authorization || {
        kind: "migration",
        approvedBy: "system:deal-to-case",
        approvedAt: updatedAt,
      },
      createdAt,
      updatedAt,
      migratedFromDealAt: FieldValue.serverTimestamp(),
    }, { merge: false }));
    totals.casesWritten += 1;
  }

  for (const task of tasks.docs) {
    const dealId = task.data().dealId;
    if (typeof dealId !== "string" || !dealId) continue;
    writes.push((batch) => batch.update(task.ref, {
      caseId: dealId,
      dealId: FieldValue.delete(),
      migratedToCaseAt: FieldValue.serverTimestamp(),
    }));
    totals.tasksLinked += 1;
  }

  const pipelineData = pipeline.data() || {};
  if (!pipeline.exists || pipelineData.schemaVersion !== 2) {
    const stages = pipelineStages(pipelineData.stages);
    const initialStageId = stages.find((stage) => !stage.archived && !stage.terminal)?.id
      || stages[0]!.id;
    writes.push((batch) => batch.set(pipelineRef, {
      objectType: "pipeline",
      schemaVersion: 2,
      revision: Number(pipelineData.revision || 0),
      name: String(pipelineData.name || "").toLocaleLowerCase() === "sales pipeline"
        ? "Cases"
        : String(pipelineData.name || "Cases"),
      initialStageId,
      stages,
      updatedAt: FieldValue.serverTimestamp(),
      migratedFromSalesPipelineAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
    totals.pipelinesUpgraded += 1;
  }

  writes.push((batch) => batch.set(
    company.ref.collection("auditEvents").doc("deal_to_case_migration"),
    {
      aggregateType: "company",
      aggregateId: company.id,
      type: "company_deals_migrated_to_cases",
      actor: { kind: "system", id: "deal-to-case-migration" },
      after: {
        deals: deals.size,
        tasksLinked: tasks.docs.filter((task) => typeof task.data().dealId === "string").length,
      },
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: false },
  ));
  await commit(writes);

  if (apply) {
    const cases = await company.ref.collection("cases").get();
    const copiedIds = new Set(cases.docs.map((document) => document.id));
    const missing = deals.docs.filter((deal) => !copiedIds.has(deal.id));
    if (missing.length) {
      throw new Error(`Case migration verification failed for ${company.id}: ${missing.length} missing.`);
    }
  }
  if (apply && removeLegacy && !deals.empty) {
    await commit(deals.docs.map((deal) => (batch) => batch.delete(deal.ref)));
  }
}

console.log(JSON.stringify({
  mode: apply ? (removeLegacy ? "applied_and_removed_legacy" : "applied") : "dry_run",
  ...totals,
}, null, 2));
