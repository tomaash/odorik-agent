import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";

export class MicrosoftTeamsInstallationError extends Error {
  constructor(message: string, readonly code = "FAILED_PRECONDITION") {
    super(message);
    this.name = "MicrosoftTeamsInstallationError";
  }
}

export const microsoftConsumerTenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";

export function microsoftTeamsConnectionId(tenantId: string): string {
  const normalized = tenantId.trim().toLocaleLowerCase("en");
  if (!normalized) throw new MicrosoftTeamsInstallationError("A Microsoft tenant is required.");
  return `teams_${sha256Hex(normalized).slice(0, 32)}`;
}

export function microsoftTeamsTenantPath(tenantId: string): string {
  const normalized = tenantId.trim().toLocaleLowerCase("en");
  if (!normalized) throw new MicrosoftTeamsInstallationError("A Microsoft tenant is required.");
  return `microsoftTeamsTenants/${sha256Hex(normalized)}`;
}

export async function enableMicrosoftTeamsInstallation(input: {
  companyId: string;
  microsoftConnectionId: string;
  actorUid: string;
  appId?: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ connectionId: string; tenantId: string; installUrl: string | null }> {
  const database = input.database || db;
  const sourceRef = database.doc(
    `companies/${input.companyId}/connections/${input.microsoftConnectionId}`,
  );
  const source = await sourceRef.get();
  const sourceData = source.data() || {};
  if (!source.exists
    || sourceData.connectorId !== "microsoft_365"
    || !["active", "attention"].includes(String(sourceData.status))) {
    throw new MicrosoftTeamsInstallationError("Connect the Microsoft account first.");
  }
  const tenantId = String(sourceData.tenantId || "").trim();
  if (!tenantId) throw new MicrosoftTeamsInstallationError("The Microsoft connection has no tenant.");
  const consumerIdentityRouting = tenantId.toLocaleLowerCase("en") === microsoftConsumerTenantId;
  const connectionId = microsoftTeamsConnectionId(tenantId);
  const connectionRef = database.doc(`companies/${input.companyId}/connections/${connectionId}`);
  const tenantRef = database.doc(microsoftTeamsTenantPath(tenantId));
  const capabilityRef = connectionRef.collection("capabilities").doc("chat_direct");
  const now = Timestamp.now();
  await database.runTransaction(async (transaction) => {
    const existingConnection = await transaction.get(connectionRef);
    const tenant = consumerIdentityRouting ? null : await transaction.get(tenantRef);
    if (tenant?.exists && tenant.data()?.status === "active"
      && (tenant.data()?.companyId !== input.companyId
        || tenant.data()?.connectionId !== connectionId)) {
      throw new MicrosoftTeamsInstallationError(
        "This Microsoft tenant is already connected to another company.",
        "ALREADY_EXISTS",
      );
    }
    transaction.set(connectionRef, {
      connectorId: "microsoft_teams",
      providerId: "microsoft",
      providerAccountId: tenantId,
      tenantId,
      displayName: "Microsoft Teams",
      accountLabel: String(sourceData.accountLabel || "Microsoft Teams"),
      status: "active",
      auth: { kind: "bot_installation", credentialMode: "managed_secret", scopes: [] },
      sourceMicrosoftConnectionId: input.microsoftConnectionId,
      installation: {
        status: "awaiting_personal_install",
        appId: input.appId || null,
        routingMode: consumerIdentityRouting ? "linked_identity" : "tenant",
      },
      createdByUid: input.actorUid,
      ...(!existingConnection.exists ? { createdAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
    transaction.set(capabilityRef, {
      capabilityId: "context.chat.direct",
      serviceId: "chat_direct",
      status: "active",
      requiredScopes: [],
      grantedScopes: [],
      syncMode: "webhook",
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    if (!consumerIdentityRouting) {
      transaction.set(tenantRef, {
        tenantId,
        companyId: input.companyId,
        connectionId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    }
  });
  const appId = String(input.appId || "").trim();
  return {
    connectionId,
    tenantId,
    installUrl: appId ? `https://teams.microsoft.com/l/app/${encodeURIComponent(appId)}` : null,
  };
}

export async function resolveMicrosoftTeamsTenant(input: {
  tenantId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ companyId: string; connectionId: string } | null> {
  const database = input.database || db;
  const mapping = await database.doc(microsoftTeamsTenantPath(input.tenantId)).get();
  if (!mapping.exists || mapping.data()?.status !== "active") return null;
  const companyId = String(mapping.data()?.companyId || "");
  const connectionId = String(mapping.data()?.connectionId || "");
  const connection = await database.doc(`companies/${companyId}/connections/${connectionId}`).get();
  const capability = await connection.ref.collection("capabilities").doc("chat_direct").get();
  if (!companyId || !connectionId || !connection.exists
    || connection.data()?.connectorId !== "microsoft_teams"
    || connection.data()?.status !== "active"
    || capability.data()?.status !== "active") return null;
  return { companyId, connectionId };
}
