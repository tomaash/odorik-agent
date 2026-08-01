import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";
import { db, jsonSafe } from "../firestore.js";

export const grokSubscriptionConnectionId = "grok_subscription";
export const grokSubscriptionSecretName = "grok-subscription-auth";

export type GrokAuthorizationAction = "connect" | "disconnect";
export type GrokAuthorizationStatus =
  | "starting"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export type GrokAuthorizationPublicView = {
  sessionId: string;
  action: GrokAuthorizationAction;
  status: GrokAuthorizationStatus;
  verificationUri: string | null;
  userCode: string | null;
  accountLabel: string | null;
  error: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
};

export type GrokAuthJobExecutor = (input: {
  action: GrokAuthorizationAction;
  sessionId: string;
  secretName: string;
}) => Promise<{ operationName: string }>;

export class GrokAuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d";
const authRegion = process.env.GROK_AUTH_REGION?.trim() || "europe-west1";
const authJob = process.env.GROK_AUTH_JOB?.trim() || "erik-grok-auth";
const authCallbackUrl = process.env.GROK_AUTH_CALLBACK_URL?.trim()
  || "https://agent-erik-app.web.app/callbacks/grok-auth";
const sessionTtlMs = 20 * 60 * 1000;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const activeSessionStatuses: GrokAuthorizationStatus[] = ["starting", "waiting_for_user"];
const sessionPattern = /^grok_[a-f0-9]{32}$/;
const deviceCodePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "[device-code]")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[path]")
    .slice(0, 500);
}

function asIso(value: unknown): string | null {
  const safe = jsonSafe(value);
  return typeof safe === "string" ? safe : null;
}

function authorizationView(
  sessionId: string,
  value: Record<string, unknown>,
): GrokAuthorizationPublicView {
  return {
    sessionId,
    action: value.action === "disconnect" ? "disconnect" : "connect",
    status: value.status as GrokAuthorizationStatus,
    verificationUri: typeof value.verificationUri === "string" ? value.verificationUri : null,
    userCode: typeof value.userCode === "string" ? value.userCode : null,
    accountLabel: typeof value.accountLabel === "string" ? value.accountLabel : null,
    error: typeof value.error === "string" ? value.error : null,
    expiresAt: asIso(value.expiresAt),
    updatedAt: asIso(value.updatedAt),
  };
}

function routePath(sessionId: string): string {
  return `grokAuthSessionRoutes/${sessionId}`;
}

function sessionPath(companyId: string, sessionId: string): string {
  return `companies/${companyId}/grokAuthSessions/${sessionId}`;
}

function connectionPath(companyId: string): string {
  return `companies/${companyId}/connections/${grokSubscriptionConnectionId}`;
}

export function createCloudRunGrokAuthJobExecutor(): GrokAuthJobExecutor {
  const authentication = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return async (input) => {
    const client = await authentication.getClient();
    const response = await client.request<{ name?: string }>({
      url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${authRegion}/jobs/${authJob}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [{
            name: "grok-auth-worker",
            env: [
              { name: "GCP_PROJECT_ID", value: projectId },
              { name: "GROK_AUTH_ACTION", value: input.action },
              { name: "GROK_AUTH_SESSION_ID", value: input.sessionId },
              { name: "GROK_AUTH_SECRET_NAME", value: input.secretName },
              { name: "GROK_AUTH_CALLBACK_URL", value: authCallbackUrl },
            ],
          }],
          taskCount: 1,
          timeout: "1200s",
        },
      },
    });
    const operationName = response.data.name;
    if (!operationName) throw new Error("Cloud Run did not return an auth operation name");
    return { operationName };
  };
}

export async function startGrokAuthorization(input: {
  companyId: string;
  actorUid: string;
  action: GrokAuthorizationAction;
  executeJob: GrokAuthJobExecutor;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<GrokAuthorizationPublicView> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const sessionId = `grok_${randomBytes(16).toString("hex")}`;
  const expiresAt = Timestamp.fromMillis(now.toMillis() + sessionTtlMs);
  const retainUntil = Timestamp.fromMillis(now.toMillis() + retentionMs);
  const connectionRef = database.doc(connectionPath(input.companyId));
  const sessionRef = database.doc(sessionPath(input.companyId, sessionId));
  const routeRef = database.doc(routePath(sessionId));
  const ownerRef = database.doc(`grokSubscriptionSecrets/${grokSubscriptionSecretName}`);

  await database.runTransaction(async (transaction) => {
    const [connection, owner] = await Promise.all([
      transaction.get(connectionRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
      transaction.get(ownerRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
    ]);
    if (
      owner.exists
      && (
        owner.data()?.companyId !== input.companyId
        || owner.data()?.connectionId !== grokSubscriptionConnectionId
      )
    ) {
      throw new GrokAuthorizationError(
        "The configured Grok subscription is already assigned to another company",
        409,
      );
    }
    if (input.action === "disconnect" && !connection.exists) {
      throw new GrokAuthorizationError("Grok subscription connection not found", 404);
    }
    const currentSessionId = String(connection.data()?.subscription?.currentAuthSessionId || "");
    if (currentSessionId && sessionPattern.test(currentSessionId)) {
      const current = await transaction.get(
        database.doc(sessionPath(input.companyId, currentSessionId)),
      ) as FirebaseFirestore.DocumentSnapshot;
      if (
        current.exists
        && activeSessionStatuses.includes(current.data()?.status)
        && current.data()?.expiresAt instanceof Timestamp
        && current.data()!.expiresAt.toMillis() > now.toMillis()
      ) {
        throw new GrokAuthorizationError("A Grok authorization is already in progress", 409);
      }
    }
    const previousStatus = connection.exists
      ? String(connection.data()?.status || "attention")
      : "disconnected";
    transaction.set(ownerRef, {
      secretName: grokSubscriptionSecretName,
      companyId: input.companyId,
      connectionId: grokSubscriptionConnectionId,
      createdAt: owner.data()?.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(connectionRef, {
      companyId: input.companyId,
      connectorId: "grok_subscription",
      providerId: "grok",
      displayName: "Grok subscription",
      status: input.action === "connect" && previousStatus !== "active"
        ? "configuring"
        : previousStatus,
      auth: {
        kind: "subscription_oauth",
        credentialMode: "managed_secret",
        scopes: [],
      },
      credentialRef: {
        provider: "secret_manager",
        secretName: grokSubscriptionSecretName,
      },
      subscription: {
        state: input.action === "connect" ? "connecting" : "disconnecting",
        currentAuthSessionId: sessionId,
        lastError: null,
      },
      stats: {
        ...(connection.data()?.stats || {}),
        lastError: null,
      },
      createdBy: connection.data()?.createdBy || input.actorUid,
      createdAt: connection.data()?.createdAt || now,
      updatedBy: input.actorUid,
      updatedAt: now,
    }, { merge: true });
    transaction.create(sessionRef, {
      sessionId,
      companyId: input.companyId,
      connectionId: grokSubscriptionConnectionId,
      action: input.action,
      status: "starting",
      previousStatus,
      secretName: grokSubscriptionSecretName,
      verificationUri: null,
      userCode: null,
      accountLabel: null,
      error: null,
      createdBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      retainUntil,
    });
    transaction.create(routeRef, {
      sessionId,
      companyId: input.companyId,
      connectionId: grokSubscriptionConnectionId,
      action: input.action,
      secretName: grokSubscriptionSecretName,
      createdAt: now,
      expiresAt: retainUntil,
    });
    transaction.set(
      database.doc(`companies/${input.companyId}/auditEvents/grok_auth_started_${sessionId}`),
      {
        eventType: "source.grok_authorization_started",
        actorUid: input.actorUid,
        connectorId: "grok_subscription",
        connectionId: grokSubscriptionConnectionId,
        authSessionId: sessionId,
        action: input.action,
        occurredAt: now,
        createdAt: now,
      },
    );
  });

  try {
    const execution = await input.executeJob({
      action: input.action,
      sessionId,
      secretName: grokSubscriptionSecretName,
    });
    await sessionRef.set({
      operationName: execution.operationName,
      updatedAt: Timestamp.now(),
    }, { merge: true });
  } catch (error) {
    const message = safeError(error);
    await Promise.all([
      sessionRef.set({ status: "failed", error: message, updatedAt: Timestamp.now() }, { merge: true }),
      connectionRef.set({
        status: "attention",
        subscription: { state: "attention", lastError: message },
        stats: { lastError: message },
        updatedAt: Timestamp.now(),
      }, { merge: true }),
    ]);
    throw error;
  }
  return authorizationView(sessionId, (await sessionRef.get()).data() || {});
}

export async function getGrokAuthorization(input: {
  companyId: string;
  sessionId: string;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<GrokAuthorizationPublicView> {
  if (!sessionPattern.test(input.sessionId)) {
    throw new GrokAuthorizationError("Invalid Grok authorization session", 400);
  }
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const sessionRef = database.doc(sessionPath(input.companyId, input.sessionId));
  const snapshot = await sessionRef.get();
  if (!snapshot.exists) throw new GrokAuthorizationError("Grok authorization not found", 404);
  const value = snapshot.data() || {};
  if (
    activeSessionStatuses.includes(value.status)
    && value.expiresAt instanceof Timestamp
    && value.expiresAt.toMillis() <= now.toMillis()
  ) {
    const message = "Grok device authorization expired";
    await Promise.all([
      sessionRef.set({ status: "expired", error: message, updatedAt: now }, { merge: true }),
      database.doc(connectionPath(input.companyId)).set({
        status: value.previousStatus === "active" ? "active" : "attention",
        subscription: { state: "attention", lastError: message },
        stats: { lastError: message },
        updatedAt: now,
      }, { merge: true }),
    ]);
    return authorizationView(input.sessionId, {
      ...value,
      status: "expired",
      error: message,
      updatedAt: now,
    });
  }
  return authorizationView(input.sessionId, value);
}

type CallbackEvent = {
  type: "device" | "completed" | "failed";
  sessionId: string;
  action?: GrokAuthorizationAction;
  verificationUri?: string;
  userCode?: string;
  secretVersion?: string;
  accountLabel?: string;
  principalId?: string;
  teamId?: string | null;
  expiresAt?: string | null;
  error?: string;
};

function validateCallbackEvent(value: unknown): CallbackEvent {
  const event = value as Record<string, unknown> | null;
  if (!event || typeof event !== "object") {
    throw new GrokAuthorizationError("Invalid Grok auth callback body", 400);
  }
  if (!sessionPattern.test(String(event.sessionId || ""))) {
    throw new GrokAuthorizationError("Invalid Grok auth callback session", 400);
  }
  if (!["device", "completed", "failed"].includes(String(event.type || ""))) {
    throw new GrokAuthorizationError("Invalid Grok auth callback event", 400);
  }
  return event as CallbackEvent;
}

function validateDevice(event: CallbackEvent): void {
  if (!event.userCode || !deviceCodePattern.test(event.userCode)) {
    throw new GrokAuthorizationError("Invalid Grok device code", 400);
  }
  let verification: URL;
  try {
    verification = new URL(event.verificationUri || "");
  } catch {
    throw new GrokAuthorizationError("Invalid Grok verification URL", 400);
  }
  if (
    verification.protocol !== "https:"
    || verification.hostname !== "accounts.x.ai"
    || verification.pathname !== "/oauth2/device"
    || verification.searchParams.get("user_code") !== event.userCode
  ) {
    throw new GrokAuthorizationError("Untrusted Grok verification URL", 400);
  }
}

export async function processGrokAuthCallback(input: {
  body: unknown;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<void> {
  const event = validateCallbackEvent(input.body);
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const route = await database.doc(routePath(event.sessionId)).get();
  if (!route.exists) throw new GrokAuthorizationError("Grok auth route not found", 404);
  const companyId = String(route.data()?.companyId || "");
  const connectionId = String(route.data()?.connectionId || "");
  const action = route.data()?.action as GrokAuthorizationAction;
  const secretName = String(route.data()?.secretName || "");
  if (!companyId || connectionId !== grokSubscriptionConnectionId || !action || !secretName) {
    throw new GrokAuthorizationError("Grok auth route is incomplete", 409);
  }
  const sessionRef = database.doc(sessionPath(companyId, event.sessionId));
  const connectionRef = database.doc(connectionPath(companyId));
  await database.runTransaction(async (transaction) => {
    const [session, connection] = await Promise.all([
      transaction.get(sessionRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
      transaction.get(connectionRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
    ]);
    if (
      !session.exists
      || !connection.exists
      || session.data()?.action !== action
      || session.data()?.secretName !== secretName
      || connection.data()?.connectorId !== "grok_subscription"
    ) {
      throw new GrokAuthorizationError("Grok auth tenant route check failed", 409);
    }
    if (["completed", "failed", "expired", "cancelled"].includes(session.data()?.status)) return;
    if (session.data()?.expiresAt instanceof Timestamp && session.data()!.expiresAt.toMillis() <= now.toMillis()) {
      throw new GrokAuthorizationError("Grok auth callback expired", 410);
    }
    if (event.type === "device") {
      if (action !== "connect") throw new GrokAuthorizationError("Unexpected device callback", 409);
      validateDevice(event);
      transaction.set(sessionRef, {
        status: "waiting_for_user",
        verificationUri: event.verificationUri,
        userCode: event.userCode,
        updatedAt: now,
      }, { merge: true });
      transaction.set(connectionRef, {
        subscription: { state: "waiting_for_user", lastError: null },
        updatedAt: now,
      }, { merge: true });
    } else if (event.type === "failed") {
      const message = safeError(event.error || "Grok authorization failed");
      transaction.set(sessionRef, {
        status: "failed",
        error: message,
        updatedAt: now,
      }, { merge: true });
      transaction.set(connectionRef, {
        status: session.data()?.previousStatus === "active" ? "active" : "attention",
        subscription: { state: "attention", lastError: message },
        stats: { lastError: message },
        updatedAt: now,
      }, { merge: true });
    } else if (action === "connect") {
      if (event.action !== "connect") throw new GrokAuthorizationError("Grok auth action mismatch", 409);
      const expectedVersionPrefix = `projects/${projectId}/secrets/${secretName}/versions/`;
      if (
        !event.secretVersion?.startsWith(expectedVersionPrefix)
        || !/^\d+$/.test(event.secretVersion.slice(expectedVersionPrefix.length))
        || typeof event.accountLabel !== "string"
        || event.accountLabel.length > 320
        || typeof event.principalId !== "string"
        || event.principalId.length > 500
      ) {
        throw new GrokAuthorizationError("Grok completion metadata is invalid", 400);
      }
      transaction.set(sessionRef, {
        status: "completed",
        accountLabel: event.accountLabel,
        userCode: FieldValue.delete(),
        verificationUri: FieldValue.delete(),
        error: null,
        completedAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.set(connectionRef, {
        providerAccountId: event.principalId,
        accountLabel: event.accountLabel,
        status: "active",
        credentialRef: { secretName, version: event.secretVersion },
        subscription: {
          state: "active",
          currentAuthSessionId: event.sessionId,
          teamId: event.teamId || null,
          lastAuthenticatedAt: now,
          sessionExpiresAt: event.expiresAt || null,
          lastError: null,
        },
        stats: { lastError: null },
        updatedAt: now,
      }, { merge: true });
    } else {
      if (event.action !== "disconnect") {
        throw new GrokAuthorizationError("Grok disconnect action mismatch", 409);
      }
      transaction.set(sessionRef, {
        status: "completed",
        error: null,
        completedAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.set(connectionRef, {
        status: "disconnected",
        credentialRef: { version: null },
        subscription: {
          state: "disconnected",
          currentAuthSessionId: event.sessionId,
          sessionExpiresAt: null,
          lastDisconnectedAt: now,
          lastError: null,
        },
        stats: { lastError: null },
        updatedAt: now,
      }, { merge: true });
    }
    transaction.set(
      database.doc(`companies/${companyId}/auditEvents/grok_auth_${event.type}_${event.sessionId}`),
      {
        eventType: `source.grok_authorization_${event.type}`,
        actorUid: "grok-auth-worker",
        connectorId: "grok_subscription",
        connectionId,
        authSessionId: event.sessionId,
        action,
        occurredAt: now,
        createdAt: now,
      },
      { merge: false },
    );
  });
}
