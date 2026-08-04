import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import { sha256Hex } from "./hash.js";
import { normalizePhone } from "./phone.js";
import { companyDocumentPath } from "./tenancy.js";
import { companyAudience, normalizeResourceAudience, type ResourceAudience } from "./access.js";

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

export function projectedCallContactAccess(input: {
  existing: Record<string, unknown> | undefined;
  call: Record<string, unknown>;
}): { access: ResourceAudience; indexingEnabled: boolean } {
  const existingEnabled = Boolean(input.existing)
    && input.existing?.indexingEnabled !== false;
  const callEnabled = input.call.indexingEnabled !== false
    && input.call.contextEnabled !== false;
  const audiences = [
    ...(existingEnabled ? [normalizeResourceAudience(input.existing?.access)] : []),
    ...(callEnabled ? [normalizeResourceAudience(input.call.access)] : []),
  ];
  if (audiences.some((audience) => audience.visibility === "company")) {
    return { access: companyAudience, indexingEnabled: true };
  }
  const memberIds = [...new Set(audiences.flatMap((audience) => (
    audience.visibility === "restricted" ? audience.memberIds : []
  )))].sort();
  return {
    access: { visibility: "restricted", memberIds },
    indexingEnabled: audiences.length > 0 && memberIds.length > 0,
  };
}

/**
 * Upsert the caller of a completed call as a contact.
 *
 * Only connection facts are written, and the merge below names every field it
 * touches — so anything a person has edited, a `displayName` or an `email`,
 * survives a later call from the same number untouched.
 */
export async function projectCallContact(input: {
  companyId: string;
  callId: string;
  call: Record<string, unknown> | undefined;
}): Promise<string | null> {
  if (!input.call || input.call.status !== "completed") return null;
  const callRef = db.doc(companyDocumentPath(input.companyId, "calls", input.callId));
  return db.runTransaction(async (transaction) => {
    const currentCall = await transaction.get(callRef);
    const call = currentCall.data();
    if (!currentCall.exists || !call || call.status !== "completed") return null;

    const connectionId = typeof call.connectionId === "string" ? call.connectionId : null;
    const resourceId = typeof call.resourceId === "string" ? call.resourceId : null;
    const connectionRef = connectionId
      ? db.doc(companyDocumentPath(input.companyId, "connections", connectionId))
      : null;
    const resourceRef = connectionRef && resourceId
      ? connectionRef.collection("resources").doc(resourceId)
      : null;
    const [connection, resource] = await Promise.all([
      connectionRef ? transaction.get(connectionRef) : Promise.resolve(null),
      resourceRef ? transaction.get(resourceRef) : Promise.resolve(null),
    ]);
    const sourceEnabled = (!connectionRef || (
      connection?.exists && connection.data()?.status !== "disconnected"
    )) && (!resourceRef || (
      resource?.exists && resource.data()?.status !== "disabled"
    ));
    const effectiveCall = {
      ...call,
      ...(resource?.exists ? {
        access: normalizeResourceAudience(resource.data()?.audience),
      } : {}),
      ...(!sourceEnabled ? {
        indexingEnabled: false,
        contextEnabled: false,
      } : {}),
    };
    const phoneRaw = typeof call.from === "string" ? call.from : null;
    const phoneE164 = normalizePhone(phoneRaw);
    if (!phoneE164) return null;

    const contactId = callContactId(phoneE164);
    const contactRef = db.doc(
      companyDocumentPath(input.companyId, "contacts", contactId),
    );
    const existing = await transaction.get(contactRef);
    const contactAccess = projectedCallContactAccess({
      existing: existing.data(),
      call: effectiveCall,
    });
    transaction.set(contactRef, {
      companyId: input.companyId,
      phoneE164,
      phoneRaw,
      lastCallAt: call.odorikTime || call.uploadedAt || FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : {
        createdFromCallId: input.callId,
        origin: "call",
        createdAt: FieldValue.serverTimestamp(),
      }),
      ...contactAccess,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Link the call back to the contact so a contact can list its own calls and
    // the workflow runtime can skip the phone lookup. This write re-enters the
    // call trigger, but `shouldProcessCallUpdate` rejects it: the status is
    // already `completed` and no backfill was requested.
    if (call.contactId !== contactId) {
      transaction.set(callRef, {
        contactId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return contactId;
  });
}
