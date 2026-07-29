import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { explorersCompanyId } from "./tenancy.js";

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim()
  || "odorik-tx-260720-c58d";

const apply = process.argv.includes("--apply");
const companyId = explorersCompanyId;
const companyName = "Explorers";
const legacyCollections = [
  "calls",
  "interactions",
  "contacts",
  "processingRuns",
  "tasks",
  "reviews",
  "auditEvents",
  "agentRuns",
] as const;

const explorers = [
  {
    uid: "YXIObYZRlWfB3VEbyDRwrhLOM1S2",
    email: "tomas.holas@gmail.com",
    displayName: "Tomáš Holas",
    role: "admin",
  },
  {
    uid: "jLE106GOfhbw4UKQmB6jscVQgwn1",
    email: "jos.hercik@gmail.com",
    displayName: "Josef Herčík",
    role: "member",
  },
  {
    uid: "3Bz0ywA5sUOwFgjQvEs3U5y5wEB2",
    email: "stefanikova.katka@gmail.com",
    displayName: "Katarína Štefániková",
    role: "member",
  },
] as const;

type PendingWrite = {
  target: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
};

function withCompany(
  data: FirebaseFirestore.DocumentData,
): FirebaseFirestore.DocumentData {
  const next: FirebaseFirestore.DocumentData = { ...data, companyId };
  if (
    next.provenance
    && typeof next.provenance === "object"
    && typeof next.provenance.rawRef === "string"
    && next.provenance.rawRef.startsWith("calls/")
  ) {
    next.provenance = {
      ...next.provenance,
      rawRef: `companies/${companyId}/${next.provenance.rawRef}`,
    };
  }
  return next;
}

async function commit(writes: PendingWrite[]): Promise<void> {
  if (!apply) return;
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) {
      batch.set(write.target, write.data, { merge: false });
    }
    await batch.commit();
  }
}

const counts: Record<string, number> = {};
const writes: PendingWrite[] = [];

for (const collection of legacyCollections) {
  const source = await db.collection(collection).get();
  counts[collection] = source.size;
  for (const document of source.docs) {
    writes.push({
      target: db.doc(`companies/${companyId}/${collection}/${document.id}`),
      data: withCompany(document.data()),
    });
  }
}

const legacyThreads = await db.collection("agentThreads").get();
counts.agentThreads = legacyThreads.size;
let messageCount = 0;
for (const thread of legacyThreads.docs) {
  writes.push({
    target: db.doc(`companies/${companyId}/agentThreads/${thread.id}`),
    data: withCompany(thread.data()),
  });
  const messages = await thread.ref.collection("messages").get();
  messageCount += messages.size;
  for (const message of messages.docs) {
    writes.push({
      target: db.doc(
        `companies/${companyId}/agentThreads/${thread.id}/messages/${message.id}`,
      ),
      data: withCompany(message.data()),
    });
  }
}
counts.agentMessages = messageCount;

const legacyCompany = db.doc("companies/default");
const [legacyConnections, legacyContextItems] = await Promise.all([
  legacyCompany.collection("connections").get(),
  legacyCompany.collection("contextItems").get(),
]);
counts.connections = legacyConnections.size;
counts.contextItems = legacyContextItems.size;
let resourceCount = 0;
for (const connection of legacyConnections.docs) {
  writes.push({
    target: db.doc(`companies/${companyId}/connections/${connection.id}`),
    data: withCompany(connection.data()),
  });
  const resources = await connection.ref.collection("resources").get();
  resourceCount += resources.size;
  for (const resource of resources.docs) {
    writes.push({
      target: db.doc(
        `companies/${companyId}/connections/${connection.id}/resources/${resource.id}`,
      ),
      data: withCompany(resource.data()),
    });
  }
}
counts.resources = resourceCount;
for (const contextItem of legacyContextItems.docs) {
  writes.push({
    target: db.doc(`companies/${companyId}/contextItems/${contextItem.id}`),
    data: withCompany(contextItem.data()),
  });
}

const now = Timestamp.now();
writes.push({
  target: db.doc(`companies/${companyId}`),
  data: {
    displayName: companyName,
    status: "active",
    createdAt: now,
    migratedAt: now,
    updatedAt: now,
  },
});

for (const explorer of explorers) {
  const access = await db.doc(`access/${explorer.uid}`).get();
  if (
    !access.exists
    || String(access.data()?.email || "").toLocaleLowerCase() !== explorer.email
    || access.data()?.enabled !== true
  ) {
    throw new Error(`Production access record did not match ${explorer.email}`);
  }
  const photoURL = String(access.data()?.photoURL || "");
  writes.push({
    target: db.doc(`users/${explorer.uid}`),
    data: {
      email: explorer.email,
      emailNormalized: explorer.email,
      displayName: String(access.data()?.displayName || explorer.displayName),
      photoURL,
      activeCompanyId: companyId,
      registeredAt: access.data()?.createdAt || now,
      migratedAt: now,
      updatedAt: now,
    },
  });
  writes.push({
    target: db.doc(`companies/${companyId}/memberships/${explorer.uid}`),
    data: {
      uid: explorer.uid,
      email: explorer.email,
      emailNormalized: explorer.email,
      displayName: String(access.data()?.displayName || explorer.displayName),
      photoURL,
      role: explorer.role,
      status: "active",
      joinedAt: access.data()?.createdAt || now,
      migratedAt: now,
      updatedAt: now,
    },
  });
}
counts.memberships = explorers.length;

writes.push({
  target: db.collection(`companies/${companyId}/auditEvents`).doc("multi_tenant_migration"),
  data: {
    companyId,
    type: "company.migrated_to_tenant_scope",
    actor: { kind: "system", id: "multi-tenant-migration" },
    after: { counts },
    createdAt: FieldValue.serverTimestamp(),
  },
});

await commit(writes);

if (apply) {
  for (const collection of legacyCollections) {
    const target = await db.collection(`companies/${companyId}/${collection}`).count().get();
    if (target.data().count < counts[collection]!) {
      throw new Error(
        `Migration verification failed for ${collection}: expected at least `
        + `${counts[collection]}, found ${target.data().count}`,
      );
    }
  }
  const [memberships, connections, contextItems] = await Promise.all([
    db.collection(`companies/${companyId}/memberships`).count().get(),
    db.collection(`companies/${companyId}/connections`).count().get(),
    db.collection(`companies/${companyId}/contextItems`).count().get(),
  ]);
  if (memberships.data().count !== explorers.length) {
    throw new Error("Migration verification failed for Explorers memberships");
  }
  if (connections.data().count < counts.connections!) {
    throw new Error("Migration verification failed for source connections");
  }
  if (contextItems.data().count < counts.contextItems!) {
    throw new Error("Migration verification failed for context items");
  }
}

process.stdout.write(`${JSON.stringify({
  mode: apply ? "applied" : "dry-run",
  companyId,
  companyName,
  writes: writes.length,
  counts,
}, null, 2)}\n`);
