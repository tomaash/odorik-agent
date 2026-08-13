import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";

export const slackLinkLifetimeMs = 15 * 60 * 1000;

export function slackIdentityPath(input: {
  companyId: string;
  connectionId: string;
  slackUserId: string;
}): string {
  if ([input.companyId, input.connectionId, input.slackUserId].some((value) => !value || value.includes("/"))) {
    throw new Error("Invalid Slack identity path");
  }
  return `companies/${input.companyId}/connections/${input.connectionId}/slackUsers/${input.slackUserId}`;
}

export async function createSlackLink(input: {
  companyId: string;
  connectionId: string;
  teamId: string;
  slackUserId: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ token: string; url: string; expiresAt: Timestamp }> {
  const database = input.database || db;
  const token = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + slackLinkLifetimeMs);
  await database.doc(`slackLinkTokens/${sha256Hex(token)}`).create({
    companyId: input.companyId,
    connectionId: input.connectionId,
    teamId: input.teamId,
    slackUserId: input.slackUserId,
    status: "pending",
    createdAt: now,
    expiresAt,
  });
  const url = new URL("/slack/link", input.appOrigin);
  url.searchParams.set("token", token);
  return { token, url: url.toString(), expiresAt };
}

export async function inspectSlackLink(input: {
  token: string;
  companyId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ teamId: string; slackUserId: string; expiresAt: Timestamp }> {
  const database = input.database || db;
  const snapshot = await database.doc(`slackLinkTokens/${sha256Hex(input.token)}`).get();
  const data = snapshot.data();
  const expiresAt = data?.expiresAt instanceof Timestamp ? data.expiresAt : null;
  if (
    !snapshot.exists
    || data?.status !== "pending"
    || data?.companyId !== input.companyId
    || !expiresAt
    || expiresAt.toMillis() < Date.now()
  ) throw new Error("This Slack account-link link is invalid or expired.");
  return {
    teamId: String(data.teamId || ""),
    slackUserId: String(data.slackUserId || ""),
    expiresAt,
  };
}

export async function consumeSlackLink(input: {
  token: string;
  companyId: string;
  uid: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ connectionId: string; slackUserId: string }> {
  const database = input.database || db;
  const tokenRef = database.doc(`slackLinkTokens/${sha256Hex(input.token)}`);
  return database.runTransaction(async (transaction) => {
    const tokenSnapshot = await transaction.get(tokenRef);
    const data = tokenSnapshot.data();
    const expiresAt = data?.expiresAt instanceof Timestamp ? data.expiresAt : null;
    if (
      !tokenSnapshot.exists
      || data?.status !== "pending"
      || data?.companyId !== input.companyId
      || !expiresAt
      || expiresAt.toMillis() < Date.now()
    ) throw new Error("This Slack account-link link is invalid or expired.");
    const membershipRef = database.doc(`companies/${input.companyId}/memberships/${input.uid}`);
    const membership = await transaction.get(membershipRef);
    if (!membership.exists || membership.data()?.status !== "active") {
      throw new Error("An active company membership is required.");
    }
    const connectionId = String(data.connectionId || "");
    const slackUserId = String(data.slackUserId || "");
    const identityRef = database.doc(slackIdentityPath({
      companyId: input.companyId,
      connectionId,
      slackUserId,
    }));
    const now = Timestamp.now();
    transaction.set(identityRef, {
      companyId: input.companyId,
      connectionId,
      teamId: String(data.teamId || ""),
      slackUserId,
      uid: input.uid,
      status: "active",
      linkedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.update(tokenRef, {
      status: "used",
      usedByUid: input.uid,
      usedAt: now,
    });
    return { connectionId, slackUserId };
  });
}
