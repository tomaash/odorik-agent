import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredentials } from "../connectors/credentials.js";
import {
  classifyMicrosoftAuthorizationFailure,
  completeMicrosoftAuthorization,
  createMicrosoftAuthorization,
  microsoftConnectionId,
  refreshMicrosoftConnection,
  type MicrosoftCredential,
} from "../connectors/microsoft-oauth.js";
import {
  deleteSourceConnection,
  listSources,
  prepareConnectionDeletion,
  setCapabilityStatus,
} from "../connectors/repository.js";
import { sha256Hex } from "../hash.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "company-1";
const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const objectId = "11111111-2222-4333-8444-555555555555";
const credentialKey = Buffer.alloc(32, 9).toString("base64");
const clientId = "microsoft-client-id";
const clientSecret = "microsoft-client-secret";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oauthDependencies(
  memory: MemoryFirestore,
  tokenBody: Record<string, unknown>,
  calls: Array<{ url: string; body: string }> = [],
  member: Record<string, unknown> = {
    id: objectId,
    displayName: "Ada Lovelace",
    mail: "ada@acme.example",
    userPrincipalName: "ada@acme.example",
  },
) {
  return {
    database: memory.asFirestore(),
    validateIdToken: async ({ nonce }: { nonce: string }) => {
      assert.ok(nonce.length >= 32);
      return { tenantId, objectId, subject: "pairwise-subject" };
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      calls.push({ url: value, body: String(init?.body || "") });
      if (value.includes("/token")) return jsonResponse(tokenBody);
      if (value === "https://graph.microsoft.com/oidc/userinfo") {
        return jsonResponse({ sub: "pairwise-subject" });
      }
      if (value.startsWith("https://graph.microsoft.com/v1.0/me")) {
        return jsonResponse(member);
      }
      throw new Error(`Unexpected Microsoft request ${value}`);
    }) as typeof fetch,
  };
}

async function start(
  memory: MemoryFirestore,
  capabilityIds: Array<"context.mail.read_scoped" | "action.mail.draft.create"> = [],
  connectionId?: string,
) {
  const result = await createMicrosoftAuthorization({
    companyId,
    uid: "admin-1",
    email: "admin@acme.example",
    displayName: "Admin",
    clientId,
    credentialKey,
    capabilityIds,
    connectionId,
    database: memory.asFirestore(),
  });
  const url = new URL(result.authorizationUrl);
  return { url, state: url.searchParams.get("state") || "" };
}

async function completeIdentity(memory: MemoryFirestore, refreshToken = "refresh-initial") {
  const { state } = await start(memory);
  return completeMicrosoftAuthorization({
    code: "authorization-code",
    state,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: oauthDependencies(memory, {
      access_token: "access-initial",
      refresh_token: refreshToken,
      id_token: "test-id-token",
      expires_in: 3600,
      scope: "openid profile email offline_access User.Read",
    }),
  });
}

test("Microsoft identity authorization uses PKCE, nonce, offline access, and no mail grant", async () => {
  const memory = new MemoryFirestore();
  const { url, state } = await start(memory);
  assert.equal(
    url.origin + url.pathname,
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") || "").length >= 40);
  assert.ok((url.searchParams.get("nonce") || "").length >= 32);
  const scopes = url.searchParams.get("scope")?.split(" ") || [];
  assert.ok(scopes.includes("offline_access"));
  assert.ok(scopes.includes("User.Read"));
  assert.equal(scopes.some((scope) => scope.startsWith("Mail.")), false);
  assert.equal(scopes.includes("Mail.Send"), false);

  const storedState = memory.read(`oauthStates/${sha256Hex(state)}`);
  assert.equal(storedState?.provider, "microsoft_365");
  assert.equal(typeof storedState?.pkceCiphertext, "string");
  assert.equal(JSON.stringify(storedState).includes(url.searchParams.get("nonce") || ""), false);
  assert.equal(memory.read(`oauthStates/${state}`), undefined);

  const result = await completeIdentity(memory);
  const connectionPath = `companies/${companyId}/connections/${result.connectionId}`;
  const connection = memory.read(connectionPath);
  assert.equal(result.connectionId, microsoftConnectionId(tenantId, objectId));
  assert.equal(connection?.tenantId, tenantId);
  assert.equal((connection?.member as Record<string, unknown>)?.entraObjectId, objectId);
  assert.equal((connection?.member as Record<string, unknown>)?.graphUserId, objectId);
  assert.equal((connection?.authorization as Record<string, unknown>)?.state, "healthy");
  assert.equal(connection?.status, "active");
  assert.equal(memory.list(`${connectionPath}/capabilities`).length, 0);
  assert.equal(JSON.stringify(connection).includes("access-initial"), false);
  assert.equal(JSON.stringify(connection).includes("refresh-initial"), false);
});

test("personal Microsoft accounts use the consumer tenant identity and may omit userPrincipalName", async () => {
  const memory = new MemoryFirestore();
  const consumerTenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const graphUserId = "consumer-graph-user-id";
  const { state } = await start(memory);
  const result = await completeMicrosoftAuthorization({
    code: "consumer-authorization-code",
    state,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: {
      database: memory.asFirestore(),
      validateIdToken: async () => ({
        tenantId: consumerTenantId,
        objectId,
        subject: "consumer-pairwise-subject",
      }),
      fetch: (async (url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/token")) return jsonResponse({
          access_token: "consumer-access",
          refresh_token: "consumer-refresh",
          id_token: "consumer-id-token",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read",
        });
        if (value === "https://graph.microsoft.com/oidc/userinfo") {
          return jsonResponse({ sub: "consumer-pairwise-subject" });
        }
        if (value.startsWith("https://graph.microsoft.com/v1.0/me")) return jsonResponse({
          id: graphUserId,
          displayName: "Tomáš Holas",
          mail: "tomas.holas@gmail.com",
        });
        throw new Error(`Unexpected Microsoft request ${value}`);
      }) as typeof fetch,
    },
  });
  const connection = memory.read(
    `companies/${companyId}/connections/${result.connectionId}`,
  );
  assert.equal(result.connectionId, microsoftConnectionId(consumerTenantId, objectId));
  assert.equal(connection?.tenantId, consumerTenantId);
  assert.equal(connection?.accountLabel, "tomas.holas@gmail.com");
  assert.equal((connection?.member as Record<string, unknown>)?.entraObjectId, objectId);
  assert.equal((connection?.member as Record<string, unknown>)?.graphUserId, graphUserId);
  assert.equal(
    (connection?.member as Record<string, unknown>)?.userPrincipalName,
    "tomas.holas@gmail.com",
  );

  await refreshMicrosoftConnection({
    companyId,
    connectionId: result.connectionId,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: {
      database: memory.asFirestore(),
      fetch: (async (url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/token")) return jsonResponse({
          access_token: "consumer-refreshed-access",
          refresh_token: "consumer-refreshed-token",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read",
        });
        if (value.startsWith("https://graph.microsoft.com/v1.0/me")) return jsonResponse({
          id: graphUserId,
          displayName: "Tomáš Holas",
          mail: "tomas.holas@gmail.com",
        });
        throw new Error(`Unexpected Microsoft request ${value}`);
      }) as typeof fetch,
    },
  });
  const refreshed = memory.read(
    `companies/${companyId}/connections/${result.connectionId}`,
  );
  assert.equal((refreshed?.member as Record<string, unknown>)?.entraObjectId, objectId);
  assert.equal((refreshed?.member as Record<string, unknown>)?.graphUserId, graphUserId);
});

test("Microsoft rejects an access token whose OIDC subject differs from the ID token", async () => {
  const memory = new MemoryFirestore();
  const { state } = await start(memory);
  await assert.rejects(() => completeMicrosoftAuthorization({
    code: "mixed-subject-code",
    state,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: {
      ...oauthDependencies(memory, {
        access_token: "mixed-access",
        refresh_token: "mixed-refresh",
        id_token: "mixed-id-token",
        expires_in: 3600,
        scope: "openid profile email offline_access User.Read",
      }),
      fetch: (async (url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/token")) return jsonResponse({
          access_token: "mixed-access",
          refresh_token: "mixed-refresh",
          id_token: "mixed-id-token",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read",
        });
        if (value === "https://graph.microsoft.com/oidc/userinfo") {
          return jsonResponse({ sub: "different-pairwise-subject" });
        }
        if (value.startsWith("https://graph.microsoft.com/v1.0/me")) return jsonResponse({
          id: objectId,
          displayName: "Ada Lovelace",
          mail: "ada@acme.example",
        });
        throw new Error(`Unexpected Microsoft request ${value}`);
      }) as typeof fetch,
    },
  }), /subject did not match/);
});

test("Outlook permissions are incremental, provider-specific, and never include Mail.Send", async () => {
  const memory = new MemoryFirestore();
  const identity = await completeIdentity(memory);
  const calls: Array<{ url: string; body: string }> = [];
  const { url, state } = await start(
    memory,
    ["action.mail.draft.create"],
    identity.connectionId,
  );
  const requestedScopes = url.searchParams.get("scope")?.split(" ") || [];
  assert.ok(requestedScopes.includes("Mail.ReadWrite"));
  assert.equal(requestedScopes.includes("Mail.Read"), false);
  assert.equal(requestedScopes.includes("Mail.Send"), false);

  const result = await completeMicrosoftAuthorization({
    code: "draft-code",
    state,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: oauthDependencies(memory, {
      access_token: "access-draft",
      refresh_token: "refresh-draft",
      id_token: "test-id-token",
      expires_in: 3600,
      scope: "openid profile email offline_access User.Read Mail.ReadWrite",
    }, calls),
  });
  assert.deepEqual(result.grantedCapabilityIds, ["action.mail.draft.create"]);
  const connectionPath = `companies/${companyId}/connections/${identity.connectionId}`;
  const capability = memory.read(`${connectionPath}/capabilities/mail_draft`);
  assert.equal(capability?.status, "permission_granted");
  assert.deepEqual(capability?.requiredScopes, ["Mail.ReadWrite"]);
  assert.equal(JSON.stringify(memory.read(connectionPath)).includes("Mail.Send"), false);
  const tokenRequest = new URLSearchParams(calls.find((call) => call.url.includes("/token"))?.body);
  assert.equal(
    new URL(String(calls.find((call) => call.url.includes("/token"))?.url)).pathname,
    "/common/oauth2/v2.0/token",
  );
  assert.ok(tokenRequest.get("code_verifier"));

  await setCapabilityStatus({
    companyId,
    connectionId: identity.connectionId,
    capabilityId: "action.mail.draft.create",
    enabled: false,
    actorUid: "admin-1",
  }, memory.asFirestore());
  assert.equal(memory.read(`${connectionPath}/capabilities/mail_draft`)?.status, "disabled");
  await setCapabilityStatus({
    companyId,
    connectionId: identity.connectionId,
    capabilityId: "action.mail.draft.create",
    enabled: true,
    actorUid: "admin-1",
  }, memory.asFirestore());
  assert.equal(
    memory.read(`${connectionPath}/capabilities/mail_draft`)?.status,
    "permission_granted",
  );
});

test("health refresh atomically replaces the Microsoft refresh token and verifies the bound member", async () => {
  const memory = new MemoryFirestore();
  const identity = await completeIdentity(memory, "refresh-old");
  const calls: Array<{ url: string; body: string }> = [];
  const dependencies = oauthDependencies(memory, {
    access_token: "access-rotated",
    refresh_token: "refresh-new",
    expires_in: 3600,
    scope: "openid profile email offline_access User.Read",
  }, calls);
  await refreshMicrosoftConnection({
    companyId,
    connectionId: identity.connectionId,
    clientId,
    clientSecret,
    credentialKey,
    dependencies,
  });
  const connection = memory.read(
    `companies/${companyId}/connections/${identity.connectionId}`,
  );
  const credential = decryptCredentials(
    String(connection?.credentialCiphertext),
    credentialKey,
  ) as MicrosoftCredential;
  assert.equal(credential.refreshToken, "refresh-new");
  assert.equal(credential.accessToken, "access-rotated");
  assert.equal(JSON.stringify(connection).includes("refresh-old"), false);
  assert.equal(connection?.credentialRevision, 2);
  assert.equal((connection?.authorization as Record<string, unknown>)?.state, "healthy");
  const refreshRequest = new URLSearchParams(calls[0]?.body);
  assert.equal(refreshRequest.get("refresh_token"), "refresh-old");
  assert.equal(refreshRequest.get("scope")?.includes("Mail.Send"), false);
});

test("an expired Microsoft refresh grant fails closed and is public without exposing credentials", async () => {
  const memory = new MemoryFirestore();
  const identity = await completeIdentity(memory, "refresh-private");
  await assert.rejects(() => refreshMicrosoftConnection({
    companyId,
    connectionId: identity.connectionId,
    clientId,
    clientSecret,
    credentialKey,
    dependencies: {
      database: memory.asFirestore(),
      fetch: (async () => jsonResponse({
        error: "invalid_grant",
        error_description: "AADSTS700082: Refresh token expired",
        error_codes: [700082],
      }, 400)) as typeof fetch,
    },
  }), /expired/i);
  const publicConnection = (await listSources(companyId, memory.asFirestore())).connections[0];
  assert.equal(publicConnection?.status, "attention");
  assert.equal(publicConnection?.reauthorizationRequired, true);
  assert.equal(publicConnection?.authorization?.state, "refresh_expired");
  assert.equal(publicConnection?.authorization?.recoveryAction, "reconnect");
  assert.equal(JSON.stringify(publicConnection).includes("refresh-private"), false);
});

test("Microsoft failures map to explicit recovery states", () => {
  assert.deepEqual(
    classifyMicrosoftAuthorizationFailure({
      error: "access_denied",
      errorDescription: "AADSTS65004: User declined consent",
    }).state,
    "consent_denied",
  );
  assert.deepEqual(
    classifyMicrosoftAuthorizationFailure({
      error: "invalid_grant",
      errorDescription: "AADSTS700082: Refresh token expired",
    }).state,
    "refresh_expired",
  );
  assert.deepEqual(
    classifyMicrosoftAuthorizationFailure({
      error: "access_denied",
      errorDescription: "AADSTS53003: Blocked by Conditional Access",
    }).recoveryAction,
    "satisfy_policy",
  );
  assert.deepEqual(
    classifyMicrosoftAuthorizationFailure({
      error: "invalid_grant",
      errorDescription: "AADSTS65001: Admin consent is required",
    }).recoveryAction,
    "ask_admin",
  );
});

test("the same Microsoft identity remains isolated by company and disconnect deletes local tokens", async () => {
  const first = new MemoryFirestore();
  const firstIdentity = await completeIdentity(first);
  const firstConnectionPath = `companies/${companyId}/connections/${firstIdentity.connectionId}`;
  first.seed(`companies/company-2/connections/${firstIdentity.connectionId}`, {
    companyId: "company-2",
    connectorId: "microsoft_365",
    providerId: "microsoft",
    tenantId,
    providerAccountId: `${tenantId}:${objectId}`,
    displayName: "Microsoft 365",
    status: "active",
    credentialCiphertext: "other-company-secret",
  });
  const prepared = await prepareConnectionDeletion(
    companyId,
    firstIdentity.connectionId,
    "admin-1",
    first.asFirestore(),
  );
  await deleteSourceConnection({
    companyId,
    connectionId: firstIdentity.connectionId,
    actorUid: "admin-1",
    ...prepared,
    providerAccessRevoked: null,
  }, first.asFirestore());
  assert.equal(first.read(firstConnectionPath), undefined);
  assert.equal(
    first.read(`companies/company-2/connections/${firstIdentity.connectionId}`)?.credentialCiphertext,
    "other-company-secret",
  );
});
