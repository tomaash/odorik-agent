import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { eventDocumentId, safeCodingError, statusIsTerminal } from "./repository.js";

const runPattern = /^coding_[a-f0-9]{32}$/;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d";
const secretName = "grok-subscription-auth";

type CodingAuthRefreshEvent = {
  type: "completed" | "failed";
  action: "refresh";
  runId: string;
  secretVersion?: string;
  expiresAt?: string | null;
  refreshed?: boolean;
  error?: string;
};

export class CodingAuthRefreshError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function validateEvent(value: unknown): CodingAuthRefreshEvent {
  const event = value as Record<string, unknown> | null;
  if (!event || typeof event !== "object") {
    throw new CodingAuthRefreshError("Invalid coding auth callback body");
  }
  if (event.action !== "refresh" || !["completed", "failed"].includes(String(event.type))) {
    throw new CodingAuthRefreshError("Invalid coding auth callback event");
  }
  if (!runPattern.test(String(event.runId || ""))) {
    throw new CodingAuthRefreshError("Invalid coding auth run ID");
  }
  if (event.type === "completed") {
    const prefix = `projects/${projectId}/secrets/${secretName}/versions/`;
    if (
      typeof event.secretVersion !== "string"
      || !event.secretVersion.startsWith(prefix)
      || !/^\d+$/.test(event.secretVersion.slice(prefix.length))
      || (event.expiresAt !== null && event.expiresAt !== undefined && (
        typeof event.expiresAt !== "string" || Number.isNaN(Date.parse(event.expiresAt))
      ))
    ) throw new CodingAuthRefreshError("Invalid refreshed Grok credential metadata");
  } else if (typeof event.error !== "string" || event.error.length > 500) {
    throw new CodingAuthRefreshError("Invalid coding auth failure");
  }
  return event as CodingAuthRefreshEvent;
}

export async function processCodingAuthRefreshCallback(input: {
  body: unknown;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<{ companyId: string; runId: string; shouldDispatch: boolean }> {
  const event = validateEvent(input.body);
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const route = await database.doc(`codingRunRoutes/${event.runId}`).get();
  if (!route.exists) throw new CodingAuthRefreshError("Coding run route not found", 404);
  const companyId = String(route.data()?.companyId || "");
  const runRef = database.doc(`companies/${companyId}/codingRuns/${event.runId}`);
  const callbackId = eventDocumentId("grok-auth-worker", `auth-refresh-${event.type}`);
  const callbackRef = runRef.collection("callbackEvents").doc(callbackId);
  const eventRef = runRef.collection("events").doc(callbackId);
  let shouldDispatch = false;
  await database.runTransaction(async (transaction) => {
    const [run, prior] = await Promise.all([
      transaction.get(runRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
      transaction.get(callbackRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
    ]);
    if (!run.exists) throw new CodingAuthRefreshError("Coding run not found", 404);
    const currentStatus = String(run.data()?.status || "");
    const currentPhase = String(run.data()?.phase || "");
    if (prior.exists) {
      shouldDispatch = event.type === "completed" && (
        (currentStatus === "queued" && currentPhase === "auth_refresh_completed")
        || (currentStatus === "failed" && currentPhase === "dispatch_failed")
      );
      return;
    }
    if (statusIsTerminal(currentStatus)) return;
    if (currentStatus !== "cancel_requested" && (
      currentStatus !== "queued" || currentPhase !== "auth_refresh_queued"
    )) throw new CodingAuthRefreshError("Coding auth callback is out of sequence", 409);
    const connectionId = String(run.data()?.grok?.connectionId || "");
    const connectionRef = connectionId
      ? database.doc(`companies/${companyId}/connections/${connectionId}`)
      : null;
    const connection = connectionRef
      ? await transaction.get(connectionRef) as FirebaseFirestore.DocumentSnapshot
      : null;
    const connectionData = connection?.data() || {};
    const connectionActive = connection?.exists === true
      && connectionData.connectorId === "grok_subscription"
      && connectionData.status === "active"
      && connectionData.subscription?.state === "active";

    let nextStatus = "queued";
    let nextPhase = "auth_refresh_completed";
    let message = "Rotating Grok OAuth credential is current";
    const values: Record<string, unknown> = {};
    if (currentStatus === "cancel_requested") {
      nextStatus = "cancelled";
      nextPhase = "cancelled";
      message = "Coding run cancelled during OAuth preflight";
      values.completedAt = now;
    } else if (event.type === "failed" || !connectionActive) {
      const connectionInactive = event.type === "completed" && !connectionActive;
      const error = safeCodingError(event.error || "Grok OAuth refresh failed");
      nextStatus = "failed";
      nextPhase = "auth_refresh_failed";
      message = connectionInactive
        ? "The Grok subscription was disconnected during OAuth preflight"
        : error;
      values.error = {
        code: connectionInactive ? "grok_connection_inactive" : "grok_auth_refresh_failed",
        message,
        phase: "authentication",
      };
      values.completedAt = now;
    } else {
      shouldDispatch = true;
      values.error = null;
      values.grokCredential = {
        secretVersion: event.secretVersion,
        expiresAt: event.expiresAt || null,
        refreshed: event.refreshed === true,
        preparedAt: now,
      };
    }
    transaction.set(runRef, {
      status: nextStatus,
      phase: nextPhase,
      ...values,
      updatedAt: now,
    }, { merge: true });
    transaction.create(callbackRef, {
      type: event.type,
      phase: nextPhase,
      status: nextStatus,
      createdAt: now,
    });
    transaction.set(eventRef, {
      phase: nextPhase,
      status: nextStatus,
      message,
      actorUid: "grok-auth-worker",
      createdAt: now,
    });
    if (connectionRef && connectionActive) {
      if (event.type === "failed") {
        transaction.set(connectionRef, {
          status: "attention",
          subscription: {
            ...(connectionData.subscription || {}),
            state: "attention",
            lastError: safeCodingError(event.error || "Grok OAuth refresh failed"),
          },
          stats: {
            ...(connectionData.stats || {}),
            lastError: safeCodingError(event.error || "Grok OAuth refresh failed"),
          },
          updatedAt: now,
        }, { merge: true });
      } else if (event.type === "completed") {
        transaction.set(connectionRef, {
          status: "active",
          credentialRef: { secretName, version: event.secretVersion },
          subscription: {
            ...(connectionData.subscription || {}),
            state: "active",
            sessionExpiresAt: event.expiresAt || null,
            lastRefreshedAt: now,
            lastError: null,
          },
          stats: { ...(connectionData.stats || {}), lastError: null },
          updatedAt: now,
        }, { merge: true });
      }
    }
    transaction.set(database.doc(
      `companies/${companyId}/auditEvents/coding_${event.runId}_auth_refresh_${event.type}`,
    ), {
      eventType: `coding.auth_refresh_${event.type}`,
      codingRunId: event.runId,
      actorUid: "grok-auth-worker",
      occurredAt: now,
      createdAt: now,
    });
    if (event.type === "completed") {
      transaction.set(runRef, {
        cancellationError: FieldValue.delete(),
      }, { merge: true });
    }
  });
  return { companyId, runId: event.runId, shouldDispatch };
}
