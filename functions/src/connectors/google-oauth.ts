import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import {
  defaultGoogleRedirectUri,
  googleOAuthRedirectUri,
  googleOAuthReturnUrl,
} from "./google-oauth-return.js";

/**
 * The Google OAuth spine shared by every Google adapter.
 *
 * Calendar and Drive previously carried their own byte-identical copies of the
 * authorization, exchange, refresh, and revocation flows — to the point that
 * Drive imported a helper from Calendar. Adding a third Google source should
 * cost a scope list, an account-label lookup, and a `normalize`, not another
 * copy of this file.
 */

export type GoogleAdapterId = "google_calendar" | "google_drive";

/** One Google adapter's identity: what it is called and what it may read. */
export type GoogleConnector = {
  adapterId: GoogleAdapterId;
  displayName: string;
  scopes: readonly string[];
};

export type GoogleTokens = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type GoogleCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

// The consent warning for an unverified test app can require a manual handoff.
// Keep the state short-lived, but leave enough time for the user to review it.
export const googleAuthorizationLifetimeMs = 60 * 60 * 1000;

/** Refresh this long before expiry so an in-flight request cannot race it. */
const refreshSkewMs = 60_000;

export function connectionRef(companyId: string, connectionId: string) {
  return db.doc(companyDocumentPath(companyId, "connections", connectionId));
}

export function connectionCollection(companyId: string) {
  return db.collection(companyCollectionPath(companyId, "connections"));
}

export function requireGoogleSuccess<T>(
  label: string,
  response: Response,
  body: T & { error?: unknown },
): T {
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : JSON.stringify(body.error || body);
    throw new Error(`${label} API failed (${response.status}): ${message.slice(0, 1000)}`);
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
  return requireGoogleSuccess(label, response, await response.json() as T & { error?: unknown });
}

export async function revokeGoogleToken(token: string): Promise<boolean> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return true;
  // Google returns 400 when the token is already invalid or revoked. Either
  // way, it no longer grants this application access.
  if (response.status === 400) return false;
  throw new Error(`Google token revocation failed (${response.status})`);
}

/** Start an authorization: persist opaque state, then hand back the consent URL. */
export async function createGoogleAuthorization(
  connector: GoogleConnector,
  input: {
    companyId: string;
    uid: string;
    email: string;
    displayName: string;
    clientId: string;
    returnOrigin?: string;
  },
): Promise<{ authorizationUrl: string }> {
  const state = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const redirectUri = googleOAuthRedirectUri(input.returnOrigin);
  await db.doc(`oauthStates/${sha256Hex(state)}`).set({
    companyId: input.companyId,
    provider: connector.adapterId,
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
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: connector.scopes.join(" "),
    state,
  });
  return {
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
  };
}

/**
 * Complete an authorization: verify state, exchange the code, and store one
 * connection per provider account.
 *
 * `resolveAccountLabel` is the only adapter-specific step — Calendar reads the
 * primary calendar, Drive reads `about?fields=user`.
 */
export async function completeGoogleAuthorization(
  connector: GoogleConnector,
  input: {
    code: string;
    state: string;
    clientId: string;
    clientSecret: string;
    credentialKey: string;
    resolveAccountLabel: (accessToken: string) => Promise<string | null>;
  },
): Promise<{ connectionId: string }> {
  const stateRef = db.doc(`oauthStates/${sha256Hex(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp
    ? stateData.expiresAt.toMillis()
    : 0;
  if (
    !stateSnapshot.exists
    || stateData?.provider !== connector.adapterId
    || typeof stateData?.companyId !== "string"
    || expiresAt < Date.now()
  ) {
    throw new Error(`The ${connector.displayName} authorization request is invalid or expired`);
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
    connector.displayName,
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token || !tokenBody.refresh_token) {
    throw new Error("Google did not return the required offline refresh token");
  }

  const providerAccountId = String(
    await input.resolveAccountLabel(tokenBody.access_token)
    || stateData.email
    || `unknown ${connector.displayName} account`,
  );
  const companyId = String(stateData.companyId);
  const connections = connectionCollection(companyId);
  const existingConnections = await connections
    .where("adapterId", "==", connector.adapterId)
    .get();
  const existingConnection = existingConnections.docs.find(
    (document) => document.data().providerAccountId === providerAccountId,
  );
  const connection = existingConnection?.ref || connections.doc();
  const now = Timestamp.now();
  const credentials: GoogleCredential = {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || connector.scopes.join(" "),
  };
  const batch = db.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    companyId,
    adapterId: connector.adapterId,
    displayName: connector.displayName,
    accountLabel: providerAccountId,
    providerAccountId,
    status: "active",
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: connector.scopes,
    },
    credentialCiphertext: encryptCredentials(credentials, input.credentialKey),
    stats: { itemCount: 0, lastError: null },
    createdBy: existingConnection?.data().createdBy || stateData.uid,
    authorizedBy: {
      email: stateData.email || null,
      displayName: stateData.displayName || null,
    },
    ...(!existingConnection ? { createdAt: now } : { reauthorizedAt: now }),
    updatedAt: now,
  }, { merge: true });
  await batch.commit();
  return { connectionId: connection.id };
}

/** Revoke this connection's grant at Google. Safe to call on an absent connection. */
export async function revokeGoogleAuthorization(
  connector: GoogleConnector,
  input: {
    companyId: string;
    connectionId: string;
    credentialKey: string;
  },
): Promise<boolean> {
  const connection = await connectionRef(input.companyId, input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== connector.adapterId
    || typeof data.credentialCiphertext !== "string"
  ) return false;
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as GoogleCredential;
  const token = credentials.refreshToken || credentials.accessToken;
  return token ? revokeGoogleToken(token) : false;
}

/**
 * Resolve a usable access token for one connection, refreshing and re-encrypting
 * it when the stored token is at or near expiry.
 */
export async function authorizedGoogleConnection(
  connector: GoogleConnector,
  input: {
    companyId: string;
    connectionId: string;
    clientId: string;
    clientSecret: string;
    credentialKey: string;
  },
): Promise<{ accessToken: string; connection: FirebaseFirestore.DocumentSnapshot }> {
  const connection = await connectionRef(input.companyId, input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== connector.adapterId
    || !["active", "attention"].includes(String(data?.status))
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new Error(`Active ${connector.displayName} connection not found`);
  }
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as GoogleCredential;
  if (
    credentials.accessToken
    && Date.parse(credentials.expiresAt) > Date.now() + refreshSkewMs
  ) {
    return { accessToken: credentials.accessToken, connection };
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
  const tokenBody = requireGoogleSuccess(
    connector.displayName,
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token) throw new Error("Google access token refresh failed");
  const updated: GoogleCredential = {
    ...credentials,
    accessToken: tokenBody.access_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || credentials.scope,
  };
  await connection.ref.set({
    credentialCiphertext: encryptCredentials(updated, input.credentialKey),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { accessToken: updated.accessToken, connection };
}
