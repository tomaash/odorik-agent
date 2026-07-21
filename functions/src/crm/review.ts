import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db } from "../firestore.js";
import type { ReviewInput } from "./schemas.js";

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function reviewIntake(input: ReviewInput, actorUid: string) {
  const requestRef = db.doc(`serviceRequests/${input.requestId}`);
  const reviewRef = db.collection("reviews").doc();
  const eventRef = db.collection("auditEvents").doc();

  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Service request not found" });
    }
    const before = requestSnapshot.data()!;
    const currentRevision = Number(before.revision || 0);
    if (currentRevision !== input.expectedRevision) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This intake changed after it was opened. Reload before saving.",
      });
    }

    const contactId = String(before.contactId || "");
    const taskId = String(before.reviewTaskId || "");
    const processingRunId = String(before.activeProcessingRunId || "");
    if (!contactId || !taskId || !processingRunId) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Intake links are incomplete" });
    }
    const contactRef = db.doc(`contacts/${contactId}`);
    const taskRef = db.doc(`tasks/${taskId}`);
    const processingRunRef = db.doc(`processingRuns/${processingRunId}`);
    const [taskSnapshot, processingRunSnapshot] = await Promise.all([
      transaction.get(taskRef),
      transaction.get(processingRunRef),
    ]);
    if (before.status !== "needs_review" || taskSnapshot.data()?.status !== "open") {
      throw new TRPCError({ code: "CONFLICT", message: "This intake is no longer awaiting review." });
    }
    if (!processingRunSnapshot.exists) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Processing run not found" });
    }
    const proposalFields = new Set(
      ((processingRunSnapshot.data()?.proposals || []) as Array<{ field?: unknown }>)
        .map((proposal) => String(proposal.field || ""))
        .filter(Boolean),
    );
    const decisionFields = new Set(input.decisions.map((decision) => decision.field));
    if (
      proposalFields.size !== decisionFields.size ||
      [...proposalFields].some((field) => !decisionFields.has(field as typeof input.decisions[number]["field"]))
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Every model proposal needs one review decision." });
    }
    const nextRevision = currentRevision + 1;
    const requestAfter = {
      title: input.request.title,
      serviceType: nonEmpty(input.request.serviceType),
      description: nonEmpty(input.request.description),
      address: nonEmpty(input.request.address),
      requestedTiming: nonEmpty(input.request.requestedTiming),
      urgency: input.request.urgency,
      notes: nonEmpty(input.request.notes),
      missingInformation: input.request.missingInformation,
      status: "open",
      revision: nextRevision,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    transaction.set(contactRef, {
      displayName: nonEmpty(input.contact.displayName),
      email: nonEmpty(input.contact.email),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(requestRef, requestAfter);
    transaction.set(taskRef, {
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      completedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(reviewRef, {
      serviceRequestId: input.requestId,
      revision: nextRevision,
      decisions: input.decisions,
      canonical: {
        contact: input.contact,
        request: input.request,
      },
      reviewedAt: Timestamp.now(),
      reviewedBy: actorUid,
    });
    transaction.set(eventRef, {
      aggregateType: "service_request",
      aggregateId: input.requestId,
      type: "intake_reviewed",
      actor: { kind: "user", id: actorUid },
      before: {
        status: before.status || null,
        revision: currentRevision,
      },
      after: {
        status: "open",
        revision: nextRevision,
        decisions: input.decisions,
      },
      createdAt: Timestamp.now(),
    });

    return { requestId: input.requestId, revision: nextRevision, status: "open" as const };
  });
}
