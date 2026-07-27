import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { parseBasicAuth, secureEquals } from "../auth.js";
import { db } from "../firestore.js";

export const legacyCompanyId = "explorers";
export const legacyConnectionId =
  process.env.ODORIK_CONNECTION_ID?.trim() || "odorik-primary";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function odorikResourceIdentity(fields: Record<string, string>): {
  externalId: string;
  displayName: string;
  resourceId: string;
} {
  const lineName = fields.line_name?.trim();
  const number = fields.to?.trim();
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

export function odorikStoredCallId(connectionId: string, externalCallId: string): string {
  if (connectionId === legacyConnectionId) return externalCallId;
  return `odorik_${hash(`${connectionId}:${externalCallId}`).slice(0, 32)}`;
}

export async function authorizeOdorikUpload(input: {
  companyId: string;
  connectionId: string;
  authorization: string | undefined;
  legacyUsername: string | undefined;
  legacyPassword: string | undefined;
}): Promise<{
  connectionId: string;
  credentialMode: "encrypted" | "legacy_secret";
}> {
  const credentials = parseBasicAuth(input.authorization);
  if (!credentials) throw new Error("Unauthorized");

  if (input.connectionId === legacyConnectionId && input.legacyUsername && input.legacyPassword) {
    const connection = await db().doc(
      `companies/${input.companyId}/connections/${input.connectionId}`,
    ).get();
    if (connection.exists && connection.data()?.status === "disconnected") {
      throw new Error("Unauthorized");
    }
    if (
      secureEquals(credentials.username, input.legacyUsername)
      && secureEquals(credentials.password, input.legacyPassword)
    ) {
      return { connectionId: input.connectionId, credentialMode: "legacy_secret" };
    }
  }

  const snapshot = await db().doc(
    `companies/${input.companyId}/connections/${input.connectionId}`,
  ).get();
  const connection = snapshot.data();
  if (
    !snapshot.exists
    || connection?.adapterId !== "odorik"
    || connection?.status !== "active"
    || typeof connection.credentialCiphertext !== "string"
  ) {
    throw new Error("Unauthorized");
  }
  const key = process.env.CONNECTOR_CREDENTIAL_KEY?.trim();
  if (!key) throw new Error("Connector credential key is not configured");
  const { decryptCredentials } = await import("./credentials.js");
  const decrypted = decryptCredentials(connection.credentialCiphertext, key);
  if (
    !decrypted.username
    || !decrypted.password
    || !secureEquals(credentials.username, decrypted.username)
    || !secureEquals(credentials.password, decrypted.password)
  ) {
    throw new Error("Unauthorized");
  }
  return { connectionId: input.connectionId, credentialMode: "encrypted" };
}

export async function observeOdorikResource(input: {
  companyId: string;
  connectionId: string;
  fields: Record<string, string>;
}): Promise<{ resourceId: string; contextEnabled: boolean }> {
  const identity = odorikResourceIdentity(input.fields);
  const connectionRef = db().doc(
    `companies/${input.companyId}/connections/${input.connectionId}`,
  );
  const resourceRef = connectionRef.collection("resources").doc(identity.resourceId);
  const [connection, resource] = await Promise.all([
    connectionRef.get(),
    resourceRef.get(),
  ]);
  const contextEnabled = !resource.exists || resource.data()?.status !== "disabled";
  const now = Timestamp.now();
  const batch = db().batch();
  batch.set(db().doc(`companies/${input.companyId}`), {
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(connectionRef, {
    companyId: input.companyId,
    adapterId: "odorik",
    ...(!connection.exists ? {
      displayName: input.connectionId === legacyConnectionId
        ? "Primary Odorik account"
        : input.connectionId,
    } : {}),
    status: "active",
    auth: {
      kind: "basic_upload",
      credentialMode: input.connectionId === legacyConnectionId
        ? "legacy_secret"
        : "encrypted",
    },
    stats: {
      lastObservedAt: now,
      lastError: null,
    },
    ...(!connection.exists ? { createdAt: now } : {}),
    updatedAt: now,
  }, { merge: true });
  batch.set(resourceRef, {
    connectionId: input.connectionId,
    resourceType: "phone_line",
    externalId: identity.externalId,
    displayName: identity.displayName,
    status: resource.exists ? resource.data()?.status || "enabled" : "enabled",
    lastObservedAt: now,
    createdAt: resource.exists ? resource.data()?.createdAt || now : now,
    updatedAt: now,
  }, { merge: true });
  await batch.commit();
  return { resourceId: identity.resourceId, contextEnabled };
}
