import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { defineSecret } from "firebase-functions/params";
import { db, jsonSafe } from "./firestore.js";
import { enabledProcedure, router, signedInProcedure } from "./trpc.js";
import { processCompletedCall } from "./crm/process.js";
import { reviewIntake } from "./crm/review.js";
import { reviewInputSchema } from "./crm/schemas.js";
import {
  allowedRequestTransitions,
  canTransitionRequestStatus,
  normalizeRequestStatus,
  openRequestStatuses,
  requestStatusValues,
  storedStatusesFor,
  type RequestStatus,
} from "./crm/lifecycle.js";

export const geminiApiKey = defineSecret("GEMINI_API_KEY");

async function getAccess(uid: string) {
  const snapshot = await db.doc(`access/${uid}`).get();
  const data = snapshot.data();
  return {
    exists: snapshot.exists,
    enabled: data?.enabled === true,
    admin: data?.admin === true,
    email: String(data?.email || ""),
    displayName: String(data?.displayName || ""),
    photoURL: String(data?.photoURL || ""),
  };
}

async function intakeDetails(requestId: string) {
  const requestSnapshot = await db.doc(`serviceRequests/${requestId}`).get();
  if (!requestSnapshot.exists) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Service request not found" });
  }
  const request = requestSnapshot.data()!;
  const refs = [
    db.doc(`contacts/${String(request.contactId)}`),
    db.doc(`interactions/${String((request.interactionIds as string[] | undefined)?.[0] || "missing")}`),
    db.doc(`processingRuns/${String(request.activeProcessingRunId)}`),
    db.doc(`tasks/${String(request.reviewTaskId)}`),
  ];
  const documents = await db.getAll(...refs);
  const contact = documents[0]!;
  const interaction = documents[1]!;
  const processingRun = documents[2]!;
  const task = documents[3]!;
  return jsonSafe({
    request: { id: requestSnapshot.id, ...request },
    contact: contact.exists ? { id: contact.id, ...contact.data() } : null,
    interaction: interaction.exists ? { id: interaction.id, ...interaction.data() } : null,
    processingRun: processingRun.exists ? { id: processingRun.id, ...processingRun.data() } : null,
    task: task.exists ? { id: task.id, ...task.data() } : null,
  });
}

async function requestCounts(): Promise<Record<RequestStatus, number>> {
  const results = await Promise.all(requestStatusValues.map(async (status) => {
    const stored = storedStatusesFor([status]);
    const snapshots = await Promise.all(stored.map((value) => db.collection("serviceRequests")
      .where("status", "==", value)
      .count()
      .get()));
    return [status, snapshots.reduce((sum, snapshot) => sum + snapshot.data().count, 0)] as const;
  }));
  return Object.fromEntries(results) as Record<RequestStatus, number>;
}

async function listServiceRequests(input: {
  statuses?: RequestStatus[];
  contactId?: string;
  limit?: number;
}) {
  const selectedStatuses = input.statuses?.length ? input.statuses : openRequestStatuses;
  const storedStatuses = storedStatusesFor(selectedStatuses);
  let query = db.collection("serviceRequests").where("status", "in", storedStatuses);
  if (input.contactId) query = query.where("contactId", "==", input.contactId);
  const snapshot = await query.orderBy("updatedAt", "desc").limit(input.limit || 50).get();
  const contactIds = [...new Set(snapshot.docs.map((doc) => String(doc.data().contactId || "")).filter(Boolean))];
  const contacts = contactIds.length
    ? await db.getAll(...contactIds.map((id) => db.doc(`contacts/${id}`)))
    : [];
  const contactById = new Map(contacts.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()!]));
  return jsonSafe(snapshot.docs.map((doc) => {
    const data = doc.data();
    const contact = contactById.get(String(data.contactId || "")) || {};
    return {
      id: doc.id,
      ...data,
      status: normalizeRequestStatus(data.status),
      contact: {
        id: String(data.contactId || ""),
        displayName: contact.displayName || null,
        phone: contact.phoneE164 || contact.phoneRaw || null,
        email: contact.email || null,
      },
    };
  }));
}

export const appRouter = router({
  auth: router({
    register: signedInProcedure.mutation(async ({ ctx }) => {
      const accessRef = db.doc(`access/${ctx.uid}`);
      try {
        await accessRef.create({
          email: ctx.email,
          displayName: ctx.displayName,
          photoURL: ctx.photoURL,
          enabled: false,
          admin: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        const code = (error as { code?: number | string }).code;
        if (code !== 6 && code !== "6" && code !== "already-exists") throw error;
        await accessRef.set({
          email: ctx.email,
          displayName: ctx.displayName,
          photoURL: ctx.photoURL,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return getAccess(ctx.uid);
    }),
    status: signedInProcedure.query(({ ctx }) => getAccess(ctx.uid)),
  }),

  system: router({
    health: enabledProcedure.query(async () => {
      await db.collection("serviceRequests").limit(1).get();
      return {
        ok: true,
        projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d",
        databaseId: "odorik",
        databaseEdition: "Firestore Enterprise",
        model: "gemini-3.1-flash-lite",
      };
    }),
  }),

  intake: router({
    list: enabledProcedure
      .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).optional())
      .query(async ({ input }) => {
        const taskSnapshot = await db.collection("tasks")
          .where("type", "==", "review_intake")
          .where("status", "==", "open")
          .orderBy("createdAt", "desc")
          .limit(input?.limit || 30)
          .get();
        const tasks = taskSnapshot.docs;
        if (tasks.length === 0) return [];
        const requestRefs = tasks.map((task) => db.doc(`serviceRequests/${task.data().serviceRequestId}`));
        const requestSnapshots = await db.getAll(...requestRefs);
        const requestById = new Map(requestSnapshots.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()!]));
        const contactIds = [...new Set(requestSnapshots.filter((doc) => doc.exists).map((doc) => String(doc.data()?.contactId || "")).filter(Boolean))];
        const interactionIds = [...new Set(tasks.map((task) => String(task.data().interactionId || "")).filter(Boolean))];
        const [contacts, interactions] = await Promise.all([
          contactIds.length ? db.getAll(...contactIds.map((id) => db.doc(`contacts/${id}`))) : Promise.resolve([]),
          interactionIds.length ? db.getAll(...interactionIds.map((id) => db.doc(`interactions/${id}`))) : Promise.resolve([]),
        ]);
        const contactById = new Map(contacts.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()!]));
        const interactionById = new Map(interactions.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()!]));
        return jsonSafe(tasks.map((task) => {
          const taskData = task.data();
          const requestId = String(taskData.serviceRequestId);
          const request = requestById.get(requestId) || {};
          const contact = contactById.get(String(request.contactId || "")) || {};
          const interaction = interactionById.get(String(taskData.interactionId || "")) || {};
          return {
            id: task.id,
            status: taskData.status,
            createdAt: taskData.createdAt,
            requestId,
            requestStatus: request.status,
            revision: request.revision || 0,
            title: request.title || interaction.summary || "New telephone request",
            missingInformation: request.missingInformation || [],
            contactName: contact.displayName || null,
            phone: contact.phoneE164 || contact.phoneRaw || interaction.from || null,
            occurredAt: interaction.occurredAt || interaction.createdAt || null,
            summary: interaction.summary || null,
          };
        }));
      }),
    get: enabledProcedure
      .input(z.object({ requestId: z.string().min(1) }))
      .query(({ input }) => intakeDetails(input.requestId)),
    review: enabledProcedure
      .input(reviewInputSchema)
      .mutation(({ ctx, input }) => reviewIntake(input, ctx.uid)),
    reprocess: enabledProcedure
      .input(z.object({ callId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        return processCompletedCall({ callId: input.callId, apiKey: geminiApiKey.value() });
      }),
  }),

  contacts: router({
    list: enabledProcedure
      .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).optional())
      .query(async ({ input }) => {
        const snapshot = await db.collection("contacts")
          .orderBy("updatedAt", "desc")
          .limit(input?.limit || 30)
          .get();
        return jsonSafe(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      }),
    get: enabledProcedure
      .input(z.object({ contactId: z.string().min(1) }))
      .query(async ({ input }) => {
        const [snapshot, requests, interactions] = await Promise.all([
          db.doc(`contacts/${input.contactId}`).get(),
          listServiceRequests({
            statuses: [...requestStatusValues],
            contactId: input.contactId,
            limit: 50,
          }),
          db.collection("interactions").where("contactId", "==", input.contactId).limit(50).get(),
        ]);
        if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        return jsonSafe({
          contact: { id: snapshot.id, ...snapshot.data()! },
          requests,
          interactions: interactions.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        });
      }),
  }),

  serviceRequests: router({
    list: enabledProcedure
      .input(z.object({
        statuses: z.array(z.enum(requestStatusValues)).max(requestStatusValues.length).optional(),
        contactId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }).optional())
      .query(async ({ input }) => {
        const [items, counts] = await Promise.all([
          listServiceRequests(input || {}),
          requestCounts(),
        ]);
        return { items, counts };
      }),
    get: enabledProcedure
      .input(z.object({ requestId: z.string().min(1) }))
      .query(({ input }) => intakeDetails(input.requestId)),
    transition: enabledProcedure
      .input(z.object({
        requestId: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
        to: z.enum(requestStatusValues),
        note: z.string().trim().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const requestRef = db.doc(`serviceRequests/${input.requestId}`);
        const eventRef = db.collection("auditEvents").doc();
        return db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(requestRef);
          if (!snapshot.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Service request not found" });
          const before = snapshot.data()!;
          const from = normalizeRequestStatus(before.status);
          if (!from) throw new TRPCError({ code: "CONFLICT", message: "This request is not ready for lifecycle changes." });
          const currentRevision = Number(before.revision || 0);
          if (currentRevision !== input.expectedRevision) {
            throw new TRPCError({ code: "CONFLICT", message: "This request changed. Reload before changing its status." });
          }
          if (!canTransitionRequestStatus(from, input.to)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Cannot move a request from ${from} to ${input.to}.`,
            });
          }
          const now = Timestamp.now();
          const nextRevision = currentRevision + 1;
          transaction.update(requestRef, {
            status: input.to,
            revision: nextRevision,
            statusChangedAt: now,
            statusChangedBy: ctx.uid,
            lastStatusNote: input.note?.trim() || null,
            completedAt: input.to === "completed" ? now : FieldValue.delete(),
            cancelledAt: input.to === "cancelled" ? now : FieldValue.delete(),
            updatedAt: now,
          });
          transaction.set(eventRef, {
            aggregateType: "service_request",
            aggregateId: input.requestId,
            type: "request_status_changed",
            actor: { kind: "user", id: ctx.uid },
            before: { status: from, revision: currentRevision },
            after: { status: input.to, revision: nextRevision, note: input.note?.trim() || null },
            createdAt: now,
          });
          return {
            requestId: input.requestId,
            status: input.to,
            revision: nextRevision,
            allowedTransitions: allowedRequestTransitions(input.to),
          };
        });
      }),
  }),
});

export type AppRouter = typeof appRouter;
