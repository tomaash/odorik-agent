import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, jsonSafe } from "../firestore.js";
import { capabilityDescriptor, connectorCatalog } from "./registry.js";
import { decryptCredentials } from "./credentials.js";
import {
  legacyOdorikConnectionId,
  odorikContextItem,
  odorikContextItemId,
  odorikDestinationUrl,
  odorikResourceIdentity,
} from "./odorik.js";
import type {
  CapabilityConfigurationPublicView,
  ConnectorId,
  ConnectionPublicView,
  ConnectionResourcePublicView,
  SourceCapabilityId,
} from "./types.js";

const ingestBaseUrl = process.env.ODORIK_INGEST_BASE_URL?.trim()
  || "https://odorik-ingest-apf5skngva-ey.a.run.app";

function odorikUploadUrl(companyId: string, connectionId: string): string {
  return `${ingestBaseUrl}/webhooks/odorik/${companyId}/${connectionId}/recordings`;
}

function connectionCollection(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.collection(`companies/${companyId}/connections`);
}

export function sourceResourcePublicView(
  connectionId: string,
  id: string,
  data: Record<string, unknown>,
  fallbackCapabilityId: SourceCapabilityId = "context.call.read",
): ConnectionResourcePublicView {
  const safe = jsonSafe(data) as Record<string, unknown>;
  return {
    id,
    connectionId,
    capabilityId: (
      typeof safe.capabilityId === "string" ? safe.capabilityId : fallbackCapabilityId
    ) as SourceCapabilityId,
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

export async function listSources(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  const connectionsSnapshot = await connectionCollection(companyId, database)
    .orderBy("createdAt", "asc")
    .get();
  const connections = await Promise.all(connectionsSnapshot.docs.map(async (document) => {
    const data = jsonSafe(document.data()) as Record<string, unknown>;
    const connectorId = (
      typeof data.connectorId === "string"
        ? data.connectorId
        : data.adapterId === "odorik"
          ? "odorik"
          : null
    ) as ConnectorId | null;
    if (!connectorId) return null;
    const fallbackCapabilityId: SourceCapabilityId = connectorId === "odorik"
      ? "context.call.read"
      : connectorId === "github"
        ? "context.github.issue.read"
        : "context.document.read";
    const resourcesSnapshot = await document.ref.collection("resources")
      .orderBy("displayName", "asc")
      .get();
    const resources = resourcesSnapshot.docs.map((resource) => sourceResourcePublicView(
      document.id,
      resource.id,
      resource.data(),
      fallbackCapabilityId,
    ));
    const capabilitySnapshots = await document.ref.collection("capabilities").get();
    const stats = (data.stats || {}) as Record<string, unknown>;
    const auth = (data.auth || {}) as Record<string, unknown>;
    const capabilities: CapabilityConfigurationPublicView[] = connectorId === "odorik"
      ? [{
        id: "calls",
        capabilityId: "context.call.read",
        status: data.status === "disconnected" ? "disabled" : "active",
        grantedScopes: [],
        requiredScopes: [],
        itemCount: Number(stats.itemCount || resources.reduce((sum, item) => sum + item.itemCount, 0)),
        resourceCount: resources.length,
        lastSyncAt: typeof stats.lastSyncAt === "string" ? stats.lastSyncAt : null,
        lastObservedAt: typeof stats.lastObservedAt === "string" ? stats.lastObservedAt : null,
        lastError: typeof stats.lastError === "string" ? stats.lastError : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      }]
      : capabilitySnapshots.docs.map((capability) => {
        const safe = jsonSafe(capability.data()) as Record<string, unknown>;
        const capabilityStats = (safe.stats || {}) as Record<string, unknown>;
        const capabilityId = String(safe.capabilityId) as SourceCapabilityId;
        const descriptor = capabilityDescriptor(capabilityId);
        const capabilityResources = resources.filter(
          (resource) => resource.capabilityId === capabilityId,
        );
        return {
          id: descriptor.serviceId,
          capabilityId,
          status: String(safe.status || "attention") as CapabilityConfigurationPublicView["status"],
          grantedScopes: Array.isArray(safe.grantedScopes)
            ? safe.grantedScopes.map(String)
            : [],
          requiredScopes: descriptor.requiredScopes,
          itemCount: Number(
            capabilityStats.itemCount
            || capabilityResources.reduce((sum, item) => sum + item.itemCount, 0),
          ),
          resourceCount: capabilityResources.length,
          lastSyncAt: typeof capabilityStats.lastSyncAt === "string"
            ? capabilityStats.lastSyncAt
            : null,
          lastObservedAt: typeof capabilityStats.lastObservedAt === "string"
            ? capabilityStats.lastObservedAt
            : null,
          lastError: typeof capabilityStats.lastError === "string"
            ? capabilityStats.lastError
            : null,
          createdAt: typeof safe.createdAt === "string" ? safe.createdAt : null,
          updatedAt: typeof safe.updatedAt === "string" ? safe.updatedAt : null,
        };
      });
    const connection: ConnectionPublicView = {
      id: document.id,
      companyId,
      connectorId,
      providerId: connectorId === "google_workspace"
        ? "google"
        : connectorId === "github"
          ? "github"
          : "odorik",
      providerAccountId: typeof data.providerAccountId === "string"
        ? data.providerAccountId
        : undefined,
      tenantId: typeof data.tenantId === "string" ? data.tenantId : undefined,
      displayName: String(data.displayName || document.id),
      status: (data.status || "attention") as ConnectionPublicView["status"],
      authKind: (auth.kind || "basic_upload") as ConnectionPublicView["authKind"],
      credentialMode: (auth.credentialMode || "none") as ConnectionPublicView["credentialMode"],
      accountLabel: typeof data.accountLabel === "string" ? data.accountLabel : undefined,
      uploadUrl: connectorId === "odorik"
        ? odorikUploadUrl(companyId, document.id)
        : undefined,
      grantedScopes: Array.isArray(auth.scopes) ? auth.scopes.map(String) : [],
      lastSyncAt: typeof stats.lastSyncAt === "string" ? stats.lastSyncAt : null,
      lastObservedAt: typeof stats.lastObservedAt === "string"
        ? stats.lastObservedAt
        : typeof stats.lastSyncAt === "string"
          ? stats.lastSyncAt
          : null,
      lastError: typeof stats.lastError === "string" ? stats.lastError : null,
      reauthorizationRequired: data.reauthorizationRequired === true,
      itemCount: Number(stats.itemCount || resources.reduce((sum, item) => sum + item.itemCount, 0)),
      resourceCount: resources.length,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      capabilities,
      resources,
    };
    return connection;
  }));
  return {
    companyId,
    connectors: connectorCatalog(),
    connections: connections.filter(
      (connection): connection is ConnectionPublicView => connection !== null,
    ),
  };
}

export async function createOdorikConnection(input: {
  companyId: string;
  displayName: string;
  accountLabel?: string;
  credentialCiphertext: string;
  usernameHint: string;
  createdBy: string;
  numbers: string[];
}): Promise<{ connectionId: string; uploadUrl: string }> {
  const connectionRef = connectionCollection(input.companyId).doc();
  const now = Timestamp.now();
  const batch = db.batch();
  batch.set(db.doc(`companies/${input.companyId}`), {
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(connectionRef, {
    schemaVersion: 2,
    companyId: input.companyId,
    connectorId: "odorik",
    providerId: "odorik",
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
      capabilityId: "context.call.read",
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
    uploadUrl: odorikUploadUrl(input.companyId, connectionRef.id),
  };
}

export async function getOdorikSetupDestination(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
}): Promise<{ setupUrl: string }> {
  const connection = await connectionCollection(input.companyId).doc(input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || (data?.connectorId !== "odorik" && data?.adapterId !== "odorik")
    || data?.auth?.credentialMode !== "encrypted"
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new Error("Odorik setup address is not available for this connection");
  }
  const credentials = decryptCredentials(data.credentialCiphertext, input.credentialKey);
  if (!credentials.username || !credentials.password) {
    throw new Error("Odorik setup credentials are incomplete");
  }
  return {
    setupUrl: odorikDestinationUrl(
      odorikUploadUrl(input.companyId, input.connectionId),
      credentials.username,
      credentials.password,
    ),
  };
}

export async function setConnectionStatus(
  companyId: string,
  connectionId: string,
  status: "active" | "disconnected",
  actorUid: string,
  database: FirebaseFirestore.Firestore = db,
): Promise<void> {
  const ref = connectionCollection(companyId, database).doc(connectionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Connection not found");
  if (snapshot.data()?.connectorId === "google_workspace") {
    throw new Error(
      "Google Workspace account status is managed through authorization and revocation",
    );
  }
  await ref.set({
    status,
    updatedBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function prepareConnectionDeletion(
  companyId: string,
  connectionId: string,
  actorUid: string,
  database: FirebaseFirestore.Firestore = db,
): Promise<{ connectorId: ConnectorId; displayName: string }> {
  const ref = connectionCollection(companyId, database).doc(connectionId);
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
    connectorId: String(data.connectorId || data.adapterId || "odorik") as ConnectorId,
    displayName: String(data.displayName || connectionId),
  };
}

async function commitInChunks(
  writes: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
  database: FirebaseFirestore.Firestore,
): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = database.batch();
    for (const write of writes.slice(offset, offset + 400)) write(batch);
    await batch.commit();
  }
}

export async function deleteSourceConnection(
  input: {
    companyId: string;
    connectionId: string;
    actorUid: string;
    connectorId: ConnectorId;
    displayName: string;
    providerAccessRevoked: boolean | null;
  },
  database: FirebaseFirestore.Firestore = db,
): Promise<{
  ok: true;
  connectionId: string;
  resourcesDeleted: number;
  contextItemsDeleted: number;
  sourceRecordsDisabled: number;
  providerAccessRevoked: boolean | null;
}> {
  const connectionRef = connectionCollection(input.companyId, database).doc(input.connectionId);
  const [connection, capabilities, resources, contextItems, calls] = await Promise.all([
    connectionRef.get(),
    connectionRef.collection("capabilities").get(),
    connectionRef.collection("resources").get(),
    database.collection(`companies/${input.companyId}/contextItems`)
      .where("source.connectionId", "==", input.connectionId)
      .get(),
    input.connectorId === "odorik"
      ? database.collection(`companies/${input.companyId}/calls`)
        .where("connectionId", "==", input.connectionId).get()
      : Promise.resolve(null),
  ]);
  if (!connection.exists) throw new Error("Connection not found");

  await commitInChunks((calls?.docs || []).map((call) => (batch) => batch.set(call.ref, {
    contextEnabled: false,
    sourceConnectionDeletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })), database);
  await commitInChunks([
    ...contextItems.docs.map((item) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(item.ref)),
    ...capabilities.docs.map((capability) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(capability.ref)),
    ...resources.docs.map((resource) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(resource.ref)),
  ], database);

  const auditRef = database.collection(`companies/${input.companyId}/auditEvents`).doc();
  const batch = database.batch();
  batch.set(auditRef, {
    eventType: "source.connection_deleted",
    actorUid: input.actorUid,
    connectionId: input.connectionId,
    connectorId: input.connectorId,
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

export async function setResourceStatus(
  input: {
    companyId: string;
    connectionId: string;
    resourceId: string;
    enabled: boolean;
    actorUid: string;
  },
  database: FirebaseFirestore.Firestore = db,
): Promise<void> {
  const connectionRef = connectionCollection(input.companyId, database).doc(input.connectionId);
  const resourceRef = connectionRef.collection("resources").doc(input.resourceId);
  const [connection, resource] = await Promise.all([connectionRef.get(), resourceRef.get()]);
  if (!connection.exists || !resource.exists) throw new Error("Connection resource not found");
  const batch = database.batch();
  batch.set(resourceRef, {
    status: input.enabled ? "enabled" : "disabled",
    updatedBy: input.actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const contextItems = await database.collection(`companies/${input.companyId}/contextItems`)
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

export async function setCapabilityStatus(
  input: {
    companyId: string;
    connectionId: string;
    capabilityId: SourceCapabilityId;
    enabled: boolean;
    actorUid: string;
  },
  database: FirebaseFirestore.Firestore = db,
): Promise<void> {
  const descriptor = capabilityDescriptor(input.capabilityId);
  const connectionRef = connectionCollection(input.companyId, database).doc(input.connectionId);
  const capabilityRef = connectionRef.collection("capabilities").doc(descriptor.serviceId);
  const [connection, capability, resources, contextItems] = await Promise.all([
    connectionRef.get(),
    capabilityRef.get(),
    connectionRef.collection("resources")
      .where("capabilityId", "==", input.capabilityId)
      .get(),
    database.collection(`companies/${input.companyId}/contextItems`)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.capabilityId", "==", input.capabilityId)
      .get(),
  ]);
  if (
    !connection.exists
    || connection.data()?.connectorId !== "google_workspace"
    || !capability.exists
  ) {
    throw new Error("Workspace capability not found");
  }
  if (
    input.enabled
    && !["active", "disabled"].includes(String(capability.data()?.status))
  ) {
    throw new Error("Reconnect Google Workspace before enabling this service");
  }
  await commitInChunks([
    (batch) => batch.set(capabilityRef, {
      status: input.enabled ? "active" : "disabled",
      disabledBy: input.enabled ? FieldValue.delete() : input.actorUid,
      disabledAt: input.enabled ? FieldValue.delete() : FieldValue.serverTimestamp(),
      updatedBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
    (batch) => batch.set(connectionRef, {
      // A locally disabled subsystem does not disconnect or revoke the
      // provider account. The connection remains authorized and can later
      // enable another already-granted capability without a new OAuth flow.
      status: "active",
      updatedBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
    ...(!input.enabled ? resources.docs.map((resource) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.set(resource.ref, {
      status: "disabled",
      // Disabling a whole subsystem deletes its materialized context. Any
      // incremental cursor is therefore no longer sufficient to rebuild it:
      // the next successful sync must start from a full provider snapshot.
      itemCount: 0,
      requiresFullSync: true,
      updatedBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })) : []),
    ...(!input.enabled ? contextItems.docs.map((context) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(context.ref)) : []),
  ], database);
}

export type GoogleConnectorResetResult = {
  applied: boolean;
  companyId: string;
  connections: number;
  capabilities: number;
  resources: number;
  contextItems: number;
  oauthStates: number;
};

/**
 * One-time pre-production reset for the superseded split Google model.
 *
 * The selection is deliberately structural rather than name-based: only old
 * Calendar/Drive connections, new Workspace connections, Google-owned context,
 * and Google OAuth state qualify. Odorik and internal operational collections
 * never enter the write set.
 */
export async function resetGoogleConnectorData(
  input: {
    companyId: string;
    actorUid: string;
    apply: boolean;
  },
  database: FirebaseFirestore.Firestore = db,
): Promise<GoogleConnectorResetResult> {
  const connectionSnapshot = await connectionCollection(input.companyId, database).get();
  const googleConnections = connectionSnapshot.docs.filter((connection) => {
    const data = connection.data();
    return data.connectorId === "google_workspace"
      || data.adapterId === "google_calendar"
      || data.adapterId === "google_drive";
  });
  const googleConnectionIds = new Set(googleConnections.map((connection) => connection.id));
  const childSnapshots = await Promise.all(googleConnections.map(async (connection) => ({
    capabilities: await connection.ref.collection("capabilities").get(),
    resources: await connection.ref.collection("resources").get(),
  })));
  const contextSnapshot = await database
    .collection(`companies/${input.companyId}/contextItems`)
    .get();
  const googleContext = contextSnapshot.docs.filter((context) => {
    const source = context.data().source || {};
    return source.providerId === "google"
      || source.adapterId === "google_calendar"
      || source.adapterId === "google_drive"
      || googleConnectionIds.has(String(source.connectionId || ""));
  });
  const oauthSnapshot = await database.collection("oauthStates").get();
  const googleOauthStates = oauthSnapshot.docs.filter((state) => {
    const data = state.data();
    return data.companyId === input.companyId
      && ["google_workspace", "google_calendar", "google_drive"].includes(String(data.provider));
  });
  const result: GoogleConnectorResetResult = {
    applied: input.apply,
    companyId: input.companyId,
    connections: googleConnections.length,
    capabilities: childSnapshots.reduce(
      (sum, snapshots) => sum + snapshots.capabilities.size,
      0,
    ),
    resources: childSnapshots.reduce(
      (sum, snapshots) => sum + snapshots.resources.size,
      0,
    ),
    contextItems: googleContext.length,
    oauthStates: googleOauthStates.length,
  };
  if (!input.apply) return result;

  await commitInChunks([
    ...googleContext.map((context) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(context.ref)),
    ...googleOauthStates.map((state) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(state.ref)),
    ...childSnapshots.flatMap((snapshots) => [
      ...snapshots.capabilities.docs.map((capability) => (
        batch: FirebaseFirestore.WriteBatch,
      ) => batch.delete(capability.ref)),
      ...snapshots.resources.docs.map((resource) => (
        batch: FirebaseFirestore.WriteBatch,
      ) => batch.delete(resource.ref)),
    ]),
    ...googleConnections.map((connection) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(connection.ref)),
  ], database);
  await database.collection(`companies/${input.companyId}/auditEvents`).doc().set({
    eventType: "source.google_reset",
    actorUid: input.actorUid,
    ...result,
    occurredAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  });
  return result;
}

export async function migrateLegacyOdorik(companyId: string, actorUid: string): Promise<{
  connectionId: string;
  calls: number;
  resources: number;
  contextItems: number;
}> {
  const connectionRef = connectionCollection(companyId).doc(legacyOdorikConnectionId);
  const calls = await db.collection(`companies/${companyId}/calls`).limit(1000).get();
  const now = Timestamp.now();
  const resources = new Map<string, ReturnType<typeof odorikResourceIdentity>>();
  let contextItems = 0;

  for (const call of calls.docs) {
    resources.set(odorikResourceIdentity(call.data()).resourceId, odorikResourceIdentity(call.data()));
  }

  const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  writes.push((batch) => {
    batch.set(db.doc(`companies/${companyId}`), {
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(connectionRef, {
      schemaVersion: 2,
      companyId,
      connectorId: "odorik",
      providerId: "odorik",
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
      capabilityId: "context.call.read",
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
      companyId,
      connectionId: connectionRef.id,
      resourceId: resource.resourceId,
      contextEnabled: true,
      source: {
        providerId: "odorik",
        capabilityId: "context.call.read",
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
    }, companyId);
    if (contextItem) {
      contextItems += 1;
      writes.push((batch) => batch.set(
        db.doc(`companies/${companyId}/contextItems/${odorikContextItemId(connectionRef.id, call.id)}`),
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
