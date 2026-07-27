import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";

export const legacyOdorikConnectionId = "odorik-primary";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function odorikDestinationUrl(
  uploadUrl: string,
  username: string,
  password: string,
): string {
  const destination = new URL(uploadUrl);
  destination.username = username;
  destination.password = password;
  return `${destination.toString()}!mp3`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonTimestamp(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

export function odorikResourceIdentity(call: Record<string, unknown>): {
  externalId: string;
  displayName: string;
  resourceId: string;
} {
  const lineName = text(call.lineName);
  const number = text(call.to);
  const externalId = lineName
    ? `line:${lineName}`
    : number
      ? `number:${number}`
      : "line:unassigned";
  return {
    externalId,
    displayName: lineName || number || "Unassigned line",
    resourceId: `phone_${hash(externalId).slice(0, 24)}`,
  };
}

export function odorikContextItemId(connectionId: string, callId: string): string {
  return `call_${hash(`${connectionId}:${callId}`).slice(0, 32)}`;
}

export function odorikContextItem(
  callId: string,
  call: Record<string, unknown>,
  companyId: string,
): Record<string, unknown> | null {
  if (call.status !== "completed" || !text(call.transcript) || call.contextEnabled === false) {
    return null;
  }
  const connectionId = text(call.connectionId) || legacyOdorikConnectionId;
  const externalCallId = call.source
    && typeof call.source === "object"
    && !Array.isArray(call.source)
    ? text((call.source as Record<string, unknown>).externalId) || callId
    : callId;
  const resource = odorikResourceIdentity(call);
  const resourceId = text(call.resourceId) || resource.resourceId;
  const from = text(call.from);
  const to = text(call.to);
  const summary = text(call.summary);
  const transcript = text(call.transcript);
  const occurredAt = jsonTimestamp(call.odorikTime)
    || jsonTimestamp(call.uploadedAt)
    || jsonTimestamp(call.processedAt);
  const sourceVersion = jsonTimestamp(call.updatedAt)
    || jsonTimestamp(call.processedAt)
    || hash(transcript).slice(0, 16);
  const contentForChecksum = JSON.stringify({
    connectionId,
    resourceId,
    from,
    to,
    occurredAt,
    summary,
    transcript,
    segments: call.segments || [],
  });
  return {
    companyId,
    kind: "call",
    source: {
      adapterId: "odorik",
      connectionId,
      resourceId,
      externalId: externalCallId,
      version: sourceVersion,
    },
    title: from || to ? `Call ${from || "unknown"} → ${to || "unknown"}` : `Call ${callId}`,
    text: [summary && `Summary: ${summary}`, `Transcript:\n${transcript}`].filter(Boolean).join("\n\n"),
    occurredAt,
    observedAt: call.processedAt || call.uploadedAt || Timestamp.now(),
    artifactRefs: call.objectName ? [String(call.objectName)] : [],
    participantRefs: [from, to].filter(Boolean),
    access: { visibility: "company" },
    metadata: {
      from: from || null,
      to: to || null,
      durationSeconds: Number(call.duration || 0) || null,
      lineName: text(call.lineName) || null,
      language: text(call.language) || null,
      summary: summary || null,
      sourceCallId: callId,
    },
    provenance: {
      rawRef: `companies/${companyId}/calls/${callId}`,
      checksum: hash(contentForChecksum),
      ingestionVersion: "odorik-v1",
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export async function projectOdorikCallContext(
  companyId: string,
  callId: string,
  call: Record<string, unknown> | undefined,
): Promise<void> {
  const connectionId = text(call?.connectionId) || legacyOdorikConnectionId;
  const contextRef = db.doc(
    `companies/${companyId}/contextItems/${odorikContextItemId(connectionId, callId)}`,
  );
  if (!call) {
    // A call may predate connection metadata. Querying by raw reference handles
    // deletion safely across both the legacy and connection-aware identifiers.
    const existing = await db.collection(`companies/${companyId}/contextItems`)
      .where("provenance.rawRef", "==", `companies/${companyId}/calls/${callId}`)
      .get();
    await Promise.all(existing.docs.map((document) => document.ref.delete()));
    return;
  }
  const contextItem = odorikContextItem(callId, call, companyId);
  if (!contextItem) {
    await contextRef.delete();
    return;
  }
  await contextRef.set(contextItem, { merge: false });
}
