import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { normalizeResourceAudience } from "./access.js";

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim()
  || "odorik-tx-260720-c58d";

const apply = process.argv.includes("--apply");
const companyArgument = process.argv.find((argument) => argument.startsWith("--company="));
const selectedCompanyId = companyArgument?.slice("--company=".length).trim() || null;

async function commit(writes: Array<(batch: FirebaseFirestore.WriteBatch) => void>) {
  if (!apply) return;
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    writes.slice(offset, offset + 400).forEach((write) => write(batch));
    await batch.commit();
  }
}

const companies = selectedCompanyId
  ? [await db.doc(`companies/${selectedCompanyId}`).get()]
  : (await db.collection("companies").get()).docs;
const totals = {
  companies: 0,
  resources: 0,
  contextItems: 0,
  calls: 0,
  derivedRecords: 0,
};

for (const company of companies) {
  if (!company.exists) throw new Error(`Company ${company.id} not found.`);
  totals.companies += 1;
  const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  const connections = await company.ref.collection("connections").get();
  for (const connection of connections.docs) {
    const resources = await connection.ref.collection("resources").get();
    for (const resource of resources.docs) {
      const audience = normalizeResourceAudience(resource.data().audience);
      const audienceRevision = Math.max(1, Number(resource.data().audienceRevision || 1));
      const enabled = resource.data().status !== "disabled";
      writes.push((batch) => batch.set(resource.ref, {
        audience,
        audienceRevision,
        audienceProjection: {
          status: "projected",
          revision: audienceRevision,
          migratedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }));
      totals.resources += 1;

      const [contextItems, calls] = await Promise.all([
        company.ref.collection("contextItems")
          .where("source.connectionId", "==", connection.id)
          .where("source.resourceId", "==", resource.id)
          .get(),
        company.ref.collection("calls")
          .where("connectionId", "==", connection.id)
          .where("resourceId", "==", resource.id)
          .get(),
      ]);
      for (const contextItem of contextItems.docs) {
        writes.push((batch) => batch.set(contextItem.ref, {
          access: audience,
          accessRevision: audienceRevision,
          indexingEnabled: enabled,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }));
        totals.contextItems += 1;
      }
      for (const call of calls.docs) {
        writes.push((batch) => batch.set(call.ref, {
          access: audience,
          accessRevision: audienceRevision,
          contextEnabled: enabled,
          indexingEnabled: enabled,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }));
        totals.calls += 1;
      }
    }
  }

  // These records were company-visible before C4. Preserve that behavior until
  // a linked resource audience is intentionally changed after migration.
  for (const collectionName of [
    "contacts",
    "workItems",
    "cases",
    "actionApprovals",
    "workflowRuns",
    "codingRuns",
    "auditEvents",
  ]) {
    const records = await company.ref.collection(collectionName).get();
    for (const record of records.docs) {
      if (record.data().access !== undefined) continue;
      writes.push((batch) => batch.set(record.ref, {
        access: { visibility: "company" },
        indexingEnabled: record.data().indexingEnabled !== false,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }));
      totals.derivedRecords += 1;
    }
  }
  await commit(writes);
}

console.log(JSON.stringify({
  mode: apply ? "applied" : "dry_run",
  selectedCompanyId,
  ...totals,
}, null, 2));
