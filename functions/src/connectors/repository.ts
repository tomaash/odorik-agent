import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, jsonSafe } from "../firestore.js";
import { adapterCatalog } from "./registry.js";
import {
  defaultCompanyId,
  legacyOdorikConnectionId,
  odorikContextItem,
  odorikContextItemId,
  odorikResourceIdentity,
} from "./odorik.js";
import type {
  AdapterId,
  ConnectionPublicView,
  ConnectionResourcePublicView,
} from "./types.js";

const ingestBaseUrl = process.env.ODORIK_INGEST_BASE_URL?.trim()
  || "https://odorik-ingest-apf5skngva-ey.a.run.app";

function connectionCollection(companyId = defaultCompanyId) {
  return db.collection(`companies/${companyId}/connections`);
}

function publicResource(
  connectionId: string,
  id: string,
  data: Record<string, unknown>,
): ConnectionResourcePublicView {
  const safe = jsonSafe(data) as Record<string, unknown>;
  return {
    id,
    connectionId,
    resourceType: (safe.resourceType || "phone_line") as ConnectionResourcePublicView["resourceType"],
    externalId: String(safe.externalId || id),
    displayName: String(safe.displayName || safe.externalId || id),
    status: safe.status === "disabled" ? "disabled" : "enabled",
    itemCount: Number(safe.itemCount || 0),
    lastObservedAt: typeof safe.lastObservedAt === "string" ? safe.lastObservedAt : null,
    createdAt: typeof safe.createdAt === "string" ? safe.createdAt : null,
    updatedAt: typeof safe.updatedAt === "string" ? safe.updatedAt : null,
  };
}

export async function listSources(companyId = defaultCompanyId) {
  const connectionsSnapshot = await connectionCollection(companyId)
    .orderBy("createdAt", "asc")
    .get();
  const connections = await Promise.all(connectionsSnapshot.docs.map(async (document) => {
    const data = jsonSafe(document.data()) as Record<string, unknown>;
    const resourcesSnapshot = await document.ref.collection("resources")
      .orderBy("displayName", "asc")
      .get();
    const resources = resourcesSnapshot.docs.map((resource) => publicResource(
      document.id,
      resource.id,
      resource.data(),
    ));
    const stats = (data.stats || {}) as Record<string, unknown>;
    const auth = (data.auth || {}) as Record<string, unknown>;
    const connection: ConnectionPublicView = {
      id: document.id,
      companyId,
      adapterId: String(data.adapterId || "odorik") as AdapterId,
      displayName: String(data.displayName || document.id),
      status: (data.status || "attention") as ConnectionPublicView["status"],
      authKind: (auth.kind || "basic_upload") as ConnectionPublicView["authKind"],
      credentialMode: (auth.credentialMode || "none") as ConnectionPublicView["credentialMode"],
      accountLabel: typeof data.accountLabel === "string" ? data.accountLabel : undefined,
      uploadUrl: data.adapterId === "odorik"
        ? `${ingestBaseUrl}/webhooks/odorik/${document.id}/recordings`
        : undefined,
      lastSyncAt: typeof stats.lastSyncAt === "string" ? stats.lastSyncAt : null,
      lastObservedAt: typeof stats.lastObservedAt === "string"
        ? stats.lastObservedAt
        : typeof stats.lastSyncAt === "string"
          ? stats.lastSyncAt
          : null,
      lastError: typeof stats.lastError === "string" ? stats.lastError : null,
      itemCount: Number(stats.itemCount || resources.reduce((sum, item) => sum + item.itemCount, 0)),
      resourceCount: resources.length,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      resources,
    };
    return connection;
  }));
  return {
    companyId,
    adapters: adapterCatalog(),
    connections,
  };
}

export async function createOdorikConnection(input: {
  displayName: string;
  accountLabel?: string;
  credentialCiphertext: string;
  usernameHint: string;
  createdBy: string;
  numbers: string[];
}): Promise<{ connectionId: string; uploadUrl: string }> {
  const connectionRef = connectionCollection().doc();
  const now = Timestamp.now();
  const batch = db.batch();
  batch.set(db.doc(`companies/${defaultCompanyId}`), {
    displayName: "Default company",
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(connectionRef, {
    companyId: defaultCompanyId,
    adapterId: "odorik",
    displayName: input.displayName,
    accountLabel: input.accountLabel || null,
    status: "active",
    auth: {
      kind: "basic_upload",
      credentialMode: "encrypted",
      usernameHint: input.usernameHint,
    },
    credentialCiphertext: input.credentialCiphertext,
    stats: { itemCount: 0, lastError: null },
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  for (const number of [...new Set(input.numbers.map((value) => value.trim()).filter(Boolean))]) {
    const identity = odorikResourceIdentity({ to: number });
    batch.set(connectionRef.collection("resources").doc(identity.resourceId), {
      connectionId: connectionRef.id,
      resourceType: "phone_line",
      externalId: identity.externalId,
      displayName: identity.displayName,
      status: "enabled",
      itemCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  await batch.commit();
  return {
    connectionId: connectionRef.id,
    uploadUrl: `${ingestBaseUrl}/webhooks/odorik/${connectionRef.id}/recordings`,
  };
}

export async function setConnectionStatus(
  connectionId: string,
  status: "active" | "disconnected",
  actorUid: string,
): Promise<void> {
  const ref = connectionCollection().doc(connectionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Connection not found");
  await ref.set({
    status,
    updatedBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function prepareConnectionDeletion(
  connectionId: string,
  actorUid: string,
): Promise<{ adapterId: AdapterId; displayName: string }> {
  const ref = connectionCollection().doc(connectionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Connection not found");
  const data = snapshot.data() || {};
  await ref.set({
    status: "disconnected",
    deletionStartedBy: actorUid,
    deletionStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    adapterId: String(data.adapterId || "odorik") as AdapterId,
    displayName: String(data.displayName || connectionId),
  };
}

async function commitInChunks(
  writes: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) write(batch);
    await batch.commit();
  }
}

export async function deleteSourceConnection(input: {
  connectionId: string;
  actorUid: string;
  adapterId: AdapterId;
  displayName: string;
  providerAccessRevoked: boolean | null;
}): Promise<{
  ok: true;
  connectionId: string;
  resourcesDeleted: number;
  contextItemsDeleted: number;
  sourceRecordsDisabled: number;
  providerAccessRevoked: boolean | null;
}> {
  const connectionRef = connectionCollection().doc(input.connectionId);
  const [connection, resources, contextItems, calls] = await Promise.all([
    connectionRef.get(),
    connectionRef.collection("resources").get(),
    db.collection(`companies/${defaultCompanyId}/contextItems`)
      .where("source.connectionId", "==", input.connectionId)
      .get(),
    input.adapterId === "odorik"
      ? db.collection("calls").where("connectionId", "==", input.connectionId).get()
      : Promise.resolve(null),
  ]);
  if (!connection.exists) throw new Error("Connection not found");

  await commitInChunks((calls?.docs || []).map((call) => (batch) => batch.set(call.ref, {
    contextEnabled: false,
    sourceConnectionDeletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })));
  await commitInChunks([
    ...contextItems.docs.map((item) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(item.ref)),
    ...resources.docs.map((resource) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(resource.ref)),
  ]);

  const auditRef = db.collection("auditEvents").doc();
  const batch = db.batch();
  batch.set(auditRef, {
    eventType: "source.connection_deleted",
    actorUid: input.actorUid,
    connectionId: input.connectionId,
    adapterId: input.adapterId,
    displayName: input.displayName,
    resourcesDeleted: resources.size,
    contextItemsDeleted: contextItems.size,
    sourceRecordsDisabled: calls?.size || 0,
    providerAccessRevoked: input.providerAccessRevoked,
    occurredAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.delete(connectionRef);
  await batch.commit();
  return {
    ok: true,
    connectionId: input.connectionId,
    resourcesDeleted: resources.size,
    contextItemsDeleted: contextItems.size,
    sourceRecordsDisabled: calls?.size || 0,
    providerAccessRevoked: input.providerAccessRevoked,
  };
}

export async function setResourceStatus(input: {
  connectionId: string;
  resourceId: string;
  enabled: boolean;
  actorUid: string;
}): Promise<void> {
  const connectionRef = connectionCollection().doc(input.connectionId);
  const resourceRef = connectionRef.collection("resources").doc(input.resourceId);
  const [connection, resource] = await Promise.all([connectionRef.get(), resourceRef.get()]);
  if (!connection.exists || !resource.exists) throw new Error("Connection resource not found");
  const batch = db.batch();
  batch.set(resourceRef, {
    status: input.enabled ? "enabled" : "disabled",
    updatedBy: input.actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const contextItems = await db.collection(`companies/${defaultCompanyId}/contextItems`)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resourceId)
    .get();
  for (const context of contextItems.docs) {
    batch.update(
      context.ref,
      "access.visibility",
      input.enabled ? "company" : "restricted",
      "access.memberIds",
      input.enabled ? FieldValue.delete() : [],
      "indexingEnabled",
      input.enabled,
      "updatedAt",
      FieldValue.serverTimestamp(),
    );
  }
  await batch.commit();
}

export async function migrateLegacyOdorik(actorUid: string): Promise<{
  connectionId: string;
  calls: number;
  resources: number;
  contextItems: number;
}> {
  const connectionRef = connectionCollection().doc(legacyOdorikConnectionId);
  const calls = await db.collection("calls").limit(1000).get();
  const now = Timestamp.now();
  const resources = new Map<string, ReturnType<typeof odorikResourceIdentity>>();
  let contextItems = 0;

  for (const call of calls.docs) {
    resources.set(odorikResourceIdentity(call.data()).resourceId, odorikResourceIdentity(call.data()));
  }

  const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  writes.push((batch) => {
    batch.set(db.doc(`companies/${defaultCompanyId}`), {
      displayName: "Default company",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(connectionRef, {
      companyId: defaultCompanyId,
      adapterId: "odorik",
      displayName: "Primary Odorik account",
      status: "active",
      auth: {
        kind: "basic_upload",
        credentialMode: "legacy_secret",
      },
      stats: {
        itemCount: calls.size,
        lastObservedAt: calls.docs
          .map((call) => call.data().uploadedAt)
          .filter((value): value is Timestamp => value instanceof Timestamp)
          .sort((a, b) => b.toMillis() - a.toMillis())[0] || null,
        lastError: null,
      },
      migratedBy: actorUid,
      migratedAt: now,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
  });

  for (const resource of resources.values()) {
    const matchingCalls = calls.docs.filter((call) => (
      odorikResourceIdentity(call.data()).resourceId === resource.resourceId
    ));
    writes.push((batch) => batch.set(connectionRef.collection("resources").doc(resource.resourceId), {
      connectionId: connectionRef.id,
      resourceType: "phone_line",
      externalId: resource.externalId,
      displayName: resource.displayName,
      status: "enabled",
      itemCount: matchingCalls.length,
      lastObservedAt: matchingCalls
        .map((call) => call.data().uploadedAt)
        .filter((value): value is Timestamp => value instanceof Timestamp)
        .sort((a, b) => b.toMillis() - a.toMillis())[0] || null,
      createdAt: now,
      updatedAt: now,
    }, { merge: true }));
  }

  for (const call of calls.docs) {
    const resource = odorikResourceIdentity(call.data());
    writes.push((batch) => batch.set(call.ref, {
      companyId: defaultCompanyId,
      connectionId: connectionRef.id,
      resourceId: resource.resourceId,
      contextEnabled: true,
      source: {
        adapterId: "odorik",
        connectionId: connectionRef.id,
        resourceId: resource.resourceId,
        externalId: call.id,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
    const contextItem = odorikContextItem(call.id, {
      ...call.data(),
      connectionId: connectionRef.id,
      resourceId: resource.resourceId,
      contextEnabled: true,
    });
    if (contextItem) {
      contextItems += 1;
      writes.push((batch) => batch.set(
        db.doc(`companies/${defaultCompanyId}/contextItems/${odorikContextItemId(connectionRef.id, call.id)}`),
        contextItem,
        { merge: false },
      ));
    }
  }

  for (let offset = 0; offset < writes.length; offset += 350) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 350)) write(batch);
    await batch.commit();
  }
  return {
    connectionId: connectionRef.id,
    calls: calls.size,
    resources: resources.size,
    contextItems,
  };
}
