import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import {
  CodingRunError,
  eventDocumentId,
  safeCodingError,
  statusIsTerminal,
} from "./repository.js";
import type { CodingCallbackEvent, CodingRunStatus } from "./types.js";

const runPattern = /^coding_[a-f0-9]{32}$/;
const eventPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const allowedStatuses: CodingRunStatus[] = [
  "packaging",
  "provisioning",
  "running",
  "ready_to_publish",
  "publishing",
  "succeeded",
  "no_changes",
  "outcome_unknown",
  "failed",
  "cancelled",
];

export class CodingCallbackError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function boundedNumber(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.floor(value)
    : undefined;
}

function safeSha(value: unknown): string | undefined {
  const text = String(value || "").toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(text) ? text : undefined;
}

function safePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((entry) => {
    const path = String(entry);
    return path.length <= 500 && !/[\r\n\0]/.test(path) ? [path] : [];
  });
}

export function validateCodingCallback(value: unknown): CodingCallbackEvent {
  const event = value as Record<string, unknown> | null;
  if (!event || typeof event !== "object") throw new CodingCallbackError("Invalid callback body");
  if (!runPattern.test(String(event.runId || ""))) throw new CodingCallbackError("Invalid run ID");
  if (!eventPattern.test(String(event.eventId || ""))) throw new CodingCallbackError("Invalid event ID");
  if (!["phase", "completed", "failed"].includes(String(event.type || ""))) {
    throw new CodingCallbackError("Invalid callback type");
  }
  if (!allowedStatuses.includes(event.status as CodingRunStatus)) {
    throw new CodingCallbackError("Invalid callback status");
  }
  if (typeof event.phase !== "string" || event.phase.length < 1 || event.phase.length > 100) {
    throw new CodingCallbackError("Invalid callback phase");
  }
  if (typeof event.message !== "string" || event.message.length > 1_000) {
    throw new CodingCallbackError("Invalid callback message");
  }
  if (event.executionName !== undefined && (
    typeof event.executionName !== "string" || event.executionName.length > 500
  )) throw new CodingCallbackError("Invalid execution name");
  return event as unknown as CodingCallbackEvent;
}

export async function processCodingCallback(input: {
  body: unknown;
  principalEmail: string;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<{ companyId: string; runId: string; shouldPublish: boolean }> {
  const event = validateCodingCallback(input.body);
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const routeRef = database.doc(`codingRunRoutes/${event.runId}`);
  const route = await routeRef.get();
  if (!route.exists) throw new CodingCallbackError("Coding run route not found", 404);
  const companyId = String(route.data()?.companyId || "");
  const runRef = database.doc(`companies/${companyId}/codingRuns/${event.runId}`);
  const callbackRef = runRef.collection("callbackEvents")
    .doc(eventDocumentId(input.principalEmail, event.eventId));
  const eventRef = runRef.collection("events")
    .doc(eventDocumentId(input.principalEmail, event.eventId));

  let shouldPublish = false;
  await database.runTransaction(async (transaction) => {
    const [run, priorCallback] = await Promise.all([
      transaction.get(runRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
      transaction.get(callbackRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
    ]);
    if (!run.exists) throw new CodingCallbackError("Coding run not found", 404);
    if (priorCallback.exists) return;
    const currentStatus = run.data()?.status;
    let nextStatus = event.status;
    let nextPhase = event.phase;
    if (
      input.principalEmail.includes("runner")
      && !["running", "ready_to_publish", "failed"].includes(nextStatus)
    ) throw new CodingCallbackError("Runner cannot report this coding status", 403);
    if (event.type === "completed" && nextStatus === "ready_to_publish") {
      nextStatus = boundedNumber(event.result?.changedFiles, 5_000) === 0
        ? "no_changes"
        : "ready_to_publish";
      nextPhase = nextStatus === "no_changes" ? "no_changes" : "ready_to_publish";
      shouldPublish = nextStatus === "ready_to_publish";
    }
    if (currentStatus === "cancel_requested") {
      shouldPublish = false;
      nextStatus = event.type === "phase" ? "cancel_requested" : "cancelled";
      nextPhase = event.type === "phase" ? "cancel_requested" : "cancelled";
    } else if (statusIsTerminal(currentStatus)) {
      shouldPublish = false;
      transaction.create(callbackRef, {
        eventId: event.eventId,
        principalEmail: input.principalEmail,
        ignored: true,
        createdAt: now,
      });
      return;
    }
    const result = event.result || {};
    const baseSha = safeSha(result.baseSha);
    const resultSha = safeSha(result.resultSha);
    const changedPaths = safePaths(result.changedPaths);
    const currentGit = run.data()?.git || {};
    if (event.type === "completed" && input.principalEmail.includes("runner")) {
      if (
        !baseSha
        || !resultSha
        || baseSha !== String(currentGit.baseSha || "")
        || (
          boundedNumber(result.changedFiles, 5_000) !== 0
          && (
            !/^[a-f0-9]{64}$/.test(String(result.resultBundleSha256 || ""))
            || !boundedNumber(result.resultBundleBytes, 500 * 1024 * 1024)
          )
        )
      ) throw new CodingCallbackError("Runner completion does not match the approved run");
    }
    if (nextStatus === "succeeded") {
      const authorization = run.data()?.authorization || {};
      if (
        !baseSha
        || !resultSha
        || baseSha !== String(currentGit.baseSha || "")
        || resultSha !== String(currentGit.resultSha || "")
        || String(result.branch || "") !== String(currentGit.proposedBranch || "")
        || String(result.approvalId || "") !== String(authorization.approvalId || "")
        || String(result.effectDigest || "") !== String(authorization.effectDigest || "")
      ) throw new CodingCallbackError("Publisher completion does not match the approved run");
    }
    const terminal = [
      "succeeded", "no_changes", "outcome_unknown", "failed", "cancelled",
    ].includes(nextStatus);
    const update: Record<string, unknown> = {
      status: nextStatus,
      phase: nextPhase,
      updatedAt: now,
      ...(terminal ? { completedAt: now } : {}),
      ...(event.executionName
        ? {
            cloudRun: input.principalEmail.includes("dispatcher") && [
              "publishing", "succeeded", "outcome_unknown",
            ].includes(nextStatus)
              ? { publisherExecutionName: event.executionName }
              : { runnerExecutionName: event.executionName },
          }
        : {}),
    };
    if (baseSha || resultSha) {
      update.git = {
        ...(baseSha ? { baseSha } : {}),
        ...(resultSha ? { resultSha } : {}),
      };
    }
    if (changedPaths.length || result.changedFiles === 0) {
      update.result = {
        changedPaths,
        changedFiles: boundedNumber(result.changedFiles, 5_000) || 0,
        patchBytes: boundedNumber(result.patchBytes, 100 * 1024 * 1024) || 0,
        artifactBytes: boundedNumber(result.artifactBytes, 500 * 1024 * 1024) || 0,
        durationMs: boundedNumber(result.durationMs, 24 * 60 * 60 * 1000) || 0,
        outputTruncated: result.outputTruncated === true,
        authKind: result.authKind === "subscription_oauth" ? "subscription_oauth" : undefined,
        resultBundleSha256: safeSha(result.resultBundleSha256),
        resultBundleBytes: boundedNumber(result.resultBundleBytes, 500 * 1024 * 1024) || 0,
      };
    }
    if (nextStatus === "succeeded") {
      const pullRequestNumber = boundedNumber(result.pullRequestNumber, 2_147_483_647);
      const pullRequestUrl = String(result.pullRequestUrl || "");
      const branch = String(result.branch || "");
      if (
        !pullRequestNumber
        || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(pullRequestUrl)
        || !/^erik\/[A-Za-z0-9._/-]+$/.test(branch)
      ) throw new CodingCallbackError("Publisher completion result is invalid");
      update.publicationResult = {
        pullRequestNumber,
        pullRequestUrl,
        branch,
        draft: result.draft === true,
      };
    }
    if (nextStatus === "failed") {
      update.error = {
        code: "coding_execution_failed",
        message: safeCodingError(event.message),
        phase: nextPhase,
      };
    }
    transaction.create(callbackRef, {
      eventId: event.eventId,
      principalEmail: input.principalEmail,
      createdAt: now,
    });
    transaction.create(eventRef, {
      status: nextStatus,
      phase: nextPhase,
      message: safeCodingError(event.message),
      source: input.principalEmail.includes("dispatcher") ? "dispatcher" : "runner",
      createdAt: now,
    });
    transaction.set(runRef, update, { merge: true });
    if (nextStatus === "ready_to_publish" || nextStatus === "no_changes") {
      transaction.set(
        database.doc(`companies/${companyId}/connections/grok_subscription`),
        {
          subscription: { lastSuccessfulRunAt: now },
          stats: { lastError: null },
          updatedAt: now,
        },
        { merge: true },
      );
    } else if (
      nextStatus === "failed"
      && /(?:grok|oauth|auth(?:entication)?|credential|subscription)/i.test(event.message)
    ) {
      const message = "The Grok subscription needs administrator attention";
      transaction.set(
        database.doc(`companies/${companyId}/connections/grok_subscription`),
        {
          status: "attention",
          subscription: { state: "attention", lastError: message },
          stats: { lastError: message },
          updatedAt: now,
        },
        { merge: true },
      );
    }
  });
  return { companyId, runId: event.runId, shouldPublish };
}

export function requireKnownCodingPrincipal(email: string, projectId: string): void {
  const allowed = new Set([
    `erik-coding-dispatcher@${projectId}.iam.gserviceaccount.com`,
    `erik-coding-runner@${projectId}.iam.gserviceaccount.com`,
  ]);
  if (!allowed.has(email)) throw new CodingCallbackError("Invalid coding worker identity", 403);
}

export function codingCallbackStatus(error: unknown): number {
  if (error instanceof CodingCallbackError) return error.statusCode;
  if (error instanceof CodingRunError) return error.statusCode;
  return 500;
}
