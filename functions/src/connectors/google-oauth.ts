import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { capabilityDescriptor, googleWorkspaceCapabilityIds } from "./registry.js";
import type { CapabilityServiceId, SourceCapabilityId } from "./types.js";
import {
  defaultGoogleRedirectUri,
  googleOAuthRedirectUri,
  googleOAuthReturnUrl,
} from "./google-oauth-return.js";

export const googleIdentityScopes = ["openid", "email"] as const;

export type GoogleTokens = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GoogleErrorBody = {
  error?: string | {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
  error_description?: string;
};

export type GoogleCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

type GoogleUserInfo = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
};

export type GoogleAuthorizationResult = {
  connectionId: string;
  enabledCapabilityIds: SourceCapabilityId[];
  missingCapabilityIds: SourceCapabilityId[];
};

export const googleAuthorizationLifetimeMs = 60 * 60 * 1000;
const refreshSkewMs = 60_000;

export class GoogleReauthorizationRequiredError extends Error {
  readonly code = "GOOGLE_REAUTHORIZATION_REQUIRED";
  readonly status?: number;
  constructor(
    message = "Google Workspace access has expired. Reconnect the account to continue.",
    status?: number,
  ) {
    super(message);
    this.name = "GoogleReauthorizationRequiredError";
    this.status = status;
  }
}

export class GoogleApiError extends Error {
  readonly code = "GOOGLE_API_ERROR";
  readonly status: number;
  readonly reasons: string[];
  readonly googleStatus: string | null;

  constructor(input: {
    label: string;
    status: number;
    message: string;
    reasons?: string[];
    googleStatus?: string | null;
  }) {
    super(`${input.label} API failed (${input.status}): ${input.message.slice(0, 1000)}`);
    this.name = "GoogleApiError";
    this.status = input.status;
    this.reasons = input.reasons || [];
    this.googleStatus = input.googleStatus || null;
  }
}

function googleErrorDetails(body: GoogleErrorBody): {
  message: string;
  reasons: string[];
  googleStatus: string | null;
} {
  if (typeof body.error === "string") {
    return {
      message: body.error_description || body.error,
      reasons: [body.error],
      googleStatus: null,
    };
  }
  const errors = body.error?.errors || [];
  return {
    message: body.error?.message || body.error_description || JSON.stringify(body.error || body),
    reasons: [...new Set(errors.flatMap((error) => error.reason ? [error.reason] : []))],
    googleStatus: body.error?.status || null,
  };
}

function isInvalidGrant(body: GoogleTokens): boolean {
  return body.error === "invalid_grant";
}

export function connectionRef(
  companyId: string,
  connectionId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.doc(companyDocumentPath(companyId, "connections", connectionId));
}

export function connectionCollection(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.collection(companyCollectionPath(companyId, "connections"));
}

export function capabilityConfigRef(
  companyId: string,
  connectionId: string,
  serviceId: CapabilityServiceId,
  database: FirebaseFirestore.Firestore = db,
) {
  return connectionRef(companyId, connectionId, database).collection("capabilities").doc(serviceId);
}

export function googleWorkspaceConnectionId(providerAccountId: string): string {
  return `google_${sha256Hex(providerAccountId).slice(0, 32)}`;
}

export function scopesForCapabilities(
  capabilityIds: readonly SourceCapabilityId[],
): string[] {
  return [...new Set([
    ...googleIdentityScopes,
    ...capabilityIds.flatMap((id) => capabilityDescriptor(id).requiredScopes),
  ])];
}

export function capabilityGrantState(
  requestedCapabilityIds: readonly SourceCapabilityId[],
  grantedScopes: readonly string[],
): {
  enabledCapabilityIds: SourceCapabilityId[];
  missingCapabilityIds: SourceCapabilityId[];
} {
  const granted = new Set(grantedScopes);
  const enabledCapabilityIds: SourceCapabilityId[] = [];
  const missingCapabilityIds: SourceCapabilityId[] = [];
  for (const capabilityId of requestedCapabilityIds) {
    const complete = capabilityDescriptor(capabilityId).requiredScopes
      .every((scope) => granted.has(scope));
    (complete ? enabledCapabilityIds : missingCapabilityIds).push(capabilityId);
  }
  return { enabledCapabilityIds, missingCapabilityIds };
}

export function requireGoogleSuccess<T>(
  label: string,
  response: Response,
  body: T & GoogleErrorBody,
): T {
  if (!response.ok) {
    const details = googleErrorDetails(body);
    throw new GoogleApiError({ label, status: response.status, ...details });
  }
  return body;
}

export async function googleGet<T>(
  label: string,
  url: URL,
  accessToken: string,
): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(60_000),
  });
  return requireGoogleSuccess(label, response, await response.json() as T & GoogleErrorBody);
}

export async function revokeGoogleToken(token: string): Promise<boolean> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return true;
  if (response.status === 400) return false;
  throw new Error(`Google token revocation failed (${response.status})`);
}

async function googleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  return requireGoogleSuccess(
    "Google identity",
    response,
    await response.json() as GoogleUserInfo & GoogleErrorBody,
  );
}

/** Start initial or incremental authorization for explicitly selected capabilities. */
export async function createGoogleWorkspaceAuthorization(input: {
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  capabilityIds: SourceCapabilityId[];
  connectionId?: string;
  returnOrigin?: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ authorizationUrl: string }> {
  const database = input.database || db;
  const requested = new Set(input.capabilityIds);
  if (requested.size === 0) {
    throw new Error("Choose at least one Google Workspace service");
  }
  const state = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const redirectUri = googleOAuthRedirectUri(input.returnOrigin);
  let loginHint = "";
  if (input.connectionId) {
    const existing = await connectionRef(
      input.companyId,
      input.connectionId,
      database,
    ).get();
    if (!existing.exists || existing.data()?.connectorId !== "google_workspace") {
      throw new Error("Google Workspace connection not found");
    }
    loginHint = String(existing.data()?.accountLabel || "");
    // Google issues one credential per connection, so a consent that omits an already
    // enabled service silently downgrades it: the new envelope replaces the old one
    // without that service's scopes. Re-request everything still enabled alongside
    // whatever is being added. This matters most when the credential itself expired —
    // an External app in Testing status expires refresh tokens every seven days — where
    // reconnecting must restore every service in one pass rather than one at a time.
    const capabilities = await existing.ref.collection("capabilities").get();
    for (const capability of capabilities.docs) {
      const capabilityId = capability.data()?.capabilityId as SourceCapabilityId | undefined;
      if (
        capabilityId
        && capability.data()?.status !== "disabled"
        && googleWorkspaceCapabilityIds.includes(capabilityId)
      ) {
        requested.add(capabilityId);
      }
    }
  }
  const capabilityIds = [...requested];
  await database.doc(`oauthStates/${sha256Hex(state)}`).set({
    companyId: input.companyId,
    provider: "google_workspace",
    requestedCapabilityIds: capabilityIds,
    connectionId: input.connectionId || null,
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    redirectUri,
    returnUrl: googleOAuthReturnUrl(input.returnOrigin),
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + googleAuthorizationLifetimeMs),
  });
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: input.connectionId ? "consent" : "consent select_account",
    include_granted_scopes: "true",
    scope: scopesForCapabilities(capabilityIds).join(" "),
    state,
  });
  if (loginHint) query.set("login_hint", loginHint);
  return {
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
  };
}

export async function completeGoogleWorkspaceAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<GoogleAuthorizationResult> {
  const stateRef = db.doc(`oauthStates/${sha256Hex(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp
    ? stateData.expiresAt.toMillis()
    : 0;
  const requestedCapabilityIds = Array.isArray(stateData?.requestedCapabilityIds)
    ? stateData.requestedCapabilityIds.filter(
      (value): value is SourceCapabilityId =>
        googleWorkspaceCapabilityIds.includes(value as SourceCapabilityId),
    )
    : [];
  if (
    !stateSnapshot.exists
    || stateData?.provider !== "google_workspace"
    || typeof stateData?.companyId !== "string"
    || requestedCapabilityIds.length === 0
    || expiresAt < Date.now()
  ) {
    throw new Error("The Google Workspace authorization request is invalid or expired");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: String(stateData.redirectUri || defaultGoogleRedirectUri),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = requireGoogleSuccess(
    "Google Workspace",
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token) {
    throw new Error("Google did not return an access token");
  }

  const identity = await googleUserInfo(tokenBody.access_token);
  if (!identity.sub || !identity.email) {
    throw new Error("Google did not return a stable account identity");
  }
  const companyId = String(stateData.companyId);
  const connectionId = googleWorkspaceConnectionId(identity.sub);
  if (stateData.connectionId && stateData.connectionId !== connectionId) {
    throw new Error("Choose the same Google account when enabling another service");
  }
  const connection = connectionRef(companyId, connectionId);
  const existing = await connection.get();
  const existingData = existing.data();
  let existingCredential: GoogleCredential | null = null;
  if (typeof existingData?.credentialCiphertext === "string") {
    existingCredential = decryptCredentials(
      existingData.credentialCiphertext,
      input.credentialKey,
    ) as GoogleCredential;
  }
  const refreshToken = tokenBody.refresh_token || existingCredential?.refreshToken;
  if (!refreshToken) {
    throw new Error("Google did not return the required offline refresh token");
  }
  const grantedScopes = (tokenBody.scope || existingCredential?.scope || "")
    .split(/\s+/)
    .filter(Boolean);
  const grants = capabilityGrantState(requestedCapabilityIds, grantedScopes);
  const credentials: GoogleCredential = {
    accessToken: tokenBody.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: grantedScopes.join(" "),
  };
  const now = Timestamp.now();
  const existingCapabilities = new Map(await Promise.all(
    requestedCapabilityIds.map(async (capabilityId) => {
      const descriptor = capabilityDescriptor(capabilityId);
      const snapshot = await connection
        .collection("capabilities")
        .doc(descriptor.serviceId)
        .get();
      return [capabilityId, snapshot.exists] as const;
    }),
  ));
  const batch = db.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    schemaVersion: 2,
    companyId,
    connectorId: "google_workspace",
    providerId: "google",
    providerAccountId: identity.sub,
    tenantId: identity.hd || null,
    displayName: "Google Workspace",
    accountLabel: identity.email,
    status: grants.enabledCapabilityIds.length > 0 ? "active" : "attention",
    reauthorizationRequired: false,
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: grantedScopes,
    },
    credentialCiphertext: encryptCredentials(credentials, input.credentialKey),
    stats: {
      ...(existingData?.stats || {}),
      lastError: grants.missingCapabilityIds.length > 0
        ? "Google did not grant every requested permission"
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
  for (const capabilityId of requestedCapabilityIds) {
    const descriptor = capabilityDescriptor(capabilityId);
    const granted = grants.enabledCapabilityIds.includes(capabilityId);
    batch.set(connection.collection("capabilities").doc(descriptor.serviceId), {
      capabilityId,
      serviceId: descriptor.serviceId,
      direction: "observe",
      status: granted ? "active" : "attention",
      grantedScopes: descriptor.requiredScopes.filter((scope) => grantedScopes.includes(scope)),
      requiredScopes: descriptor.requiredScopes,
      missingScopes: descriptor.requiredScopes.filter((scope) => !grantedScopes.includes(scope)),
      stats: granted ? { lastError: null } : {
        lastError: "Google did not grant every required permission",
      },
      ...(!existingCapabilities.get(capabilityId) ? { createdAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  return { connectionId, ...grants };
}

export async function revokeGoogleWorkspaceAuthorization(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
}): Promise<boolean> {
  const connection = await connectionRef(input.companyId, input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.connectorId !== "google_workspace"
    || typeof data.credentialCiphertext !== "string"
  ) return false;
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as GoogleCredential;
  const token = credentials.refreshToken || credentials.accessToken;
  return token ? revokeGoogleToken(token) : false;
}

async function markGoogleReauthorizationRequired(
  connection: FirebaseFirestore.DocumentSnapshot,
  database: FirebaseFirestore.Firestore,
): Promise<void> {
  const capabilities = await connection.ref.collection("capabilities").get();
  const batch = database.batch();
  batch.set(connection.ref, {
    status: "attention",
    reauthorizationRequired: true,
    stats: {
      lastError: "Google Workspace access has expired. Reconnect the account to continue.",
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  for (const capability of capabilities.docs) {
    batch.set(capability.ref, {
      status: "reauthorization_required",
      stats: {
        lastError: "Google Workspace access has expired. Reconnect the account to continue.",
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

/** Resolve a usable token and prove the requested Workspace capability is active. */
export async function authorizedGoogleCapability(
  capabilityId: SourceCapabilityId,
  input: {
    companyId: string;
    connectionId: string;
    clientId: string;
    clientSecret: string;
    credentialKey: string;
    database?: FirebaseFirestore.Firestore;
  },
): Promise<{
  accessToken: string;
  connection: FirebaseFirestore.DocumentSnapshot;
  capability: FirebaseFirestore.DocumentSnapshot;
}> {
  const descriptor = capabilityDescriptor(capabilityId);
  const [connection, capability] = await Promise.all([
    connectionRef(input.companyId, input.connectionId, input.database || db).get(),
    capabilityConfigRef(
      input.companyId,
      input.connectionId,
      descriptor.serviceId,
      input.database || db,
    ).get(),
  ]);
  const data = connection.data();
  const capabilityData = capability.data();
  if (
    !connection.exists
    || data?.connectorId !== "google_workspace"
    || !["active", "attention"].includes(String(data?.status))
    || !capability.exists
    || capabilityData?.capabilityId !== capabilityId
    || !["active", "attention"].includes(String(capabilityData?.status))
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new Error(`Active ${descriptor.serviceId} capability not found`);
  }
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as GoogleCredential;
  const grantedScopes = new Set(credentials.scope.split(/\s+/).filter(Boolean));
  if (!descriptor.requiredScopes.every((scope) => grantedScopes.has(scope))) {
    throw new GoogleReauthorizationRequiredError(
      `Google Workspace ${descriptor.serviceId} permission is incomplete. Reconnect the account to continue.`,
    );
  }
  if (
    credentials.accessToken
    && Date.parse(credentials.expiresAt) > Date.now() + refreshSkewMs
  ) {
    return { accessToken: credentials.accessToken, connection, capability };
  }
  if (!credentials.refreshToken) throw new Error("Google refresh token is missing");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: credentials.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const refreshBody = await response.json() as GoogleTokens;
  if (!response.ok && isInvalidGrant(refreshBody)) {
    await markGoogleReauthorizationRequired(connection, input.database || db);
    throw new GoogleReauthorizationRequiredError();
  }

  const tokenBody = requireGoogleSuccess("Google Workspace", response, refreshBody);
  if (!tokenBody.access_token) throw new Error("Google access token refresh failed");
  const updated: GoogleCredential = {
    ...credentials,
    accessToken: tokenBody.access_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || credentials.scope,
  };
  await connection.ref.set({
    credentialCiphertext: encryptCredentials(updated, input.credentialKey),
    reauthorizationRequired: false,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { accessToken: updated.accessToken, connection, capability };
}
