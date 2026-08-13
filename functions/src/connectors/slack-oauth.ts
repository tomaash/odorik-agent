import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { capabilityConfigRef, connectionRef } from "./google-oauth.js";
import { chatDirectScopes, chatNotifyScopes } from "./registry.js";
import { slackOAuthRedirectUri, slackOAuthReturnUrl } from "./slack-oauth-return.js";

export const slackConnectorClientId = defineSecret("SLACK_CLIENT_ID");
export const slackConnectorClientSecret = defineSecret("SLACK_CLIENT_SECRET");

export const slackAuthorizationLifetimeMs = 60 * 60 * 1000;

export const slackAuthorizationCapabilityIds = [
  "action.chat.notify",
  "context.chat.direct",
] as const;
export type SlackAuthorizationCapabilityId = typeof slackAuthorizationCapabilityIds[number];

function requestedSlackCapabilities(
  value?: readonly SlackAuthorizationCapabilityId[],
): SlackAuthorizationCapabilityId[] {
  const allowed = new Set<string>(slackAuthorizationCapabilityIds);
  const requested = [...new Set(value || ["action.chat.notify"])]
    .filter((capabilityId): capabilityId is SlackAuthorizationCapabilityId => (
      allowed.has(capabilityId)
    ));
  if (requested.length === 0) {
    throw new SlackAuthorizationError("At least one Slack capability is required");
  }
  return requested;
}

function scopesForSlackCapabilities(
  capabilityIds: readonly SlackAuthorizationCapabilityId[],
): string[] {
  const scopes = new Set<string>();
  if (capabilityIds.includes("action.chat.notify")) {
    chatNotifyScopes.forEach((scope) => scopes.add(scope));
  }
  if (capabilityIds.includes("context.chat.direct")) {
    chatDirectScopes.forEach((scope) => scopes.add(scope));
  }
  return [...scopes];
}

/**
 * What Erik keeps after an install.
 *
 * There is no refresh token and no expiry: this app has not opted into token
 * rotation, so Slack issues a long-lived bot token. If rotation is ever enabled,
 * this envelope grows a refresh token and every reader must start checking it —
 * which is why the shape is written down rather than inferred from a string.
 */
export type SlackCredential = {
  botToken: string;
  scope: string;
  teamId: string;
  botUserId: string;
};

export type SlackOAuthAccessResponse = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
};

export class SlackAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackAuthorizationError";
  }
}

/** One Slack connection per workspace, keyed by Slack's stable team id. */
export function slackConnectionId(teamId: string): string {
  return `slack_${sha256Hex(teamId).slice(0, 32)}`;
}

export async function createSlackAuthorization(input: {
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  capabilityIds?: SlackAuthorizationCapabilityId[];
  returnOrigin?: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ authorizationUrl: string }> {
  const database = input.database || db;
  const state = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const redirectUri = slackOAuthRedirectUri();
  const requestedCapabilityIds = requestedSlackCapabilities(input.capabilityIds);
  const requestedScopes = scopesForSlackCapabilities(requestedCapabilityIds);
  await database.doc(`oauthStates/${sha256Hex(state)}`).set({
    companyId: input.companyId,
    provider: "slack",
    requestedCapabilityIds,
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    redirectUri,
    returnUrl: slackOAuthReturnUrl(input.returnOrigin),
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + slackAuthorizationLifetimeMs),
  });
  // Slack separates comma-joined bot scopes (`scope`) from user scopes
  // (`user_scope`). Erik requests no user scope at all: nothing it does here acts
  // as the installing person.
  const query = new URLSearchParams({
    client_id: input.clientId,
    scope: requestedScopes.join(","),
    redirect_uri: redirectUri,
    state,
  });
  return {
    authorizationUrl: `https://slack.com/oauth/v2/authorize?${query.toString()}`,
  };
}

export async function completeSlackAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{
  connectionId: string;
  teamName: string;
  grantedScopes: string[];
  requestedScopes: string[];
}> {
  const database = input.database || db;
  const stateRef = database.doc(`oauthStates/${sha256Hex(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp
    ? stateData.expiresAt.toMillis()
    : 0;
  if (
    !stateSnapshot.exists
    || stateData?.provider !== "slack"
    || typeof stateData?.companyId !== "string"
    || expiresAt < Date.now()
  ) {
    throw new SlackAuthorizationError(
      "The Slack authorization request is invalid or expired",
    );
  }

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: String(stateData.redirectUri || slackOAuthRedirectUri()),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  // Slack reports OAuth failures as ok:false inside an HTTP 200.
  const body = await response.json().catch(() => ({})) as SlackOAuthAccessResponse;
  if (!body.ok) {
    throw new SlackAuthorizationError(
      `Slack rejected the installation: ${body.error || "unknown_error"}`,
    );
  }
  const botToken = String(body.access_token || "").trim();
  const teamId = String(body.team?.id || "").trim();
  if (!botToken || !teamId) {
    throw new SlackAuthorizationError(
      "Slack did not return a bot token and workspace identity",
    );
  }

  const grantedScopes = String(body.scope || "").split(",").map((s) => s.trim()).filter(Boolean);
  const stateCapabilityIds = Array.isArray(stateData.requestedCapabilityIds)
    ? stateData.requestedCapabilityIds.filter((value): value is SlackAuthorizationCapabilityId => (
      typeof value === "string"
      && slackAuthorizationCapabilityIds.includes(value as SlackAuthorizationCapabilityId)
    ))
    : [];
  const requestedCapabilityIds = requestedSlackCapabilities(
    stateCapabilityIds.length ? stateCapabilityIds : undefined,
  );
  const requestedScopes = scopesForSlackCapabilities(requestedCapabilityIds);
  const missingScopes = requestedScopes.filter((scope) => !grantedScopes.includes(scope));
  const missingNotifyScopes = chatNotifyScopes.filter((scope) => !grantedScopes.includes(scope));
  const companyId = String(stateData.companyId);
  const connectionId = slackConnectionId(teamId);
  const connection = connectionRef(companyId, connectionId, database);
  const existing = await connection.get();
  const existingData = existing.data();
  const teamName = String(body.team?.name || "Slack workspace");
  const credentials: SlackCredential = {
    botToken,
    scope: grantedScopes.join(","),
    teamId,
    botUserId: String(body.bot_user_id || "").trim(),
  };

  const now = Timestamp.now();
  const capabilityRef = capabilityConfigRef(
    companyId,
    connectionId,
    "chat_notify",
    database,
  );
  const directCapabilityRef = capabilityConfigRef(
    companyId,
    connectionId,
    "chat_direct",
    database,
  );
  const [capabilitySnapshot, directCapabilitySnapshot] = await Promise.all([
    capabilityRef.get(),
    directCapabilityRef.get(),
  ]);
  const capabilityExisted = capabilitySnapshot.exists;
  const batch = database.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    schemaVersion: 2,
    companyId,
    connectorId: "slack",
    providerId: "slack",
    providerAccountId: teamId,
    tenantId: teamId,
    displayName: "Slack",
    accountLabel: teamName,
    status: missingScopes.length === 0 ? "active" : "attention",
    reauthorizationRequired: false,
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: grantedScopes,
    },
    credentialCiphertext: encryptCredentials(credentials, input.credentialKey),
    stats: {
      ...(existingData?.stats || {}),
      lastError: missingScopes.length > 0
        ? "Slack did not grant every requested permission"
        : null,
    },
    createdBy: existingData?.createdBy || stateData.uid,
    authorizedBy: {
      email: stateData.email || null,
      displayName: stateData.displayName || null,
    },
    ...(!existing.exists ? { createdAt: now } : { reauthorizedAt: now }),
    updatedAt: now,
  }, { merge: true });
  if (requestedCapabilityIds.includes("action.chat.notify") || capabilitySnapshot.exists) {
    batch.set(capabilityRef, {
      capabilityId: "action.chat.notify",
      serviceId: "chat_notify",
      direction: "act",
      status: missingNotifyScopes.length === 0 ? "active" : "attention",
      grantedScopes: chatNotifyScopes.filter((scope) => grantedScopes.includes(scope)),
      requiredScopes: [...chatNotifyScopes],
      missingScopes: missingNotifyScopes,
      stats: missingNotifyScopes.length === 0 ? { lastError: null } : {
        lastError: "Slack did not grant every required permission",
      },
      ...(!capabilityExisted ? { createdAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
  }
  const missingDirectScopes = chatDirectScopes.filter((scope) => !grantedScopes.includes(scope));
  if (requestedCapabilityIds.includes("context.chat.direct") || directCapabilitySnapshot.exists) {
    batch.set(directCapabilityRef, {
      capabilityId: "context.chat.direct",
      serviceId: "chat_direct",
      direction: "observe",
      status: missingDirectScopes.length === 0 ? "active" : "attention",
      grantedScopes: chatDirectScopes.filter((scope) => grantedScopes.includes(scope)),
      requiredScopes: [...chatDirectScopes],
      missingScopes: missingDirectScopes,
      stats: missingDirectScopes.length === 0 ? { lastError: null } : {
        lastError: "Slack did not grant direct-message access",
      },
      ...(!directCapabilitySnapshot.exists ? { createdAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
    batch.set(database.doc(`slackWorkspaces/${teamId}`), {
      teamId,
      companyId,
      connectionId,
      status: missingDirectScopes.length === 0 ? "active" : "attention",
      updatedAt: now,
      ...(!existing.exists ? { createdAt: now } : {}),
    }, { merge: true });
  }
  await batch.commit();
  return { connectionId, teamName, grantedScopes, requestedScopes };
}

export class SlackNotifyGrantMissingError extends Error {
  constructor() {
    super(
      "Slack notifications are not enabled for this workspace. "
      + "An administrator must connect Slack on Sources.",
    );
    this.name = "SlackNotifyGrantMissingError";
  }
}

/**
 * Resolve the bot token and prove the notify capability is actually active.
 *
 * Mirrors `authorizedGoogleCapability`, minus the refresh: an unrotated Slack bot
 * token has no expiry to check. A revoked or downgraded install shows up as an API
 * failure at post time, not here.
 */
export async function authorizedSlackNotify(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ botToken: string; teamId: string }> {
  const database = input.database || db;
  const [connection, capability] = await Promise.all([
    connectionRef(input.companyId, input.connectionId, database).get(),
    capabilityConfigRef(input.companyId, input.connectionId, "chat_notify", database).get(),
  ]);
  const data = connection.data();
  const capabilityData = capability.data();
  if (
    !connection.exists
    || data?.connectorId !== "slack"
    || !["active", "attention"].includes(String(data?.status))
    || !capability.exists
    || capabilityData?.capabilityId !== "action.chat.notify"
    || !["active", "attention"].includes(String(capabilityData?.status))
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new SlackNotifyGrantMissingError();
  }
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as SlackCredential;
  const granted = new Set(credentials.scope.split(",").map((s) => s.trim()).filter(Boolean));
  if (!chatNotifyScopes.every((scope) => granted.has(scope))) {
    throw new SlackNotifyGrantMissingError();
  }
  if (!credentials.botToken) throw new SlackNotifyGrantMissingError();
  return { botToken: credentials.botToken, teamId: credentials.teamId };
}

export async function authorizedSlackDirect(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ botToken: string; teamId: string; botUserId: string }> {
  const database = input.database || db;
  const [connection, capability] = await Promise.all([
    connectionRef(input.companyId, input.connectionId, database).get(),
    capabilityConfigRef(input.companyId, input.connectionId, "chat_direct", database).get(),
  ]);
  const data = connection.data();
  const capabilityData = capability.data();
  if (
    !connection.exists
    || data?.connectorId !== "slack"
    || !["active", "attention"].includes(String(data?.status))
    || !capability.exists
    || capabilityData?.capabilityId !== "context.chat.direct"
    || capabilityData?.status !== "active"
    || typeof data.credentialCiphertext !== "string"
  ) throw new SlackNotifyGrantMissingError();
  const credentials = decryptCredentials(data.credentialCiphertext, input.credentialKey) as SlackCredential;
  const granted = new Set(credentials.scope.split(",").map((scope) => scope.trim()).filter(Boolean));
  if (!chatDirectScopes.every((scope) => granted.has(scope)) || !credentials.botToken) {
    throw new SlackNotifyGrantMissingError();
  }
  return {
    botToken: credentials.botToken,
    teamId: credentials.teamId,
    botUserId: credentials.botUserId,
  };
}

/** Revoke the bot token so disconnecting actually ends Slack's side of the grant. */
export async function revokeSlackAuthorization(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<boolean> {
  const database = input.database || db;
  const connection = await connectionRef(
    input.companyId,
    input.connectionId,
    database,
  ).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.connectorId !== "slack"
    || typeof data.credentialCiphertext !== "string"
  ) return false;
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as SlackCredential;
  if (!credentials.botToken) return false;
  try {
    const response = await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean };
    return Boolean(body.ok);
  } catch {
    return false;
  }
}
