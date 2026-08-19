import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db, jsonSafe } from "../firestore.js";
import {
  capabilityDescriptor,
  connectorCatalog,
  microsoft365Capabilities,
} from "./registry.js";
import { decryptCredentials } from "./credentials.js";
import { githubInstallationRoutingPath } from "./github.js";
import {
  connectorSyncPublicState,
  refreshConnectorSyncAggregates,
} from "./sync-runtime.js";
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
import {
  audienceEquals,
  companyAudience,
  isAudienceBroadened,
  normalizeResourceAudience,
  validatedResourceAudience,
  type ResourceAudience,
} from "../access.js";
import { callContactId } from "../calls.js";
import { normalizePhone } from "../phone.js";
import { microsoftTeamsTenantPath } from "./microsoft-teams.js";
import { redactExternalConversationsForConnection } from "../agent/conversation-retention.js";

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
  const capabilityId = (
    typeof safe.capabilityId === "string" ? safe.capabilityId : fallbackCapabilityId
  ) as SourceCapabilityId;
  return {
    id,
    connectionId,
    capabilityId,
    resourceType: (safe.resourceType || "phone_line") as ConnectionResourcePublicView["resourceType"],
    externalId: String(safe.externalId || id),
    displayName: String(safe.displayName || safe.externalId || id),
    status: safe.status === "disabled" ? "disabled" : "enabled",
    audience: normalizeResourceAudience(safe.audience),
    audienceRevision: Math.max(1, Number(safe.audienceRevision || 1)),
    itemCount: Number(safe.itemCount || 0),
    lastObservedAt: typeof safe.lastObservedAt === "string" ? safe.lastObservedAt : null,
    ...(safe.sync && typeof safe.sync === "object" ? {
      sync: connectorSyncPublicState(safe.sync, {
        fallbackObservedAt: safe.lastObservedAt,
        ...([
          "context.calendar.read",
          "context.document.read",
          "context.github.issue.read",
        ].includes(capabilityId) ? { staleAfterMs: 75 * 60 * 1_000 } : {}),
      }) as ConnectionResourcePublicView["sync"],
    } : {}),
    ...(capabilityId === "context.document.read" ? {
      document: {
        recursive: safe.recursive === true,
        markdownCount: Number(
          (safe.extractionCounts as Record<string, unknown> | undefined)?.markdown || 0,
        ),
        plainTextCount: Number(
          (safe.extractionCounts as Record<string, unknown> | undefined)?.plain_text || 0,
        ),
        metadataOnlyCount: Number(
          (safe.extractionCounts as Record<string, unknown> | undefined)?.metadata || 0,
        ),
      },
    } : {}),
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
    const webhook = (data.webhook || {}) as Record<string, unknown>;
    const subscription = (data.subscription || {}) as Record<string, unknown>;
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
        sync: connectorSyncPublicState(stats) as CapabilityConfigurationPublicView["sync"],
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      }]
      : capabilitySnapshots.docs.map((capability) => {
        const safe = jsonSafe(capability.data()) as Record<string, unknown>;
        const capabilityStats = (safe.stats || {}) as Record<string, unknown>;
        const capabilityId = String(safe.capabilityId) as SourceCapabilityId;
        const descriptor = connectorId === "microsoft_365"
          ? microsoft365Capabilities[
            capabilityId as keyof typeof microsoft365Capabilities
          ] || capabilityDescriptor(capabilityId)
          : capabilityDescriptor(capabilityId);
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
          requiredScopes: Array.isArray(safe.requiredScopes)
            ? safe.requiredScopes.map(String)
            : descriptor.requiredScopes,
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
          ...(
            connectorId !== "microsoft_365"
            || capabilityId === "context.mail.read_scoped"
              ? {
                sync: connectorSyncPublicState(capabilityStats, {
                  ...([
                    "context.calendar.read",
                    "context.document.read",
                    "context.github.issue.read",
                  ].includes(capabilityId)
                    ? { staleAfterMs: 75 * 60 * 1_000 }
                    : {}),
                }) as CapabilityConfigurationPublicView["sync"],
              } : {}
          ),
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
        : connectorId === "microsoft_365" || connectorId === "microsoft_teams"
          ? "microsoft"
        : connectorId === "github"
          ? "github"
        : connectorId === "grok_subscription"
            ? "grok"
            : connectorId === "slack"
              ? "slack"
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
      member: connectorId === "microsoft_365" && data.member && typeof data.member === "object"
        ? {
          entraObjectId: String((data.member as Record<string, unknown>).entraObjectId || ""),
          displayName: String((data.member as Record<string, unknown>).displayName || ""),
          userPrincipalName: String(
            (data.member as Record<string, unknown>).userPrincipalName || "",
          ),
        }
        : undefined,
      authorization: connectorId === "microsoft_365"
        && data.authorization
        && typeof data.authorization === "object"
        ? {
          state: String(
            (data.authorization as Record<string, unknown>).state || "error",
          ) as NonNullable<ConnectionPublicView["authorization"]>["state"],
          recoveryAction: String(
            (data.authorization as Record<string, unknown>).recoveryAction || "retry",
          ) as NonNullable<ConnectionPublicView["authorization"]>["recoveryAction"],
          lastCheckedAt: typeof (data.authorization as Record<string, unknown>).lastCheckedAt === "string"
            ? (data.authorization as Record<string, unknown>).lastCheckedAt as string
            : null,
          lastErrorCode: typeof (data.authorization as Record<string, unknown>).lastErrorCode === "string"
            ? (data.authorization as Record<string, unknown>).lastErrorCode as string
            : null,
          lastError: typeof (data.authorization as Record<string, unknown>).lastError === "string"
            ? (data.authorization as Record<string, unknown>).lastError as string
            : null,
        }
        : undefined,
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
      sync: connectorSyncPublicState(stats, {
        ...(["google_workspace", "github"].includes(connectorId)
          ? { staleAfterMs: 75 * 60 * 1_000 }
          : {}),
      }) as ConnectionPublicView["sync"],
      webhook: connectorId === "github" ? {
        status: ["active", "attention"].includes(String(webhook.status))
          ? webhook.status as "active" | "attention"
          : "pending",
        lastDeliveryAt: typeof webhook.lastDeliveryAt === "string"
          ? webhook.lastDeliveryAt
          : null,
        lastEvent: typeof webhook.lastEvent === "string" ? webhook.lastEvent : null,
        lastAction: typeof webhook.lastAction === "string" ? webhook.lastAction : null,
        lastOutcome: typeof webhook.lastOutcome === "string" ? webhook.lastOutcome : null,
        lastError: typeof webhook.lastError === "string" ? webhook.lastError : null,
      } : undefined,
      subscription: connectorId === "grok_subscription" ? {
        state: [
          "connecting",
          "waiting_for_user",
          "active",
          "attention",
          "disconnecting",
          "disconnected",
        ].includes(String(subscription.state))
          ? subscription.state as NonNullable<ConnectionPublicView["subscription"]>["state"]
          : "attention",
        currentAuthSessionId: typeof subscription.currentAuthSessionId === "string"
          ? subscription.currentAuthSessionId
          : null,
        teamId: typeof subscription.teamId === "string" ? subscription.teamId : null,
        lastAuthenticatedAt: typeof subscription.lastAuthenticatedAt === "string"
          ? subscription.lastAuthenticatedAt
          : null,
        sessionExpiresAt: typeof subscription.sessionExpiresAt === "string"
          ? subscription.sessionExpiresAt
          : null,
        lastSuccessfulRunAt: typeof subscription.lastSuccessfulRunAt === "string"
          ? subscription.lastSuccessfulRunAt
          : null,
        lastDisconnectedAt: typeof subscription.lastDisconnectedAt === "string"
          ? subscription.lastDisconnectedAt
          : null,
        lastError: typeof subscription.lastError === "string"
          ? subscription.lastError
          : null,
      } : undefined,
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
      audience: companyAudience,
      audienceRevision: 1,
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
  if (snapshot.data()?.connectorId === "microsoft_365") {
    throw new Error(
      "Microsoft 365 account status is managed through authorization and disconnect",
    );
  }
  if (snapshot.data()?.connectorId === "microsoft_teams") {
    throw new Error("Microsoft Teams installation status is managed through install and removal");
  }
  if (snapshot.data()?.connectorId === "grok_subscription") {
    throw new Error(
      "Grok subscription status is managed through its isolated authorization worker",
    );
  }
  await ref.set({
    status,
    syncGeneration: Number(snapshot.data()?.syncGeneration || 0) + 1,
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
  if (data.connectorId === "grok_subscription") {
    throw new Error(
      "Disconnect the Grok subscription before removing its local connection record",
    );
  }
  await ref.set({
    status: "disconnected",
    syncGeneration: Number(data.syncGeneration || 0) + 1,
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

async function recordsLinkedToCalls(
  database: FirebaseFirestore.Firestore,
  companyId: string,
  callIds: string[],
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (callIds.length === 0) return [];
  const specs = [
    { collection: "workItems", field: "callId" },
    { collection: "cases", field: "callId" },
    { collection: "actionApprovals", field: "source.callId" },
    { collection: "workflowRuns", field: "contextId" },
    { collection: "auditEvents", field: "callId" },
  ];
  const snapshots: FirebaseFirestore.QuerySnapshot[] = [];
  for (let offset = 0; offset < callIds.length; offset += 30) {
    const ids = callIds.slice(offset, offset + 30);
    snapshots.push(...await Promise.all(specs.map((spec) => database
      .collection(`companies/${companyId}/${spec.collection}`)
      .where(spec.field, "in", ids)
      .get())));
  }
  return [...new Map(snapshots.flatMap((snapshot) => snapshot.docs)
    .map((document) => [document.ref.path, document] as const)).values()];
}

async function recordsLinkedToContextItems(
  database: FirebaseFirestore.Firestore,
  companyId: string,
  contextItemIds: string[],
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (contextItemIds.length === 0) return [];
  const specs = [
    { collection: "actionApprovals", field: "source.issueContextItemId" },
    { collection: "codingRuns", field: "github.issueContextItemId" },
    { collection: "auditEvents", field: "issueContextItemId" },
  ];
  const snapshots: FirebaseFirestore.QuerySnapshot[] = [];
  for (let offset = 0; offset < contextItemIds.length; offset += 30) {
    const ids = contextItemIds.slice(offset, offset + 30);
    snapshots.push(...await Promise.all(specs.map((spec) => database
      .collection(`companies/${companyId}/${spec.collection}`)
      .where(spec.field, "in", ids)
      .get())));
  }
  return [...new Map(snapshots.flatMap((snapshot) => snapshot.docs)
    .map((document) => [document.ref.path, document] as const)).values()];
}

function uniqueDocuments(
  documents: FirebaseFirestore.QueryDocumentSnapshot[],
): FirebaseFirestore.QueryDocumentSnapshot[] {
  return [...new Map(documents.map((document) => [document.ref.path, document] as const)).values()];
}

async function contactAccessProjections(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  affectedCalls: FirebaseFirestore.QueryDocumentSnapshot[];
  audience?: ResourceAudience;
  enabled?: boolean;
}): Promise<Array<{
  ref: FirebaseFirestore.DocumentReference;
  access: ResourceAudience;
  indexingEnabled: boolean;
}>> {
  const affectedIds = new Set(input.affectedCalls.map((call) => call.id));
  const contactIdForCall = (call: FirebaseFirestore.QueryDocumentSnapshot): string | null => {
    const contactId = call.data().contactId;
    if (typeof contactId === "string" && contactId) return contactId;
    if (call.data().status !== "completed") return null;
    const phone = normalizePhone(typeof call.data().from === "string" ? call.data().from : null);
    return phone ? callContactId(phone) : null;
  };
  const contactIds = [...new Set(input.affectedCalls
    .map(contactIdForCall)
    .filter((contactId): contactId is string => Boolean(contactId)))];
  return (await Promise.all(contactIds.map(async (contactId) => {
    const contactRef = input.database.doc(`companies/${input.companyId}/contacts/${contactId}`);
    const [contact, calls] = await Promise.all([
      contactRef.get(),
      input.database.collection(`companies/${input.companyId}/calls`)
        .where("contactId", "==", contactId)
        .get(),
    ]);
    if (contact.exists && (
      contact.data()?.origin !== "call"
      && typeof contact.data()?.createdFromCallId !== "string"
    )) return null;
    const projectedCalls = uniqueDocuments([
      ...calls.docs,
      ...input.affectedCalls.filter((call) => contactIdForCall(call) === contactId),
    ]);
    const memberIds = new Set<string>();
    let companyVisible = false;
    let enabledCalls = 0;
    for (const call of projectedCalls) {
      const affected = affectedIds.has(call.id);
      const enabled = affected && input.enabled !== undefined
        ? input.enabled
        : call.data().indexingEnabled !== false && call.data().contextEnabled !== false;
      if (!enabled) continue;
      enabledCalls += 1;
      const audience = affected && input.audience
        ? input.audience
        : normalizeResourceAudience(call.data().access);
      if (audience.visibility === "company") {
        companyVisible = true;
        break;
      }
      audience.memberIds.forEach((memberId) => memberIds.add(memberId));
    }
    const access: ResourceAudience = companyVisible
      ? companyAudience
      : { visibility: "restricted", memberIds: [...memberIds].sort() };
    return {
      ref: contactRef,
      access,
      indexingEnabled: enabledCalls > 0 && (companyVisible || memberIds.size > 0),
    };
  }))).filter((projection): projection is NonNullable<typeof projection> => projection !== null);
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
  const [connection, capabilities, resources, contextItems, calls, microsoftSubscriptions,
    microsoftNotifications, teamsUsers, teamsGlobalIdentities] = await Promise.all([
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
    input.connectorId === "microsoft_365"
      ? database.collection("microsoftGraphSubscriptions")
        .where("companyId", "==", input.companyId).get()
      : Promise.resolve(null),
    input.connectorId === "microsoft_365"
      ? database.collection("microsoftGraphNotifications")
        .where("companyId", "==", input.companyId).get()
      : Promise.resolve(null),
    input.connectorId === "microsoft_teams"
      ? connectionRef.collection("teamsUsers").get()
      : Promise.resolve(null),
    input.connectorId === "microsoft_teams"
      ? database.collection("microsoftTeamsIdentities")
        .where("companyId", "==", input.companyId).get()
      : Promise.resolve(null),
  ]);
  if (!connection.exists) throw new Error("Connection not found");
  const conversationCleanup = ["slack", "microsoft_teams"].includes(input.connectorId)
    ? await redactExternalConversationsForConnection({
      companyId: input.companyId,
      connectionId: input.connectionId,
      reason: "connector_deleted",
      database,
    })
    : { conversations: 0, events: 0 };

  const linkedRecords = uniqueDocuments((await Promise.all([
    recordsLinkedToCalls(
      database,
      input.companyId,
      (calls?.docs || []).map((call) => call.id),
    ),
    recordsLinkedToContextItems(
      database,
      input.companyId,
      contextItems.docs.map((contextItem) => contextItem.id),
    ),
  ])).flat());
  const contactProjections = await contactAccessProjections({
    database,
    companyId: input.companyId,
    affectedCalls: calls?.docs || [],
    enabled: false,
  });
  await commitInChunks([
    ...(calls?.docs || []).map((call) => (batch: FirebaseFirestore.WriteBatch) => batch.set(call.ref, {
      contextEnabled: false,
      indexingEnabled: false,
      sourceConnectionDeletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
    ...linkedRecords.map((record) => (batch: FirebaseFirestore.WriteBatch) => batch.set(record.ref, {
      indexingEnabled: false,
      sourceConnectionDeletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
    ...contactProjections.map((contact) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.set(contact.ref, {
      access: contact.access,
      indexingEnabled: contact.indexingEnabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
  ], database);
  await commitInChunks([
    ...contextItems.docs.map((item) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(item.ref)),
    ...capabilities.docs.map((capability) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(capability.ref)),
    ...resources.docs.map((resource) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(resource.ref)),
    ...(teamsUsers?.docs || []).map((identity) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.delete(identity.ref)),
    ...(teamsGlobalIdentities?.docs || [])
      .filter((identity) => identity.data().connectionId === input.connectionId)
      .map((identity) => (
        batch: FirebaseFirestore.WriteBatch,
      ) => batch.delete(identity.ref)),
    ...(microsoftSubscriptions?.docs || [])
      .filter((document) => document.data().connectionId === input.connectionId)
      .map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(document.ref)),
    ...(microsoftNotifications?.docs || [])
      .filter((document) => document.data().connectionId === input.connectionId)
      .map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(document.ref)),
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
    conversationsRedacted: conversationCleanup.conversations,
    conversationEventsRedacted: conversationCleanup.events,
    occurredAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  });
  const githubInstallationId = Number(connection.data()?.installationId);
  if (input.connectorId === "github" && Number.isSafeInteger(githubInstallationId)) {
    batch.delete(database.doc(githubInstallationRoutingPath(githubInstallationId)));
  }
  if (input.connectorId === "microsoft_teams" && connection.data()?.tenantId) {
    batch.delete(database.doc(microsoftTeamsTenantPath(String(connection.data()?.tenantId))));
  }
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
  const [contextItems, calls] = await Promise.all([
    database.collection(`companies/${input.companyId}/contextItems`)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resourceId)
      .get(),
    database.collection(`companies/${input.companyId}/calls`)
      .where("connectionId", "==", input.connectionId)
      .where("resourceId", "==", input.resourceId)
      .get(),
  ]);
  const linkedRecords = uniqueDocuments((await Promise.all([
    recordsLinkedToCalls(database, input.companyId, calls.docs.map((call) => call.id)),
    recordsLinkedToContextItems(
      database,
      input.companyId,
      contextItems.docs.map((contextItem) => contextItem.id),
    ),
  ])).flat());
  const contactProjections = await contactAccessProjections({
    database,
    companyId: input.companyId,
    affectedCalls: calls.docs,
    enabled: input.enabled,
  });
  await commitInChunks([
    (batch) => batch.set(resourceRef, {
      status: input.enabled ? "enabled" : "disabled",
      syncLease: null,
      syncLeaseGeneration: Number(resource.data()?.syncLeaseGeneration || 0) + 1,
      updatedBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
    ...contextItems.docs.map((context) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      context.ref,
      { indexingEnabled: input.enabled, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )),
    ...calls.docs.map((call) => (batch: FirebaseFirestore.WriteBatch) => batch.set(call.ref, {
      contextEnabled: input.enabled,
      indexingEnabled: input.enabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
    ...linkedRecords.map((record) => (batch: FirebaseFirestore.WriteBatch) => batch.set(record.ref, {
      indexingEnabled: input.enabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
    ...contactProjections.map((contact) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.set(contact.ref, {
      access: contact.access,
      indexingEnabled: contact.indexingEnabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
  ], database);
  const capabilityId = resource.data()?.capabilityId as SourceCapabilityId | undefined;
  if (capabilityId) {
    const descriptor = capabilityDescriptor(capabilityId);
    await refreshConnectorSyncAggregates({
      companyId: input.companyId,
      connectionId: input.connectionId,
      capabilityId,
      serviceId: descriptor.serviceId,
    }, { database });
  }
}

export async function setResourceAudience(
  input: {
    companyId: string;
    connectionId: string;
    resourceId: string;
    audience: ResourceAudience;
    expectedRevision: number;
    confirmBroadening: boolean;
    actorUid: string;
  },
  database: FirebaseFirestore.Firestore = db,
): Promise<{ changed: boolean; revision: number; projectedItems: number; projectedCalls: number }> {
  const connectionRef = connectionCollection(input.companyId, database).doc(input.connectionId);
  const resourceRef = connectionRef.collection("resources").doc(input.resourceId);
  const [connection, audience] = await Promise.all([
    connectionRef.get(),
    validatedResourceAudience({
      companyId: input.companyId,
      audience: input.audience,
      database,
    }),
  ]);
  if (!connection.exists) throw new Error("Connection resource not found");
  const reservation = await database.runTransaction(async (transaction) => {
    const resource = await transaction.get(resourceRef);
    if (!resource.exists) throw new Error("Connection resource not found");
    const currentAudience = normalizeResourceAudience(resource.data()?.audience);
    const currentRevision = Math.max(1, Number(resource.data()?.audienceRevision || 1));
    if (currentRevision !== input.expectedRevision) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "The resource audience changed. Reload and try again.",
      });
    }
    const sameAudience = audienceEquals(currentAudience, audience);
    const projectionUpdating = resource.data()?.audienceProjection?.status === "updating";
    if (sameAudience && !projectionUpdating) {
      return {
        changed: false as const,
        revision: currentRevision,
        currentAudience,
      };
    }
    if (!sameAudience && projectionUpdating) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "The resource audience is still being projected. Reload and try again.",
      });
    }
    if (!sameAudience && isAudienceBroadened(currentAudience, audience) && !input.confirmBroadening) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "AUDIENCE_BROADENING_REQUIRES_CONFIRMATION",
      });
    }
    const revision = sameAudience ? currentRevision : currentRevision + 1;
    transaction.set(resourceRef, {
      audience,
      audienceRevision: revision,
      audienceProjection: { status: "updating", revision },
      updatedBy: input.actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      changed: true as const,
      revision,
      currentAudience,
      resumed: sameAudience,
    };
  });
  if (!reservation.changed) {
    return { changed: false, revision: reservation.revision, projectedItems: 0, projectedCalls: 0 };
  }
  const { revision } = reservation;
  const [contextItems, calls] = await Promise.all([
    database.collection(`companies/${input.companyId}/contextItems`)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", input.resourceId)
      .get(),
    database.collection(`companies/${input.companyId}/calls`)
      .where("connectionId", "==", input.connectionId)
      .where("resourceId", "==", input.resourceId)
      .get(),
  ]);
  const linkedRecords = uniqueDocuments((await Promise.all([
    recordsLinkedToCalls(database, input.companyId, calls.docs.map((call) => call.id)),
    recordsLinkedToContextItems(
      database,
      input.companyId,
      contextItems.docs.map((contextItem) => contextItem.id),
    ),
  ])).flat());
  const contactProjections = await contactAccessProjections({
    database,
    companyId: input.companyId,
    affectedCalls: calls.docs,
    audience,
  });
  await commitInChunks([
    ...contextItems.docs.map((context) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      context.ref,
      {
        access: audience,
        accessRevision: revision,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )),
    ...calls.docs.map((call) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      call.ref,
      {
        access: audience,
        accessRevision: revision,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )),
    ...linkedRecords.map((record) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      record.ref,
      {
        access: audience,
        accessRevision: revision,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )),
    ...contactProjections.map((contact) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.set(contact.ref, {
      access: contact.access,
      indexingEnabled: contact.indexingEnabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })),
  ], database);
  await resourceRef.set({
    audienceProjection: {
      status: "projected",
      revision,
      contextItems: contextItems.size,
      calls: calls.size,
      linkedRecords: linkedRecords.length,
      contacts: contactProjections.length,
      completedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (!reservation.resumed) {
    await database.collection(`companies/${input.companyId}/auditEvents`).add({
      eventType: "source.resource_audience_changed",
      actorUid: input.actorUid,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      before: reservation.currentAudience,
      after: audience,
      access: audience,
      indexingEnabled: true,
      audienceRevision: revision,
      occurredAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  return {
    changed: true,
    revision,
    projectedItems: contextItems.size,
    projectedCalls: calls.size,
  };
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
  const connectionRef = connectionCollection(input.companyId, database).doc(input.connectionId);
  const connectionSnapshot = await connectionRef.get();
  const connectorId = connectionSnapshot.data()?.connectorId;
  const descriptor = connectorId === "microsoft_365"
    ? microsoft365Capabilities[
      input.capabilityId as keyof typeof microsoft365Capabilities
    ] || capabilityDescriptor(input.capabilityId)
    : capabilityDescriptor(input.capabilityId);
  const capabilityRef = connectionRef.collection("capabilities").doc(descriptor.serviceId);
  const [connection, capability, resources, contextItems] = await Promise.all([
    Promise.resolve(connectionSnapshot),
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
    || !["google_workspace", "microsoft_365"].includes(String(connection.data()?.connectorId))
    || !capability.exists
  ) {
    throw new Error("OAuth capability not found");
  }
  if (
    input.enabled
    && !["active", "permission_granted", "disabled"].includes(String(capability.data()?.status))
  ) {
    throw new Error("Reconnect the provider before enabling this service");
  }
  if (
    input.enabled
    && connectorId === "microsoft_365"
    && connection.data()?.authorization?.state !== "healthy"
  ) {
    throw new Error("Reconnect Microsoft 365 before enabling this capability");
  }
  await commitInChunks([
    (batch) => batch.set(capabilityRef, {
      status: input.enabled
        ? connectorId === "microsoft_365" ? "permission_granted" : "active"
        : "disabled",
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
      syncLease: null,
      syncLeaseGeneration: Number(resource.data().syncLeaseGeneration || 0) + 1,
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
  if (connectorId !== "microsoft_365") {
    await refreshConnectorSyncAggregates({
      companyId: input.companyId,
      connectionId: input.connectionId,
      capabilityId: input.capabilityId,
      serviceId: descriptor.serviceId,
    }, { database });
  } else if (
    ["context.mail.read_scoped", "context.calendar.read"].includes(input.capabilityId)
    && !input.enabled
  ) {
    const subscriptions = await database.collection("microsoftGraphSubscriptions")
      .where("companyId", "==", input.companyId).get();
    await commitInChunks(subscriptions.docs
      .filter((document) => document.data().connectionId === input.connectionId
        && document.data().capabilityId === input.capabilityId)
      .map((document) => (batch) => batch.set(document.ref, {
        status: "disabled",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })), database);
  }
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
      audience: companyAudience,
      audienceRevision: 1,
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
      access: companyAudience,
      accessRevision: 1,
      indexingEnabled: true,
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
