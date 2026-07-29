import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { sha256Hex } from "./hash.js";
import { normalizePhone } from "./phone.js";
import { companyDocumentPath } from "./tenancy.js";

/**
 * Completed calls, and how they reach the internal CRM.
 *
 * A caller must exist as a contact before anything downstream can reference
 * them: workflow conditions test `caller.hasContact`, and every task an
 * approval creates carries a `contactId`. Contacts are therefore projected
 * from the call itself rather than as a side effect of any one workflow.
 */

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") return Number(toMillis.call(value));
  }
  return null;
}

/**
 * A call is processed when it first reaches `completed`, or when an operator
 * explicitly asks for a backfill of an already-completed call.
 */
export function shouldProcessCallUpdate(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  if (!after || after.status !== "completed") return false;
  if (before?.status !== "completed") return true;
  const beforeBackfill = timestampMillis(before.backfillRequestedAt)
    ?? timestampMillis(before.crmBackfillRequestedAt);
  const afterBackfill = timestampMillis(after.backfillRequestedAt)
    ?? timestampMillis(after.crmBackfillRequestedAt);
  return afterBackfill !== null && afterBackfill !== beforeBackfill;
}

/**
 * Stable contact identity for a phone number.
 *
 * Unchanged from the original call-to-CRM scheme so that contacts created
 * before the internal CRM existed keep resolving to the same document instead
 * of being duplicated.
 */
export function callContactId(phoneE164: string): string {
  return `phone_${sha256Hex(phoneE164).slice(0, 24)}`;
}

/**
 * Upsert the caller of a completed call as a contact.
 *
 * Only connection facts are written. A `displayName` a person has edited is
 * never overwritten by a later call from the same number.
 */
export async function projectCallContact(input: {
  companyId: string;
  callId: string;
  call: Record<string, unknown> | undefined;
}): Promise<string | null> {
  const call = input.call;
  if (!call || call.status !== "completed") return null;
  const phoneRaw = typeof call.from === "string" ? call.from : null;
  const phoneE164 = normalizePhone(phoneRaw);
  if (!phoneE164) return null;

  const contactId = callContactId(phoneE164);
  const contactRef = db.doc(
    companyDocumentPath(input.companyId, "contacts", contactId),
  );
  const existing = await contactRef.get();
  await contactRef.set({
    companyId: input.companyId,
    phoneE164,
    phoneRaw,
    lastCallAt: call.odorikTime || call.uploadedAt || FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : {
      createdFromCallId: input.callId,
      origin: "call",
      createdAt: FieldValue.serverTimestamp(),
    }),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Link the call back to the contact so a contact can list its own calls and
  // the workflow runtime can skip the phone lookup. This write re-enters the
  // call trigger, but `shouldProcessCallUpdate` rejects it: the status is
  // already `completed` and no backfill was requested.
  if (call.contactId !== contactId) {
    await db.doc(companyDocumentPath(input.companyId, "calls", input.callId)).set({
      contactId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return contactId;
}
