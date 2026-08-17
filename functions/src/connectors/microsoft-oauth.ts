import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import {
  microsoft365Capabilities,
  microsoft365CapabilityIds,
} from "./registry.js";
import type {
  OAuthAuthorizationState,
  OAuthRecoveryAction,
  SourceCapabilityId,
} from "./types.js";
import {
  defaultMicrosoftRedirectUri,
  microsoftOAuthRedirectUri,
  microsoftOAuthReturnUrl,
} from "./microsoft-oauth-return.js";

export const microsoftIdentityScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
] as const;

export const microsoftAuthorizationLifetimeMs = 60 * 60 * 1_000;
const refreshSkewMs = 60_000;
// `common` accepts both organizational Entra identities and personal Microsoft
// accounts. The validated `tid` + `oid` pair still provides the isolation key;
// personal accounts use Microsoft's well-known consumer tenant ID.
const commonAuthority = "https://login.microsoftonline.com/common";
const microsoftConsumerTenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";
const tenantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const microsoftJwks = createRemoteJWKSet(
  new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"),
);

type MicrosoftTokenBody = {
  token_type?: string;
  scope?: string;
  expires_in?: number;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
  error_codes?: number[];
  suberror?: string;
};

export type MicrosoftCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  accessTokenScopes: string;
  consentedScopes: string;
};

type MicrosoftIdentity = {
  tenantId: string;
  objectId: string;
  subject: string;
};

type MicrosoftMember = {
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
};

type MicrosoftUserInfo = {
  sub?: string;
};

export type MicrosoftAuthorizationIssue = {
  state: OAuthAuthorizationState;
  recoveryAction: OAuthRecoveryAction;
  code: string;
  message: string;
};

export type MicrosoftOAuthDependencies = {
  database?: FirebaseFirestore.Firestore;
  fetch?: typeof fetch;
  validateIdToken?: (input: {
    idToken: string;
    clientId: string;
    nonce: string;
  }) => Promise<MicrosoftIdentity>;
};

export class MicrosoftAuthorizationError extends Error {
  readonly issue: MicrosoftAuthorizationIssue;

  constructor(issue: MicrosoftAuthorizationIssue) {
    super(issue.message);
    this.name = "MicrosoftAuthorizationError";
    this.issue = issue;
  }
}

function normalizedScopes(scopes: readonly string[]): Set<string> {
  return new Set(scopes.map((scope) => scope
    .trim()
    .replace(/^https:\/\/graph\.microsoft\.com\//i, "")
    .toLocaleLowerCase()).filter(Boolean));
}

function splitScopes(scope?: string): string[] {
  return [...new Set((scope || "").split(/\s+/).map((value) => value.trim()).filter(Boolean))];
}

function unionScopes(...groups: readonly string[][]): string[] {
  const values = new Map<string, string>();
  for (const scope of groups.flat()) {
    const normalized = scope.toLocaleLowerCase();
    if (!values.has(normalized)) values.set(normalized, scope);
  }
  return [...values.values()];
}

function hasScopes(grantedScopes: readonly string[], requiredScopes: readonly string[]): boolean {
  const granted = normalizedScopes(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope.toLocaleLowerCase()));
}

export function microsoftScopesForCapabilities(
  capabilityIds: readonly SourceCapabilityId[],
): string[] {
  return unionScopes(
    [...microsoftIdentityScopes],
    capabilityIds.flatMap((id) => microsoft365Capabilities[
      id as keyof typeof microsoft365Capabilities
    ]?.requiredScopes || []),
  );
}

export function microsoftConnectionId(tenantId: string, objectId: string): string {
  return `microsoft_${sha256Hex(`${tenantId.toLocaleLowerCase()}:${objectId.toLocaleLowerCase()}`)
    .slice(0, 32)}`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function entraErrorCode(body: Pick<MicrosoftTokenBody, "error_codes" | "error_description">): string {
  const numeric = body.error_codes?.[0];
  if (numeric) return `AADSTS${numeric}`;
  return body.error_description?.match(/AADSTS\d+/i)?.[0]?.toUpperCase() || "";
}

export function classifyMicrosoftAuthorizationFailure(input: {
  error?: string;
  errorDescription?: string;
  errorCodes?: number[];
  suberror?: string;
}): MicrosoftAuthorizationIssue {
  const code = entraErrorCode({
    error_codes: input.errorCodes,
    error_description: input.errorDescription,
  }) || input.error || "MICROSOFT_AUTHORIZATION_FAILED";
  const numericCode = Number(code.replace(/^AADSTS/i, ""));
  if (numericCode === 65004 || input.suberror === "user_cancelled") {
    return {
      state: "consent_denied",
      recoveryAction: "retry",
      code,
      message: "Microsoft permission was declined. Retry when you are ready to grant it.",
    };
  }
  if ([65001, 65005, 650056].includes(numericCode)) {
    return {
      state: "admin_consent_required",
      recoveryAction: "ask_admin",
      code,
      message: "Your Microsoft tenant requires an administrator to approve this permission.",
    };
  }
  if ((numericCode >= 53000 && numericCode <= 53099) || input.error === "insufficient_claims") {
    return {
      state: "conditional_access",
      recoveryAction: "satisfy_policy",
      code,
      message: "Microsoft Conditional Access blocked this connection. Satisfy the tenant policy and retry.",
    };
  }
  if (numericCode === 700082) {
    return {
      state: "refresh_expired",
      recoveryAction: "reconnect",
      code,
      message: "Microsoft access expired. Reconnect the account to continue.",
    };
  }
  if (["invalid_grant", "interaction_required", "login_required"].includes(input.error || "")) {
    return {
      state: "revoked",
      recoveryAction: "reconnect",
      code,
      message: "Microsoft access was revoked or can no longer be refreshed. Reconnect the account.",
    };
  }
  return {
    state: "error",
    recoveryAction: "retry",
    code,
    message: "Microsoft could not complete the authorization. Retry or inspect the Entra sign-in log.",
  };
}

async function validateMicrosoftIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string;
}): Promise<MicrosoftIdentity> {
  const unverified = decodeJwt(input.idToken);
  const tenantId = typeof unverified.tid === "string" ? unverified.tid : "";
  if (!tenantIdPattern.test(tenantId)) {
    throw new Error("Microsoft returned an invalid tenant identity");
  }
  const { payload } = await jwtVerify(input.idToken, microsoftJwks, {
    audience: input.clientId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  });
  if (payload.nonce !== input.nonce) throw new Error("Microsoft OIDC nonce mismatch");
  const objectId = typeof payload.oid === "string" ? payload.oid : "";
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!objectId || !subject || payload.tid !== tenantId) {
    throw new Error("Microsoft returned an incomplete member identity");
  }
  return { tenantId, objectId, subject };
}

function microsoftConnectionRef(
  companyId: string,
  connectionId: string,
  database: FirebaseFirestore.Firestore,
) {
  return database.doc(`companies/${companyId}/connections/${connectionId}`);
}

export async function createMicrosoftAuthorization(input: {
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  credentialKey: string;
  capabilityIds?: SourceCapabilityId[];
  connectionId?: string;
  returnOrigin?: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ authorizationUrl: string }> {
  const database = input.database || db;
  const capabilityIds = [...new Set(input.capabilityIds || [])];
  if (!capabilityIds.every((id) => (
    microsoft365CapabilityIds as readonly SourceCapabilityId[]
  ).includes(id))) {
    throw new Error("Unsupported Microsoft 365 capability");
  }
  if (capabilityIds.length > 0 && !input.connectionId) {
    throw new Error("Connect the Microsoft account identity before granting Outlook access");
  }

  let loginHint = "";
  if (input.connectionId) {
    const existing = await microsoftConnectionRef(
      input.companyId,
      input.connectionId,
      database,
    ).get();
    if (!existing.exists || existing.data()?.connectorId !== "microsoft_365") {
      throw new Error("Microsoft 365 connection not found");
    }
    loginHint = String(existing.data()?.accountLabel || "");
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const now = Timestamp.now();
  const redirectUri = microsoftOAuthRedirectUri(input.returnOrigin);
  await database.doc(`oauthStates/${sha256Hex(state)}`).set({
    companyId: input.companyId,
    provider: "microsoft_365",
    requestedCapabilityIds: capabilityIds,
    connectionId: input.connectionId || null,
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    redirectUri,
    returnUrl: microsoftOAuthReturnUrl(input.returnOrigin),
    pkceCiphertext: encryptCredentials({ verifier, nonce }, input.credentialKey),
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + microsoftAuthorizationLifetimeMs),
  });

  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: microsoftScopesForCapabilities(capabilityIds).join(" "),
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: input.connectionId ? "consent" : "select_account",
  });
  if (loginHint) query.set("login_hint", loginHint);
  return {
    authorizationUrl: `${commonAuthority}/oauth2/v2.0/authorize?${query.toString()}`,
  };
}

async function microsoftGraphMember(
  accessToken: string,
  request: typeof fetch,
): Promise<MicrosoftMember> {
  const response = await request(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json() as MicrosoftMember & { error?: { message?: string } };
  if (!response.ok) {
    throw new MicrosoftGraphError(
      response.status,
      response.headers.get("www-authenticate") || "",
      body.error?.message || "unknown error",
    );
  }
  return body;
}

async function microsoftGraphUserInfo(
  accessToken: string,
  request: typeof fetch,
): Promise<MicrosoftUserInfo> {
  const response = await request("https://graph.microsoft.com/oidc/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as MicrosoftUserInfo & { error?: { message?: string } };
  if (!response.ok) {
    throw new MicrosoftGraphError(
      response.status,
      response.headers.get("www-authenticate") || "",
      body.error?.message || "unknown error",
    );
  }
  return body;
}

class MicrosoftGraphError extends Error {
  constructor(
    readonly status: number,
    readonly authenticate: string,
    message: string,
  ) {
    super(`Microsoft Graph identity failed (${status}): ${message}`);
    this.name = "MicrosoftGraphError";
  }
}

export async function completeMicrosoftAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  dependencies?: MicrosoftOAuthDependencies;
}): Promise<{
  connectionId: string;
  grantedCapabilityIds: SourceCapabilityId[];
  missingCapabilityIds: SourceCapabilityId[];
}> {
  const database = input.dependencies?.database || db;
  const request = input.dependencies?.fetch || fetch;
  const stateRef = database.doc(`oauthStates/${sha256Hex(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp ? stateData.expiresAt.toMillis() : 0;
  const requestedCapabilityIds = Array.isArray(stateData?.requestedCapabilityIds)
    ? stateData.requestedCapabilityIds.filter(
      (value): value is SourceCapabilityId => microsoft365CapabilityIds.includes(value),
    )
    : [];
  if (
    !stateSnapshot.exists
    || stateData?.provider !== "microsoft_365"
    || typeof stateData?.companyId !== "string"
    || typeof stateData?.pkceCiphertext !== "string"
    || expiresAt < Date.now()
  ) {
    throw new Error("The Microsoft authorization request is invalid or expired");
  }
  const pkce = decryptCredentials(stateData.pkceCiphertext, input.credentialKey);
  if (!pkce.verifier || !pkce.nonce) {
    throw new Error("The Microsoft PKCE authorization state is incomplete");
  }
  const response = await request(`${commonAuthority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: String(stateData.redirectUri || defaultMicrosoftRedirectUri),
      grant_type: "authorization_code",
      code_verifier: pkce.verifier,
      scope: microsoftScopesForCapabilities(requestedCapabilityIds).join(" "),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = await response.json() as MicrosoftTokenBody;
  if (!response.ok) {
    const issue = classifyMicrosoftAuthorizationFailure({
      error: tokenBody.error,
      errorDescription: tokenBody.error_description,
      errorCodes: tokenBody.error_codes,
      suberror: tokenBody.suberror,
    });
    await recordMicrosoftAuthorizationFailure({
      state: input.state,
      issue,
      database,
    });
    throw new MicrosoftAuthorizationError(issue);
  }
  if (!tokenBody.access_token || !tokenBody.id_token) {
    throw new Error("Microsoft did not return the required access and identity tokens");
  }

  const validate = input.dependencies?.validateIdToken || validateMicrosoftIdToken;
  const identity = await validate({
    idToken: tokenBody.id_token,
    clientId: input.clientId,
    nonce: pkce.nonce,
  });
  const [member, userInfo] = await Promise.all([
    microsoftGraphMember(tokenBody.access_token, request),
    microsoftGraphUserInfo(tokenBody.access_token, request),
  ]);
  if (!userInfo.sub || userInfo.sub !== identity.subject) {
    throw new Error("Microsoft Graph subject did not match the authenticated Microsoft identity");
  }
  const isConsumerIdentity = identity.tenantId.toLocaleLowerCase()
    === microsoftConsumerTenantId;
  if (
    !member.id
    || (!isConsumerIdentity
      && member.id.toLocaleLowerCase() !== identity.objectId.toLocaleLowerCase())
  ) {
    throw new Error("Microsoft Graph member did not match the authenticated Microsoft identity");
  }
  const accountLabel = member.mail || member.userPrincipalName;
  if (!accountLabel) throw new Error("Microsoft did not return a stable account label");

  const companyId = String(stateData.companyId);
  const connectionId = microsoftConnectionId(identity.tenantId, identity.objectId);
  if (stateData.connectionId && stateData.connectionId !== connectionId) {
    const issue: MicrosoftAuthorizationIssue = {
      state: "tenant_mismatch",
      recoveryAction: "choose_same_account",
      code: "MICROSOFT_TENANT_MISMATCH",
      message: "Choose the same Microsoft tenant and member when granting another capability.",
    };
    await recordMicrosoftAuthorizationFailure({ state: input.state, issue, database });
    throw new MicrosoftAuthorizationError(issue);
  }

  const connection = microsoftConnectionRef(companyId, connectionId, database);
  const existing = await connection.get();
  const existingData = existing.data();
  let existingCredential: MicrosoftCredential | null = null;
  if (typeof existingData?.credentialCiphertext === "string") {
    existingCredential = decryptCredentials(
      existingData.credentialCiphertext,
      input.credentialKey,
    ) as MicrosoftCredential;
  }
  const refreshToken = tokenBody.refresh_token || existingCredential?.refreshToken;
  if (!refreshToken) throw new Error("Microsoft did not return an offline refresh token");
  const accessTokenScopes = splitScopes(tokenBody.scope);
  const consentedScopes = unionScopes(
    splitScopes(existingCredential?.consentedScopes),
    accessTokenScopes,
  );
  const grantedCapabilityIds = requestedCapabilityIds.filter((capabilityId) => (
    hasScopes(
      accessTokenScopes,
      microsoft365Capabilities[capabilityId as keyof typeof microsoft365Capabilities].requiredScopes,
    )
  ));
  const missingCapabilityIds = requestedCapabilityIds.filter(
    (capabilityId) => !grantedCapabilityIds.includes(capabilityId),
  );
  const credential: MicrosoftCredential = {
    accessToken: tokenBody.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1_000).toISOString(),
    accessTokenScopes: accessTokenScopes.join(" "),
    consentedScopes: consentedScopes.join(" "),
  };
  const now = Timestamp.now();
  const existingCapabilities = new Map(await Promise.all(
    requestedCapabilityIds.map(async (capabilityId) => {
      const descriptor = microsoft365Capabilities[
        capabilityId as keyof typeof microsoft365Capabilities
      ];
      const snapshot = await connection.collection("capabilities").doc(descriptor.serviceId).get();
      return [capabilityId, snapshot.exists] as const;
    }),
  ));
  const batch = database.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    schemaVersion: 2,
    companyId,
    connectorId: "microsoft_365",
    providerId: "microsoft",
    providerAccountId: `${identity.tenantId}:${identity.objectId}`,
    tenantId: identity.tenantId,
    displayName: "Microsoft",
    accountLabel,
    member: {
      entraObjectId: identity.objectId,
      graphUserId: member.id,
      displayName: member.displayName || accountLabel,
      userPrincipalName: member.userPrincipalName || accountLabel,
    },
    status: missingCapabilityIds.length ? "attention" : "active",
    reauthorizationRequired: false,
    authorization: {
      state: "healthy",
      recoveryAction: "none",
      lastCheckedAt: now,
      lastErrorCode: null,
      lastError: null,
    },
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: consentedScopes,
    },
    credentialCiphertext: encryptCredentials(credential, input.credentialKey),
    credentialRevision: Number(existingData?.credentialRevision || 0) + 1,
    stats: {
      ...(existingData?.stats || {}),
      lastError: missingCapabilityIds.length
        ? "Microsoft did not grant every requested delegated permission"
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
    const descriptor = microsoft365Capabilities[
      capabilityId as keyof typeof microsoft365Capabilities
    ];
    const granted = grantedCapabilityIds.includes(capabilityId);
    batch.set(connection.collection("capabilities").doc(descriptor.serviceId), {
      capabilityId,
      serviceId: descriptor.serviceId,
      direction: descriptor.direction,
      status: granted ? "permission_granted" : "attention",
      grantedScopes: descriptor.requiredScopes.filter((scope) => hasScopes(accessTokenScopes, [scope])),
      requiredScopes: descriptor.requiredScopes,
      missingScopes: descriptor.requiredScopes.filter((scope) => !hasScopes(accessTokenScopes, [scope])),
      stats: granted ? { lastError: null } : {
        lastError: "Microsoft did not grant every required delegated permission",
      },
      ...(!existingCapabilities.get(capabilityId) ? { createdAt: now } : {}),
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();
  return { connectionId, grantedCapabilityIds, missingCapabilityIds };
}

export async function recordMicrosoftAuthorizationFailure(input: {
  state: string;
  issue: MicrosoftAuthorizationIssue;
  database?: FirebaseFirestore.Firestore;
}): Promise<void> {
  const database = input.database || db;
  const stateRef = database.doc(`oauthStates/${sha256Hex(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const requiresReconnect = [
    "conditional_access",
    "revoked",
    "refresh_expired",
    "tenant_mismatch",
  ].includes(input.issue.state);
  const batch = database.batch();
  batch.delete(stateRef);
  if (
    stateData?.provider === "microsoft_365"
    && typeof stateData.companyId === "string"
    && typeof stateData.connectionId === "string"
  ) {
    batch.set(
      microsoftConnectionRef(stateData.companyId, stateData.connectionId, database),
      {
        status: requiresReconnect ? "attention" : "active",
        reauthorizationRequired: requiresReconnect,
        authorization: {
          state: input.issue.state,
          recoveryAction: input.issue.recoveryAction,
          lastCheckedAt: FieldValue.serverTimestamp(),
          lastErrorCode: input.issue.code,
          lastError: input.issue.message,
        },
        stats: { lastError: input.issue.message },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const requestedCapabilityIds = Array.isArray(stateData.requestedCapabilityIds)
      ? stateData.requestedCapabilityIds.filter(
        (value): value is keyof typeof microsoft365Capabilities => (
          (microsoft365CapabilityIds as readonly unknown[]).includes(value)
        ),
      )
      : [];
    for (const capabilityId of requestedCapabilityIds) {
      const descriptor = microsoft365Capabilities[capabilityId];
      batch.set(
        microsoftConnectionRef(stateData.companyId, stateData.connectionId, database)
          .collection("capabilities").doc(descriptor.serviceId),
        {
          capabilityId,
          serviceId: descriptor.serviceId,
          direction: descriptor.direction,
          status: "attention",
          grantedScopes: [],
          requiredScopes: descriptor.requiredScopes,
          missingScopes: descriptor.requiredScopes,
          stats: { lastError: input.issue.message },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }
  await batch.commit();
}

async function markMicrosoftIssue(input: {
  connection: FirebaseFirestore.DocumentSnapshot;
  issue: MicrosoftAuthorizationIssue;
  database: FirebaseFirestore.Firestore;
}): Promise<void> {
  const requiresReconnect = input.issue.state !== "error";
  const capabilities = await input.connection.ref.collection("capabilities").get();
  const batch = input.database.batch();
  batch.set(input.connection.ref, {
    status: "attention",
    reauthorizationRequired: requiresReconnect,
    authorization: {
      state: input.issue.state,
      recoveryAction: input.issue.recoveryAction,
      lastCheckedAt: FieldValue.serverTimestamp(),
      lastErrorCode: input.issue.code,
      lastError: input.issue.message,
    },
    stats: { lastError: input.issue.message },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  for (const capability of requiresReconnect ? capabilities.docs : []) {
    if (capability.data().status === "disabled") continue;
    batch.set(capability.ref, {
      status: "reauthorization_required",
      stats: { lastError: input.issue.message },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

async function refreshMicrosoftCredential(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  requiredScopes?: string[];
  force?: boolean;
  dependencies?: Pick<MicrosoftOAuthDependencies, "database" | "fetch">;
  attempt?: number;
}): Promise<{ accessToken: string; connection: FirebaseFirestore.DocumentSnapshot }> {
  const database = input.dependencies?.database || db;
  const request = input.dependencies?.fetch || fetch;
  const connection = await microsoftConnectionRef(
    input.companyId,
    input.connectionId,
    database,
  ).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.connectorId !== "microsoft_365"
    || typeof data.credentialCiphertext !== "string"
  ) throw new Error("Microsoft 365 connection not found");
  const credential = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as MicrosoftCredential;
  const requiredScopes = input.requiredScopes || [];
  if (
    !input.force
    && Date.parse(credential.expiresAt) > Date.now() + refreshSkewMs
    && hasScopes(splitScopes(credential.accessTokenScopes), requiredScopes)
  ) return { accessToken: credential.accessToken, connection };

  const response = await request(
    `https://login.microsoftonline.com/${encodeURIComponent(String(data.tenantId))}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
        scope: unionScopes([...microsoftIdentityScopes], requiredScopes).join(" "),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const tokenBody = await response.json() as MicrosoftTokenBody;
  if (!response.ok) {
    const issue = classifyMicrosoftAuthorizationFailure({
      error: tokenBody.error,
      errorDescription: tokenBody.error_description,
      errorCodes: tokenBody.error_codes,
      suberror: tokenBody.suberror,
    });
    await markMicrosoftIssue({ connection, issue, database });
    throw new MicrosoftAuthorizationError(issue);
  }
  if (!tokenBody.access_token) throw new Error("Microsoft access-token refresh failed");
  const accessTokenScopes = splitScopes(tokenBody.scope);
  if (!hasScopes(accessTokenScopes, requiredScopes)) {
    const issue: MicrosoftAuthorizationIssue = {
      state: "admin_consent_required",
      recoveryAction: "ask_admin",
      code: "MICROSOFT_SCOPE_MISSING",
      message: "Microsoft did not issue every required delegated permission.",
    };
    await markMicrosoftIssue({ connection, issue, database });
    throw new MicrosoftAuthorizationError(issue);
  }
  const updated: MicrosoftCredential = {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token || credential.refreshToken,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1_000).toISOString(),
    accessTokenScopes: accessTokenScopes.join(" "),
    consentedScopes: unionScopes(
      splitScopes(credential.consentedScopes),
      accessTokenScopes,
    ).join(" "),
  };
  let stored = false;
  await database.runTransaction(async (transaction) => {
    const current = await transaction.get(connection.ref) as FirebaseFirestore.DocumentSnapshot;
    if (
      current.data()?.credentialCiphertext !== data.credentialCiphertext
      || Number(current.data()?.credentialRevision || 0) !== Number(data.credentialRevision || 0)
    ) return;
    transaction.set(connection.ref, {
      credentialCiphertext: encryptCredentials(updated, input.credentialKey),
      credentialRevision: Number(data.credentialRevision || 0) + 1,
      reauthorizationRequired: false,
      status: "active",
      authorization: {
        state: "healthy",
        recoveryAction: "none",
        lastCheckedAt: FieldValue.serverTimestamp(),
        lastErrorCode: null,
        lastError: null,
      },
      auth: { scopes: splitScopes(updated.consentedScopes) },
      stats: { ...(data.stats || {}), lastError: null },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    stored = true;
  });
  if (!stored) {
    if ((input.attempt || 0) >= 1) {
      throw new Error("Microsoft credential changed concurrently; retry the operation");
    }
    return refreshMicrosoftCredential({ ...input, attempt: (input.attempt || 0) + 1 });
  }
  return { accessToken: updated.accessToken, connection: await connection.ref.get() };
}

export async function refreshMicrosoftConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  dependencies?: Pick<MicrosoftOAuthDependencies, "database" | "fetch">;
}): Promise<{ ok: true; member: MicrosoftMember }> {
  const database = input.dependencies?.database || db;
  const request = input.dependencies?.fetch || fetch;
  const refreshed = await refreshMicrosoftCredential({ ...input, force: true });
  try {
    const member = await microsoftGraphMember(refreshed.accessToken, request);
    const storedMember = refreshed.connection.data()?.member;
    const expectedGraphUserId = String(
      storedMember?.graphUserId || storedMember?.entraObjectId || "",
    );
    if (!member.id || member.id.toLocaleLowerCase() !== expectedGraphUserId.toLocaleLowerCase()) {
      const issue: MicrosoftAuthorizationIssue = {
        state: "tenant_mismatch",
        recoveryAction: "choose_same_account",
        code: "MICROSOFT_MEMBER_MISMATCH",
        message: "Microsoft returned a different member than the tenant-bound connection.",
      };
      await markMicrosoftIssue({ connection: refreshed.connection, issue, database });
      throw new MicrosoftAuthorizationError(issue);
    }
    await refreshed.connection.ref.set({
      member: {
        entraObjectId: storedMember?.entraObjectId || member.id,
        graphUserId: member.id,
        displayName: member.displayName || member.userPrincipalName || member.id,
        userPrincipalName: member.userPrincipalName || member.mail || member.id,
      },
      accountLabel: member.mail || member.userPrincipalName || member.id,
      authorization: {
        state: "healthy",
        recoveryAction: "none",
        lastCheckedAt: FieldValue.serverTimestamp(),
        lastErrorCode: null,
        lastError: null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, member };
  } catch (error) {
    if (error instanceof MicrosoftAuthorizationError) throw error;
    const conditional = error instanceof MicrosoftGraphError
      && /insufficient_claims|claims=/i.test(error.authenticate);
    const rejected = error instanceof MicrosoftGraphError && error.status === 401;
    const issue: MicrosoftAuthorizationIssue = conditional
      ? {
        state: "conditional_access",
        recoveryAction: "satisfy_policy",
        code: "MICROSOFT_GRAPH_CLAIMS_CHALLENGE",
        message: "Microsoft Conditional Access requires an interactive policy check.",
      }
      : rejected
        ? {
          state: "revoked",
          recoveryAction: "reconnect",
          code: "MICROSOFT_GRAPH_UNAUTHORIZED",
          message: "Microsoft Graph rejected the delegated connection. Reconnect the account.",
        }
        : {
          state: "error",
          recoveryAction: "retry",
          code: "MICROSOFT_GRAPH_TEMPORARY_FAILURE",
          message: "Microsoft Graph could not be verified right now. Retry the health check.",
        };
    await markMicrosoftIssue({ connection: refreshed.connection, issue, database });
    throw new MicrosoftAuthorizationError(issue);
  }
}

export async function authorizedMicrosoftCapability(
  capabilityId: SourceCapabilityId,
  input: {
    companyId: string;
    connectionId: string;
    clientId: string;
    clientSecret: string;
    credentialKey: string;
    dependencies?: Pick<MicrosoftOAuthDependencies, "database" | "fetch">;
  },
): Promise<{ accessToken: string }> {
  if (!(microsoft365CapabilityIds as readonly SourceCapabilityId[]).includes(capabilityId)) {
    throw new Error("Unsupported Microsoft 365 capability");
  }
  const database = input.dependencies?.database || db;
  const descriptor = microsoft365Capabilities[
    capabilityId as keyof typeof microsoft365Capabilities
  ];
  const capability = await microsoftConnectionRef(
    input.companyId,
    input.connectionId,
    database,
  ).collection("capabilities").doc(descriptor.serviceId).get();
  if (
    !capability.exists
    || capability.data()?.capabilityId !== capabilityId
    || !["permission_granted", "active", "attention"].includes(String(capability.data()?.status))
  ) throw new Error(`Microsoft ${descriptor.serviceId} permission is not enabled`);
  return refreshMicrosoftCredential({
    ...input,
    requiredScopes: descriptor.requiredScopes,
  });
}
