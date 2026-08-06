import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFirestore } from "./firestore-harness.js";
import { sha256Hex } from "../hash.js";
import {
  authorizedSlackNotify,
  completeSlackAuthorization,
  createSlackAuthorization,
  slackConnectionId,
  SlackAuthorizationError,
  SlackNotifyGrantMissingError,
} from "../connectors/slack-oauth.js";
import { connectorCatalog } from "../connectors/registry.js";

const companyId = "company-1";
const credentialKey = Buffer.alloc(32, 7).toString("base64");
const teamId = "T0BNLUMR4PK";
const botToken = "xoxb-test-token";

function stubSlackOAuth(respond: () => { status: number; body: unknown }): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const { status, body } = respond();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function startAuthorization(memory: MemoryFirestore): Promise<string> {
  const { authorizationUrl } = await createSlackAuthorization({
    companyId,
    uid: "member-1",
    email: "tom@acme.cz",
    displayName: "Tomáš",
    clientId: "client-id",
    database: memory.asFirestore(),
  });
  return new URL(authorizationUrl).searchParams.get("state") || "";
}

test("the install asks for two bot scopes and nothing on behalf of a person", async () => {
  const memory = new MemoryFirestore();
  const { authorizationUrl } = await createSlackAuthorization({
    companyId,
    uid: "member-1",
    email: "tom@acme.cz",
    displayName: "Tomáš",
    clientId: "client-id",
    database: memory.asFirestore(),
  });
  const url = new URL(authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(url.searchParams.get("scope"), "chat:write,channels:read");
  assert.equal(
    url.searchParams.get("user_scope"),
    null,
    "Erik never acts as the installing person",
  );
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://odorik-tx-260720-c58d.web.app/oauth/slack/callback",
    "must match a URL registered on the Slack app",
  );

  const state = url.searchParams.get("state") || "";
  assert.ok(state.length >= 32, "state must be unguessable");
  const stored = memory.read(`oauthStates/${sha256Hex(state)}`);
  assert.equal(stored?.provider, "slack");
  assert.equal(
    memory.read(`oauthStates/${state}`),
    undefined,
    "only the hash of the state is stored",
  );
});

test("an installed workspace stores an encrypted envelope and an active grant", async () => {
  const memory = new MemoryFirestore();
  const state = await startAuthorization(memory);
  const restore = stubSlackOAuth(() => ({
    status: 200,
    body: {
      ok: true,
      access_token: botToken,
      scope: "chat:write,channels:read",
      bot_user_id: "U123",
      team: { id: teamId, name: "Headstart" },
    },
  }));
  try {
    const result = await completeSlackAuthorization({
      code: "code-1",
      state,
      clientId: "client-id",
      clientSecret: "client-secret",
      credentialKey,
      database: memory.asFirestore(),
    });
    assert.equal(result.connectionId, slackConnectionId(teamId));
    assert.equal(result.teamName, "Headstart");

    const connectionPath = `companies/${companyId}/connections/${result.connectionId}`;
    const connection = memory.read(connectionPath);
    assert.equal(connection?.connectorId, "slack");
    assert.equal(connection?.providerAccountId, teamId);
    assert.equal(connection?.status, "active");
    assert.equal(
      JSON.stringify(connection).includes(botToken),
      false,
      "the bot token must never be readable on the connection document",
    );

    const capability = memory.read(`${connectionPath}/capabilities/chat_notify`);
    assert.equal(capability?.capabilityId, "action.chat.notify");
    assert.equal(capability?.status, "active");
    assert.deepEqual(capability?.missingScopes, []);

    assert.equal(
      memory.read(`oauthStates/${sha256Hex(state)}`),
      undefined,
      "a consumed state cannot be replayed",
    );
  } finally {
    restore();
  }
});

test("a partial grant is recorded as attention rather than silently accepted", async () => {
  const memory = new MemoryFirestore();
  const state = await startAuthorization(memory);
  const restore = stubSlackOAuth(() => ({
    status: 200,
    body: {
      ok: true,
      access_token: botToken,
      scope: "chat:write",
      team: { id: teamId, name: "Headstart" },
    },
  }));
  try {
    const result = await completeSlackAuthorization({
      code: "code-1",
      state,
      clientId: "client-id",
      clientSecret: "client-secret",
      credentialKey,
      database: memory.asFirestore(),
    });
    const connectionPath = `companies/${companyId}/connections/${result.connectionId}`;
    assert.equal(memory.read(connectionPath)?.status, "attention");
    const capability = memory.read(`${connectionPath}/capabilities/chat_notify`);
    assert.equal(capability?.status, "attention");
    assert.deepEqual(capability?.missingScopes, ["channels:read"]);
  } finally {
    restore();
  }
});

test("ok:false on an HTTP 200 fails the install", async () => {
  const memory = new MemoryFirestore();
  const state = await startAuthorization(memory);
  const restore = stubSlackOAuth(() => ({
    status: 200,
    body: { ok: false, error: "invalid_code" },
  }));
  try {
    await assert.rejects(
      () => completeSlackAuthorization({
        code: "bad",
        state,
        clientId: "client-id",
        clientSecret: "client-secret",
        credentialKey,
        database: memory.asFirestore(),
      }),
      SlackAuthorizationError,
    );
    assert.equal(
      memory.read(`companies/${companyId}/connections/${slackConnectionId(teamId)}`),
      undefined,
      "a rejected install leaves no connection behind",
    );
  } finally {
    restore();
  }
});

test("an unknown or expired state is refused before any token exchange", async () => {
  const memory = new MemoryFirestore();
  let called = false;
  const restore = stubSlackOAuth(() => {
    called = true;
    return { status: 200, body: { ok: true } };
  });
  try {
    await assert.rejects(
      () => completeSlackAuthorization({
        code: "code-1",
        state: "never-issued",
        clientId: "client-id",
        clientSecret: "client-secret",
        credentialKey,
        database: memory.asFirestore(),
      }),
      SlackAuthorizationError,
    );
    assert.equal(called, false, "an unverified callback must not reach Slack");
  } finally {
    restore();
  }
});

test("the notify grant is proven before a token is handed out", async () => {
  const memory = new MemoryFirestore();
  const state = await startAuthorization(memory);
  const restore = stubSlackOAuth(() => ({
    status: 200,
    body: {
      ok: true,
      access_token: botToken,
      scope: "chat:write,channels:read",
      team: { id: teamId, name: "Headstart" },
    },
  }));
  let connectionId = "";
  try {
    connectionId = (await completeSlackAuthorization({
      code: "code-1",
      state,
      clientId: "client-id",
      clientSecret: "client-secret",
      credentialKey,
      database: memory.asFirestore(),
    })).connectionId;
  } finally {
    restore();
  }

  const authorized = await authorizedSlackNotify({
    companyId,
    connectionId,
    credentialKey,
    database: memory.asFirestore(),
  });
  assert.equal(authorized.botToken, botToken);
  assert.equal(authorized.teamId, teamId);

  await assert.rejects(
    () => authorizedSlackNotify({
      companyId,
      connectionId: "slack_missing",
      credentialKey,
      database: memory.asFirestore(),
    }),
    SlackNotifyGrantMissingError,
  );

  memory.seed(
    `companies/${companyId}/connections/${connectionId}/capabilities/chat_notify`,
    { capabilityId: "action.chat.notify", status: "disabled" },
  );
  await assert.rejects(
    () => authorizedSlackNotify({
      companyId,
      connectionId,
      credentialKey,
      database: memory.asFirestore(),
    }),
    SlackNotifyGrantMissingError,
    "a disabled capability cannot post",
  );
});

test("the catalog offers Slack as a write-only notifier", () => {
  const slack = connectorCatalog().find((connector) => connector.id === "slack");
  assert.ok(slack, "Slack must appear in the connector catalog");
  assert.deepEqual(
    slack.capabilities.map((capability) => capability.id),
    ["action.chat.notify"],
    "H1 grants no reading capability of any kind",
  );
  const notify = slack.capabilities[0];
  assert.equal(notify?.direction, "act");
  assert.equal(notify?.resourceType, "channel");
  assert.deepEqual(notify?.requiredScopes, ["chat:write", "channels:read"]);
});
