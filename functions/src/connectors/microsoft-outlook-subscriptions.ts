import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { authorizedMicrosoftCapability } from "./microsoft-oauth.js";
import { syncMicrosoftOutlookConnection, type OutlookSyncInput } from "./microsoft-outlook.js";

const capabilityId = "context.mail.read_scoped" as const;
const subscriptionCollection = "microsoftGraphSubscriptions";
const notificationCollection = "microsoftGraphNotifications";
export const microsoftOutlookWebhookUrl = "https://app.agenterik.cz/webhooks/microsoft";
export const microsoftOutlookSubscriptionResource = "me/mailFolders('inbox')/messages";
const subscriptionLifetimeMs = 6 * 24 * 60 * 60 * 1_000;
const renewalWindowMs = 24 * 60 * 60 * 1_000;

type GraphSubscription = {
  id?: string;
  resource?: string;
  changeType?: string;
  clientState?: string;
  expirationDateTime?: string;
};

type GraphSubscriptionList = { value?: GraphSubscription[] };

export type MicrosoftGraphNotification = {
  id?: string;
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  changeType?: string;
  lifecycleEvent?: string;
  resource?: string;
  clientState?: string;
  tenantId?: string;
  resourceData?: { id?: string; "@odata.type"?: string; "@odata.id"?: string };
};

export class MicrosoftGraphSubscriptionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Microsoft Graph subscription failed (${status}, ${code}): ${message}`);
    this.name = "MicrosoftGraphSubscriptionError";
  }
}

async function graphSubscriptionJson<T>(input: {
  accessToken: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  request?: typeof fetch;
}): Promise<T> {
  const request = input.request || fetch;
  const response = await request(`https://graph.microsoft.com/v1.0${input.path}`, {
    method: input.method || "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204) return {} as T;
  const body = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new MicrosoftGraphSubscriptionError(
    response.status,
    String(body.error?.code || "GRAPH_ERROR"),
    String(body.error?.message || "subscription request failed"),
  );
  return body;
}

function subscriptionDocumentId(companyId: string, connectionId: string): string {
  return sha256Hex(`${companyId}:${connectionId}:${microsoftOutlookSubscriptionResource}`).slice(0, 40);
}

function expiration(now: Timestamp): string {
  return new Date(now.toMillis() + subscriptionLifetimeMs).toISOString();
}

async function createSubscription(input: {
  companyId: string;
  connectionId: string;
  accessToken: string;
  database: FirebaseFirestore.Firestore;
  request: typeof fetch;
  now: Timestamp;
}): Promise<GraphSubscription> {
  const clientState = randomBytes(32).toString("base64url");
  try {
    return await graphSubscriptionJson<GraphSubscription>({
      accessToken: input.accessToken,
      path: "/subscriptions",
      method: "POST",
      request: input.request,
      body: {
        changeType: "created,updated,deleted",
        notificationUrl: microsoftOutlookWebhookUrl,
        lifecycleNotificationUrl: microsoftOutlookWebhookUrl,
        resource: microsoftOutlookSubscriptionResource,
        expirationDateTime: expiration(input.now),
        clientState,
      },
    });
  } catch (error) {
    if (!(error instanceof MicrosoftGraphSubscriptionError) || error.status !== 409) throw error;
    const listed = await graphSubscriptionJson<GraphSubscriptionList>({
      accessToken: input.accessToken,
      path: "/subscriptions",
      request: input.request,
    });
    const existing = (listed.value || []).find(
      (value) => value.resource?.toLocaleLowerCase() === microsoftOutlookSubscriptionResource.toLocaleLowerCase(),
    );
    if (!existing?.id || !existing.clientState) throw error;
    return existing;
  }
}

export async function ensureMicrosoftOutlookSubscription(input: OutlookSyncInput): Promise<{
  status: "created" | "renewed" | "current";
  subscriptionId: string;
  expirationDateTime: string;
}> {
  const database = input.database || db;
  const request = input.fetch || fetch;
  const now = input.now?.() || Timestamp.now();
  const ref = database.collection(subscriptionCollection).doc(
    subscriptionDocumentId(input.companyId, input.connectionId),
  );
  const current = await ref.get();
  const currentData = current.data() || {};
  const expiresAt = Date.parse(String(currentData.expirationDateTime || ""));
  if (
    currentData.status === "active"
    && currentData.providerSubscriptionId
    && Number.isFinite(expiresAt)
    && expiresAt - now.toMillis() > renewalWindowMs
  ) {
    return {
      status: "current",
      subscriptionId: String(currentData.providerSubscriptionId),
      expirationDateTime: String(currentData.expirationDateTime),
    };
  }
  const authorized = await authorizedMicrosoftCapability(capabilityId, {
    companyId: input.companyId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    credentialKey: input.credentialKey,
    dependencies: { database, fetch: request },
  });
  let subscription: GraphSubscription;
  let status: "created" | "renewed" = "created";
  if (currentData.providerSubscriptionId && currentData.status !== "removed") {
    try {
      subscription = await graphSubscriptionJson<GraphSubscription>({
        accessToken: authorized.accessToken,
        path: `/subscriptions/${encodeURIComponent(String(currentData.providerSubscriptionId))}`,
        method: "PATCH",
        request,
        body: { expirationDateTime: expiration(now) },
      });
      status = "renewed";
    } catch (error) {
      if (!(error instanceof MicrosoftGraphSubscriptionError) || ![404, 410].includes(error.status)) {
        throw error;
      }
      subscription = await createSubscription({
        companyId: input.companyId, connectionId: input.connectionId,
        accessToken: authorized.accessToken, database, request, now,
      });
    }
  } else {
    subscription = await createSubscription({
      companyId: input.companyId, connectionId: input.connectionId,
      accessToken: authorized.accessToken, database, request, now,
    });
  }
  if (!subscription.id || !subscription.expirationDateTime) {
    throw new Error("Microsoft Graph returned an incomplete Outlook subscription");
  }
  const clientState = subscription.clientState;
  const clientStateHash = clientState
    ? sha256Hex(clientState)
    : String(currentData.clientStateHash || "");
  if (!clientStateHash) throw new Error("Microsoft Graph returned no verifiable clientState");
  await ref.set({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId,
    providerSubscriptionId: subscription.id,
    resource: subscription.resource || microsoftOutlookSubscriptionResource,
    changeType: subscription.changeType || "created,updated,deleted",
    clientStateHash,
    expirationDateTime: subscription.expirationDateTime,
    status: "active",
    lastError: null,
    ...(current.exists ? {} : { createdAt: now }),
    updatedAt: now,
  }, { merge: true });
  return { status, subscriptionId: subscription.id, expirationDateTime: subscription.expirationDateTime };
}

export async function ensureAllMicrosoftOutlookSubscriptions(
  input: Omit<OutlookSyncInput, "companyId" | "connectionId">,
): Promise<Array<{ companyId: string; connectionId: string; ok: boolean; status?: string; error?: string }>> {
  const database = input.database || db;
  const companies = await database.collection("companies").get();
  const results: Array<{ companyId: string; connectionId: string; ok: boolean; status?: string; error?: string }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "microsoft_365")
      .where("status", "in", ["active", "attention"]).get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc("mail").get();
      if (!capability.exists || !["permission_granted", "active", "attention"].includes(String(capability.data()?.status))) continue;
      try {
        const ensured = await ensureMicrosoftOutlookSubscription({
          ...input, companyId: company.id, connectionId: connection.id,
        });
        results.push({ companyId: company.id, connectionId: connection.id, ok: true, status: ensured.status });
      } catch (error) {
        results.push({ companyId: company.id, connectionId: connection.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

export async function queueMicrosoftGraphNotifications(input: {
  notifications: MicrosoftGraphNotification[];
  database?: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
}): Promise<{ queued: number; duplicate: number; ignored: number }> {
  const database = input.database || db;
  const now = input.now?.() || Timestamp.now();
  let queued = 0;
  let duplicate = 0;
  let ignored = 0;
  for (const notification of input.notifications) {
    if (!notification.subscriptionId || !notification.clientState) {
      ignored += 1;
      continue;
    }
    const matches = await database.collection(subscriptionCollection)
      .where("providerSubscriptionId", "==", notification.subscriptionId).limit(2).get();
    if (matches.size !== 1) {
      ignored += 1;
      continue;
    }
    const subscription = matches.docs[0]!;
    const subscriptionData = subscription.data();
    if (
      subscriptionData.status !== "active"
      || sha256Hex(notification.clientState) !== subscriptionData.clientStateHash
    ) {
      ignored += 1;
      continue;
    }
    const fingerprint = notification.id
      ? `${notification.subscriptionId}:${notification.id}`
      : JSON.stringify({
      subscriptionId: notification.subscriptionId,
      changeType: notification.changeType,
      lifecycleEvent: notification.lifecycleEvent,
      resource: notification.resource,
      resourceId: notification.resourceData?.id,
      expiration: notification.subscriptionExpirationDateTime,
      });
    const ref = database.collection(notificationCollection).doc(sha256Hex(fingerprint));
    const wasCreated = await database.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) return false;
      transaction.create(ref, {
        companyId: subscriptionData.companyId,
        connectionId: subscriptionData.connectionId,
        subscriptionDocumentId: subscription.id,
        providerSubscriptionId: notification.subscriptionId,
        changeType: notification.changeType || null,
        lifecycleEvent: notification.lifecycleEvent || null,
        resource: notification.resource || null,
        resourceData: notification.resourceData || null,
        status: "queued",
        attempts: 0,
        createdAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * 24 * 60 * 60 * 1_000),
      });
      if (["subscriptionRemoved", "reauthorizationRequired"].includes(String(notification.lifecycleEvent))) {
        transaction.set(subscription.ref, {
          status: "removed",
          lifecycleEvent: notification.lifecycleEvent,
          updatedAt: now,
        }, { merge: true });
      }
      return true;
    });
    if (wasCreated) queued += 1;
    else duplicate += 1;
  }
  return { queued, duplicate, ignored };
}

export async function processMicrosoftGraphNotification(input: OutlookSyncInput & {
  notificationId: string;
}): Promise<void> {
  const database = input.database || db;
  const ref = database.collection(notificationCollection).doc(input.notificationId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data()?.status === "processed") return;
  const data = snapshot.data() || {};
  await ref.set({ status: "processing", attempts: Number(data.attempts || 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  try {
    const result = await syncMicrosoftOutlookConnection({
      ...input,
      companyId: String(data.companyId),
      connectionId: String(data.connectionId),
      trigger: "webhook",
      requestedBy: "webhook:microsoft-graph",
    });
    await ref.set({ status: "processed", syncRunId: result.runId, processedAt: Timestamp.now(), lastError: null }, { merge: true });
  } catch (error) {
    await ref.set({ status: "failed", lastError: error instanceof Error ? error.message : String(error), updatedAt: Timestamp.now() }, { merge: true });
    throw error;
  }
}
