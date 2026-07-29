import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import {
  crmModel,
  extractIntake,
  intakePromptVersion,
  intakeSchemaVersion,
} from "./extract.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";

type CallDocument = {
  status?: string;
  transcript?: string;
  summary?: string;
  language?: string;
  segments?: Array<{
    speaker?: string;
    text?: string;
    startSeconds?: number;
    endSeconds?: number;
  }>;
  from?: string | null;
  to?: string | null;
  duration?: number | null;
  odorikTime?: string | null;
  lineName?: string | null;
  objectName?: string;
  mimeType?: string;
  uploadedAt?: Timestamp;
};

const processingLeaseMs = 15 * 60 * 1000;

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") return Number(toMillis.call(value));
  }
  return null;
}

export function shouldProcessCallUpdate(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  if (!after || after.status !== "completed") return false;
  if (before?.status !== "completed") return true;
  const beforeBackfill = timestampMillis(before.crmBackfillRequestedAt);
  const afterBackfill = timestampMillis(after.crmBackfillRequestedAt);
  return afterBackfill !== null && afterBackfill !== beforeBackfill;
}

export function canStartProcessingRun(
  existing: Record<string, unknown> | undefined,
  nowMs = Date.now(),
): boolean {
  if (!existing) return true;
  if (existing.status === "completed") return false;
  if (existing.status !== "running") return true;
  const updatedAt = timestampMillis(existing.updatedAt);
  return updatedAt !== null && updatedAt < nowMs - processingLeaseMs;
}


export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`;
  if (digits.startsWith("00") && digits.length >= 10) return `+${digits.slice(2)}`;
  if (digits.length === 9) return `+420${digits}`;
  return `+${digits}`;
}

export async function processCompletedCall(input: {
  companyId: string;
  callId: string;
  apiKey: string;
}): Promise<{ interactionId: string; requestId: string; runId: string; duplicate: boolean }> {
  const callRef = db.doc(companyDocumentPath(input.companyId, "calls", input.callId));
  const callSnapshot = await callRef.get();
  if (!callSnapshot.exists) throw new Error(`Call ${input.callId} does not exist`);
  const call = callSnapshot.data() as CallDocument;
  if (call.status !== "completed" || !call.transcript) {
    throw new Error(`Call ${input.callId} is not ready for CRM processing`);
  }

  const interactionId = `odorik_${input.callId}`;
  const requestId = `request_${sha256Hex(interactionId).slice(0, 24)}`;
  const taskId = `review_${sha256Hex(interactionId).slice(0, 24)}`;
  const inputDigest = sha256Hex(JSON.stringify({
    transcript: call.transcript,
    segments: call.segments || [],
    from: call.from || null,
    to: call.to || null,
  }));
  const runId = `${sha256Hex(`${interactionId}:${intakePromptVersion}:${inputDigest}`).slice(0, 32)}`;
  const runRef = db.doc(companyDocumentPath(input.companyId, "processingRuns", runId));

  const shouldProcess = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(runRef);
    if (!canStartProcessingRun(existing.exists ? existing.data() : undefined)) return false;
    transaction.set(runRef, {
      kind: "intake_extraction",
      companyId: input.companyId,
      interactionId,
      sourceCallId: input.callId,
      requestId,
      promptVersion: intakePromptVersion,
      schemaVersion: intakeSchemaVersion,
      model: crmModel,
      inputDigest,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      error: FieldValue.delete(),
    }, { merge: true });
    transaction.set(callRef, {
      crmStatus: "processing",
      crmProcessingRunId: runId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });

  if (!shouldProcess) return { interactionId, requestId, runId, duplicate: true };

  try {
    const extraction = await extractIntake({
      transcript: call.transcript,
      segments: call.segments || [],
      from: call.from,
      to: call.to,
      apiKey: input.apiKey,
    });
    const normalizedPhone = normalizePhone(call.from);
    const contactId = normalizedPhone
      ? `phone_${sha256Hex(normalizedPhone).slice(0, 24)}`
      : `interaction_${sha256Hex(interactionId).slice(0, 24)}`;
    const now = Timestamp.now();
    const evidenceExpiresAt = Timestamp.fromMillis(now.toMillis() + 90 * 24 * 60 * 60 * 1000);
    const interactionRef = db.doc(
      companyDocumentPath(input.companyId, "interactions", interactionId),
    );
    const contactRef = db.doc(companyDocumentPath(input.companyId, "contacts", contactId));
    const requestRef = db.doc(
      companyDocumentPath(input.companyId, "serviceRequests", requestId),
    );
    const taskRef = db.doc(companyDocumentPath(input.companyId, "tasks", taskId));
    const eventRef = db.collection(
      companyCollectionPath(input.companyId, "auditEvents"),
    ).doc();

    await db.runTransaction(async (transaction) => {
      const [requestSnapshot, contactSnapshot] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(contactRef),
      ]);
      transaction.set(contactRef, {
        companyId: input.companyId,
        phoneE164: normalizedPhone,
        phoneRaw: call.from || null,
        ...(contactSnapshot.exists ? {} : {
          createdFromInteractionId: interactionId,
          createdAt: now,
        }),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(interactionRef, {
        companyId: input.companyId,
        kind: "phone_call",
        source: "odorik",
        sourceCallId: input.callId,
        contactId,
        serviceRequestId: requestId,
        from: call.from || null,
        to: call.to || null,
        occurredAt: call.odorikTime || call.uploadedAt || null,
        durationSeconds: call.duration || null,
        transcript: call.transcript,
        segments: call.segments || [],
        summary: call.summary || null,
        language: call.language || null,
        model: crmModel,
        artifact: call.objectName ? {
          objectName: call.objectName,
          mimeType: call.mimeType || null,
        } : null,
        createdAt: now,
        expiresAt: evidenceExpiresAt,
      }, { merge: false });
      transaction.set(requestRef, {
        companyId: input.companyId,
        contactId,
        status: "needs_review",
        interactionIds: FieldValue.arrayUnion(interactionId),
        activeProcessingRunId: runId,
        reviewTaskId: taskId,
        missingInformation: extraction.missingInformation,
        revision: requestSnapshot.exists ? requestSnapshot.data()?.revision || 0 : 0,
        createdAt: requestSnapshot.exists ? requestSnapshot.data()?.createdAt || now : now,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(taskRef, {
        companyId: input.companyId,
        type: "review_intake",
        status: "open",
        interactionId,
        serviceRequestId: requestId,
        processingRunId: runId,
        createdAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(runRef, {
        status: "completed",
        proposals: extraction.proposals,
        missingInformation: extraction.missingInformation,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        expiresAt: evidenceExpiresAt,
      }, { merge: true });
      transaction.set(callRef, {
        crmStatus: "needs_review",
        crmInteractionId: interactionId,
        crmRequestId: requestId,
        crmProcessingRunId: runId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(eventRef, {
        companyId: input.companyId,
        aggregateType: "service_request",
        aggregateId: requestId,
        type: "intake_created",
        actor: { kind: "system", id: "crm-extractor" },
        after: { interactionId, contactId, processingRunId: runId },
        createdAt: now,
      });
    });

    return { interactionId, requestId, runId, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([
      runRef.set({
        status: "failed",
        error: message.slice(0, 2000),
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }),
      callRef.set({
        crmStatus: "failed",
        crmError: message.slice(0, 2000),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }),
    ]);
    throw error;
  }
}
