import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { microsoftTeamsConnectionId } from "../connectors/microsoft-teams.js";

export const microsoftTeamsLinkLifetimeMs = 15 * 60 * 1_000;

export function microsoftTeamsIdentityPath(input: {
  companyId: string;
  connectionId: string;
  entraObjectId: string;
}): string {
  if ([input.companyId, input.connectionId, input.entraObjectId]
    .some((value) => !value || value.includes("/"))) throw new Error("Invalid Teams identity path");
  return `companies/${input.companyId}/connections/${input.connectionId}/teamsUsers/${input.entraObjectId}`;
}

export function microsoftTeamsGlobalIdentityPath(input: {
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
}): string {
  const tenantId = input.tenantId.trim().toLocaleLowerCase("en");
  const principalId = (input.entraObjectId || input.teamsUserId).trim();
  if (!tenantId || !principalId) throw new Error("Invalid global Teams identity path");
  return `microsoftTeamsIdentities/${sha256Hex(`${tenantId}:${principalId}`)}`;
}

export async function resolveMicrosoftTeamsLinkedIdentity(input: {
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ companyId: string; connectionId: string; uid: string } | null> {
  const database = input.database || db;
  const identity = await database.doc(microsoftTeamsGlobalIdentityPath(input)).get();
  const data = identity.data() || {};
  if (!identity.exists || data.status !== "active"
    || data.tenantId !== input.tenantId || data.entraObjectId !== input.entraObjectId
    || data.teamsUserId !== input.teamsUserId) return null;
  const companyId = String(data.companyId || "");
  const connectionId = String(data.connectionId || "");
  const uid = String(data.uid || "");
  const connection = await database.doc(`companies/${companyId}/connections/${connectionId}`).get();
  const capability = await connection.ref.collection("capabilities").doc("chat_direct").get();
  const membership = await database.doc(`companies/${companyId}/memberships/${uid}`).get();
  if (!companyId || !connectionId || !uid || !connection.exists
    || connection.data()?.connectorId !== "microsoft_teams" || connection.data()?.status !== "active"
    || connection.data()?.tenantId !== input.tenantId
    || capability.data()?.status !== "active"
    || !membership.exists || membership.data()?.status !== "active") return null;
  return { companyId, connectionId, uid };
}

export async function createMicrosoftTeamsLink(input: {
  companyId?: string;
  connectionId?: string;
  tenantId: string;
  teamsUserId: string;
  entraObjectId: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ token: string; url: string; expiresAt: Timestamp }> {
  const database = input.database || db;
  const token = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + microsoftTeamsLinkLifetimeMs);
  await database.doc(`microsoftTeamsLinkTokens/${sha256Hex(token)}`).create({
    companyId: input.companyId || null,
    connectionId: input.connectionId || null,
    tenantId: input.tenantId,
    teamsUserId: input.teamsUserId,
    entraObjectId: input.entraObjectId,
    status: "pending",
    createdAt: now,
    expiresAt,
  });
  const url = new URL("/teams/link", input.appOrigin);
  url.searchParams.set("token", token);
  return { token, url: url.toString(), expiresAt };
}

async function validLink(input: {
  token: string;
  companyId: string;
  database: FirebaseFirestore.Firestore;
}) {
  const snapshot = await input.database.doc(`microsoftTeamsLinkTokens/${sha256Hex(input.token)}`).get();
  const data = snapshot.data() || {};
  const expiresAt = data.expiresAt instanceof Timestamp ? data.expiresAt : null;
  if (!snapshot.exists || data.status !== "pending"
    || (data.companyId && data.companyId !== input.companyId)
    || !expiresAt || expiresAt.toMillis() < Date.now()) {
    throw new Error("This Teams account-link link is invalid or expired.");
  }
  const connectionId = String(data.connectionId || microsoftTeamsConnectionId(String(data.tenantId || "")));
  const connection = await input.database.doc(
    `companies/${input.companyId}/connections/${connectionId}`,
  ).get();
  const capability = await connection.ref.collection("capabilities").doc("chat_direct").get();
  if (!connection.exists || connection.data()?.connectorId !== "microsoft_teams"
    || connection.data()?.status !== "active" || connection.data()?.tenantId !== data.tenantId
    || capability.data()?.status !== "active") {
    throw new Error("Enable this Microsoft Teams connection in Agent Erik before linking.");
  }
  return { snapshot, data, expiresAt, connectionId };
}

export async function inspectMicrosoftTeamsLink(input: {
  token: string;
  companyId: string;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const { data, expiresAt } = await validLink({ ...input, database });
  return {
    tenantId: String(data.tenantId || ""),
    entraObjectId: String(data.entraObjectId || ""),
    expiresAt,
  };
}

export async function consumeMicrosoftTeamsLink(input: {
  token: string;
  companyId: string;
  uid: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ connectionId: string; entraObjectId: string }> {
  const database = input.database || db;
  const tokenRef = database.doc(`microsoftTeamsLinkTokens/${sha256Hex(input.token)}`);
  return database.runTransaction(async (transaction) => {
    const token = await transaction.get(tokenRef);
    const data = token.data() || {};
    const expiresAt = data.expiresAt instanceof Timestamp ? data.expiresAt : null;
    if (!token.exists || data.status !== "pending"
      || (data.companyId && data.companyId !== input.companyId)
      || !expiresAt || expiresAt.toMillis() < Date.now()) {
      throw new Error("This Teams account-link link is invalid or expired.");
    }
    const membership = await transaction.get(
      database.doc(`companies/${input.companyId}/memberships/${input.uid}`),
    );
    if (!membership.exists || membership.data()?.status !== "active") {
      throw new Error("An active company membership is required.");
    }
    const connectionId = String(data.connectionId
      || microsoftTeamsConnectionId(String(data.tenantId || "")));
    const connectionRef = database.doc(`companies/${input.companyId}/connections/${connectionId}`);
    const connection = await transaction.get(connectionRef);
    const capability = await transaction.get(connectionRef.collection("capabilities").doc("chat_direct"));
    if (!connection.exists || connection.data()?.connectorId !== "microsoft_teams"
      || connection.data()?.status !== "active" || connection.data()?.tenantId !== data.tenantId
      || capability.data()?.status !== "active") {
      throw new Error("Enable this Microsoft Teams connection in Agent Erik before linking.");
    }
    const entraObjectId = String(data.entraObjectId || "");
    const identityRef = database.doc(microsoftTeamsIdentityPath({
      companyId: input.companyId,
      connectionId,
      entraObjectId,
    }));
    const globalIdentityRef = database.doc(microsoftTeamsGlobalIdentityPath({
      tenantId: String(data.tenantId || ""),
      teamsUserId: String(data.teamsUserId || ""),
      entraObjectId,
    }));
    const globalIdentity = await transaction.get(globalIdentityRef);
    if (globalIdentity.exists && globalIdentity.data()?.status === "active"
      && (globalIdentity.data()?.companyId !== input.companyId
        || globalIdentity.data()?.connectionId !== connectionId
        || globalIdentity.data()?.uid !== input.uid)) {
      throw new Error("This Teams identity is already linked to another Agent Erik member.");
    }
    const now = Timestamp.now();
    transaction.set(identityRef, {
      companyId: input.companyId,
      connectionId,
      tenantId: String(data.tenantId || ""),
      teamsUserId: String(data.teamsUserId || ""),
      entraObjectId,
      uid: input.uid,
      status: "active",
      linkedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(globalIdentityRef, {
      companyId: input.companyId,
      connectionId,
      tenantId: String(data.tenantId || ""),
      teamsUserId: String(data.teamsUserId || ""),
      entraObjectId,
      uid: input.uid,
      status: "active",
      linkedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.update(tokenRef, { status: "used", usedByUid: input.uid, usedAt: now });
    return { connectionId, entraObjectId };
  });
}
