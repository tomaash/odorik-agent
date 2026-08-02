import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  getGrokAuthorization,
  processGrokAuthCallback,
  startGrokAuthorization,
  type GrokAuthJobExecutor,
} from "../connectors/grok-subscription.js";
import { listSources, setConnectionStatus } from "../connectors/repository.js";
import { MemoryFirestore } from "./firestore-harness.js";

const now = Timestamp.fromDate(new Date("2026-08-01T08:00:00.000Z"));
const afterDevice = Timestamp.fromDate(new Date("2026-08-01T08:01:00.000Z"));
const afterCompletion = Timestamp.fromDate(new Date("2026-08-01T08:02:00.000Z"));

function executor(calls: Array<Record<string, unknown>>): GrokAuthJobExecutor {
  return async (input) => {
    calls.push(input);
    return { operationName: "operations/grok-auth-1" };
  };
}

test("Grok device authorization is tenant-routed and exposes only short-lived public state", async () => {
  const memory = new MemoryFirestore();
  const calls: Array<Record<string, unknown>> = [];
  const started = await startGrokAuthorization({
    companyId: "explorers",
    actorUid: "admin-1",
    action: "connect",
    executeJob: executor(calls),
    database: memory.asFirestore(),
    now,
  });
  assert.match(started.sessionId, /^grok_[a-f0-9]{32}$/);
  assert.equal(started.status, "starting");
  assert.deepEqual(calls, [{
    action: "connect",
    sessionId: started.sessionId,
    secretName: "grok-subscription-auth",
  }]);
  const connectionPath = "companies/explorers/connections/grok_subscription";
  assert.equal(memory.read(connectionPath)?.status, "configuring");
  const configuringAuth = memory.read(connectionPath)?.auth as Record<string, unknown>;
  assert.equal(configuringAuth.kind, "subscription_oauth");
  assert.equal(configuringAuth.credentialMode, "managed_secret");

  await processGrokAuthCallback({
    body: {
      type: "device",
      sessionId: started.sessionId,
      verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    },
    database: memory.asFirestore(),
    now: afterDevice,
  });
  const waiting = await getGrokAuthorization({
    companyId: "explorers",
    sessionId: started.sessionId,
    database: memory.asFirestore(),
    now: afterDevice,
  });
  assert.deepEqual({
    action: waiting.action,
    status: waiting.status,
    verificationUri: waiting.verificationUri,
    userCode: waiting.userCode,
    error: waiting.error,
  }, {
    action: "connect",
    status: "waiting_for_user",
    verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
    userCode: "ABCD-1234",
    error: null,
  });

  await processGrokAuthCallback({
    body: {
      type: "completed",
      action: "connect",
      sessionId: started.sessionId,
      secretVersion: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/7",
      accountLabel: "operator@example.com",
      principalId: "principal-1",
      teamId: "team-1",
      expiresAt: "2026-08-02T08:00:00.000Z",
    },
    database: memory.asFirestore(),
    now: afterCompletion,
  });
  await processGrokAuthCallback({
    body: {
      type: "completed",
      action: "connect",
      sessionId: started.sessionId,
      secretVersion: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/7",
      accountLabel: "operator@example.com",
      principalId: "principal-1",
    },
    database: memory.asFirestore(),
    now: afterCompletion,
  });
  assert.equal(memory.read(connectionPath)?.status, "active");
  assert.equal(memory.read(connectionPath)?.accountLabel, "operator@example.com");
  const activeSubscription = memory.read(connectionPath)?.subscription as Record<string, unknown>;
  assert.equal(activeSubscription.state, "active");
  assert.equal(memory.list("companies/explorers/auditEvents").filter(
    (event) => event.eventType === "source.grok_authorization_completed",
  ).length, 1);

  const sources = await listSources("explorers", memory.asFirestore());
  const publicConnection = sources.connections.find(
    (connection) => connection.connectorId === "grok_subscription",
  );
  assert.ok(publicConnection);
  assert.equal(publicConnection.providerId, "grok");
  assert.equal(publicConnection.authKind, "subscription_oauth");
  assert.equal(publicConnection.credentialMode, "managed_secret");
  assert.equal(publicConnection.subscription?.state, "active");
  assert.equal(publicConnection.subscription?.teamId, "team-1");
  const publicJson = JSON.stringify(sources);
  assert.doesNotMatch(publicJson, /grok-subscription-auth/);
  assert.doesNotMatch(publicJson, /operations\/grok-auth/);
  assert.doesNotMatch(publicJson, /versions\/7/);
  assert.doesNotMatch(publicJson, /refresh_token/);
});

test("Grok disconnect disables runtime use through the worker state machine", async () => {
  const memory = new MemoryFirestore();
  const connectionPath = "companies/explorers/connections/grok_subscription";
  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "grok_subscription",
    providerId: "grok",
    status: "active",
    accountLabel: "operator@example.com",
    auth: { kind: "subscription_oauth", credentialMode: "managed_secret", scopes: [] },
    credentialRef: {
      provider: "secret_manager",
      secretName: "grok-subscription-auth",
      version: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/7",
    },
    subscription: { state: "active" },
    createdAt: now,
  });
  memory.seed("grokSubscriptionSecrets/grok-subscription-auth", {
    companyId: "explorers",
    connectionId: "grok_subscription",
    secretName: "grok-subscription-auth",
    createdAt: now,
  });
  const started = await startGrokAuthorization({
    companyId: "explorers",
    actorUid: "admin-1",
    action: "disconnect",
    executeJob: executor([]),
    database: memory.asFirestore(),
    now,
  });
  await processGrokAuthCallback({
    body: {
      type: "completed",
      action: "disconnect",
      sessionId: started.sessionId,
      destroyedVersions: 1,
    },
    database: memory.asFirestore(),
    now: afterCompletion,
  });
  assert.equal(memory.read(connectionPath)?.status, "disconnected");
  const disconnected = memory.read(connectionPath) || {};
  const disconnectedSubscription = disconnected.subscription as Record<string, unknown>;
  const disconnectedCredential = disconnected.credentialRef as Record<string, unknown>;
  assert.equal(disconnectedSubscription.state, "disconnected");
  assert.equal(disconnectedCredential.version, null);
  await assert.rejects(() => setConnectionStatus(
    "explorers",
    "grok_subscription",
    "active",
    "admin-1",
    memory.asFirestore(),
  ), /isolated authorization worker/);
});

test("Grok secret ownership and callback routing fail closed across companies", async () => {
  const memory = new MemoryFirestore();
  const first = await startGrokAuthorization({
    companyId: "explorers",
    actorUid: "admin-1",
    action: "connect",
    executeJob: executor([]),
    database: memory.asFirestore(),
    now,
  });
  await assert.rejects(() => startGrokAuthorization({
    companyId: "other-company",
    actorUid: "admin-2",
    action: "connect",
    executeJob: executor([]),
    database: memory.asFirestore(),
    now,
  }), /already assigned to another company/);
  memory.seed(`grokAuthSessionRoutes/${first.sessionId}`, {
    sessionId: first.sessionId,
    companyId: "other-company",
    connectionId: "grok_subscription",
    action: "connect",
    secretName: "grok-subscription-auth",
  });
  await assert.rejects(() => processGrokAuthCallback({
    body: {
      type: "device",
      sessionId: first.sessionId,
      verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    },
    database: memory.asFirestore(),
    now: afterDevice,
  }), /tenant route check failed/);
});
