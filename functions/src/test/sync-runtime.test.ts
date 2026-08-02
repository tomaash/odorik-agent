import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { GoogleApiError } from "../connectors/google-oauth.js";
import {
  acquireConnectorSyncLease,
  claimConnectorSyncRun,
  classifyConnectorSyncError,
  commitConnectorSyncWrites,
  completeConnectorSyncResource,
  completeConnectorSyncRun,
  connectorSyncLeaseMs,
  connectorSyncRetryAt,
  createConnectorSyncRun,
  failConnectorSyncResource,
} from "../connectors/sync-runtime.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "explorers";
const connectionId = "google-a";
const capabilityId = "context.calendar.read" as const;
const resourceId = "calendar-a";
const connectionPath = `companies/${companyId}/connections/${connectionId}`;
const capabilityPath = `${connectionPath}/capabilities/calendar`;
const resourcePath = `${connectionPath}/resources/${resourceId}`;

function fixture() {
  const memory = new MemoryFirestore();
  memory.seed(connectionPath, {
    companyId,
    connectorId: "google_workspace",
    status: "active",
    stats: {},
  });
  memory.seed(capabilityPath, {
    capabilityId,
    serviceId: "calendar",
    status: "active",
    stats: {},
  });
  memory.seed(resourcePath, {
    connectionId,
    capabilityId,
    resourceType: "calendar",
    externalId: "primary@example.com",
    displayName: "Primary",
    status: "enabled",
    itemCount: 0,
  });
  let now = Timestamp.fromDate(new Date("2026-08-02T10:00:00.000Z"));
  return {
    memory,
    dependencies: {
      database: memory.asFirestore(),
      now: () => now,
    },
    advance(milliseconds: number) {
      now = Timestamp.fromMillis(now.toMillis() + milliseconds);
    },
    now: () => now,
  };
}

async function createAndClaim(context: ReturnType<typeof fixture>) {
  const created = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "manual",
    requestedBy: "admin-1",
    resourceIds: [resourceId],
  }, context.dependencies);
  assert.equal(created.created, true);
  const claimed = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
  }, context.dependencies);
  assert.equal(claimed.claimed, true);
  return { runId: created.runId, attempt: claimed.attempt };
}

test("connector sync records one run, fenced resource attempt, and truthful aggregates", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const duplicate = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "scheduled",
    resourceIds: [resourceId],
  }, context.dependencies);
  assert.deepEqual(duplicate, { runId, created: false });

  const acquired = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt,
  }, context.dependencies);
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.lease?.generation, 1);

  context.advance(2_000);
  await completeConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: acquired.lease!,
    attemptRef: acquired.attemptRef,
    changes: 2,
    itemCount: 2,
    resourcePatch: { syncToken: "cursor-2" },
  }, context.dependencies);
  const result = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt,
    results: [{ resourceId, status: "succeeded", changes: 2, itemCount: 2 }],
  }, context.dependencies);

  assert.equal(result.status, "succeeded");
  const resource = context.memory.read(resourcePath) || {};
  const resourceSync = (resource.sync || {}) as Record<string, unknown>;
  const capabilityStats = (context.memory.read(capabilityPath)?.stats || {}) as Record<string, unknown>;
  const connectionStats = (context.memory.read(connectionPath)?.stats || {}) as Record<string, unknown>;
  assert.equal(resource.syncToken, "cursor-2");
  assert.equal(resourceSync.health, "fresh");
  assert.equal(resource.syncLease, null);
  assert.equal(capabilityStats.syncHealth, "fresh");
  assert.equal(capabilityStats.activeRunId, null);
  assert.equal(context.memory.read(connectionPath)?.status, "active");
  assert.equal(connectionStats.itemCount, 2);
  const attempts = context.memory.list(`${connectionPath}/syncRuns/${runId}/resourceAttempts`);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "succeeded");
});

test("a newly selected resource becomes one deferred successor while a run is active", async () => {
  const context = fixture();
  const secondResourceId = "calendar-b";
  context.memory.seed(`${connectionPath}/resources/${secondResourceId}`, {
    connectionId,
    capabilityId,
    resourceType: "calendar",
    externalId: "secondary@example.com",
    displayName: "Secondary",
    status: "enabled",
    itemCount: 0,
  });
  const active = await createAndClaim(context);
  const deferred = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "selection",
    resourceIds: [secondResourceId],
  }, context.dependencies);
  assert.equal(deferred.created, true);
  assert.equal(deferred.deferred, true);
  assert.notEqual(deferred.runId, active.runId);
  const duplicateDeferred = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "manual",
    resourceIds: [secondResourceId],
  }, context.dependencies);
  assert.equal(duplicateDeferred.runId, deferred.runId);
  assert.equal(duplicateDeferred.created, false);
  assert.equal(duplicateDeferred.deferred, true);
  const blocked = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: deferred.runId,
  }, context.dependencies);
  assert.equal(blocked.claimed, false);

  await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId: active.runId,
    attempt: active.attempt,
    results: [{ resourceId, status: "succeeded", changes: 0, itemCount: 0 }],
  }, context.dependencies);
  const claimedDeferred = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: deferred.runId,
  }, context.dependencies);
  assert.equal(claimedDeferred.claimed, true);
  assert.deepEqual(claimedDeferred.data.resourceIds, [secondResourceId]);
  const stats = context.memory.read(capabilityPath)?.stats as Record<string, unknown>;
  assert.equal(stats.activeRunId, deferred.runId);
  assert.equal(stats.pendingRunId, null);
});

test("a newly selected resource joins the failed set of a scheduled retry", async () => {
  const context = fixture();
  const secondResourceId = "calendar-b";
  context.memory.seed(`${connectionPath}/resources/${secondResourceId}`, {
    connectionId,
    capabilityId,
    resourceType: "calendar",
    externalId: "secondary@example.com",
    displayName: "Secondary",
    status: "enabled",
    itemCount: 0,
  });
  const active = await createAndClaim(context);
  const acquired = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId: active.runId,
    attempt: active.attempt,
  }, context.dependencies);
  const retryAt = connectorSyncRetryAt(active.attempt, context.now());
  await failConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: acquired.lease!,
    attemptRef: acquired.attemptRef,
    error: new Error("Calendar API failed (503)"),
    failureKind: "transient",
    retryAt,
  }, context.dependencies);
  await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId: active.runId,
    attempt: active.attempt,
    results: [{
      resourceId,
      status: "retry_scheduled",
      changes: 0,
      failureKind: "transient",
      error: "Calendar API failed (503)",
    }],
  }, context.dependencies);
  const merged = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "selection",
    resourceIds: [secondResourceId],
  }, context.dependencies);
  assert.deepEqual(merged, { runId: active.runId, created: false });
  assert.deepEqual(
    context.memory.read(`${connectionPath}/syncRuns/${active.runId}`)?.failedResourceIds,
    [resourceId, secondResourceId],
  );
});

test("transient synchronization failure schedules the same run and retry succeeds", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const acquired = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt,
  }, context.dependencies);
  const error = new Error("Google Calendar API failed (503): unavailable");
  const retryAt = connectorSyncRetryAt(attempt, context.now());
  await failConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: acquired.lease!,
    attemptRef: acquired.attemptRef,
    error,
    failureKind: classifyConnectorSyncError(error),
    retryAt,
  }, context.dependencies);
  const failed = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt,
    results: [{
      resourceId,
      status: "retry_scheduled",
      changes: 0,
      failureKind: "transient",
      error: error.message,
    }],
  }, context.dependencies);
  assert.equal(failed.status, "retry_scheduled");
  assert.equal(context.memory.read(capabilityPath)?.status, "active");
  assert.equal(
    ((context.memory.read(capabilityPath)?.stats || {}) as Record<string, unknown>).syncHealth,
    "retrying",
  );

  context.advance(60_001);
  const retry = await claimConnectorSyncRun({ companyId, connectionId, runId }, context.dependencies);
  assert.equal(retry.claimed, true);
  assert.equal(retry.attempt, 2);
  const retryLease = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt: retry.attempt,
  }, context.dependencies);
  assert.equal(retryLease.lease?.generation, 2);
  await completeConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: retryLease.lease!,
    attemptRef: retryLease.attemptRef,
    changes: 0,
    itemCount: 0,
  }, context.dependencies);
  const recovered = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt: retry.attempt,
    results: [{ resourceId, status: "succeeded", changes: 0, itemCount: 0 }],
  }, context.dependencies);
  assert.equal(recovered.status, "succeeded");
  assert.equal(context.memory.list(`${connectionPath}/syncRuns/${runId}/resourceAttempts`).length, 2);
});

test("a reclaimed stale lease fences the obsolete worker", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const first = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt,
  }, context.dependencies);
  context.advance(connectorSyncLeaseMs + 1);
  const reclaimedRun = await claimConnectorSyncRun({ companyId, connectionId, runId }, context.dependencies);
  assert.equal(reclaimedRun.claimed, true);
  const second = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt: reclaimedRun.attempt,
  }, context.dependencies);
  assert.equal(second.lease?.generation, 2);
  await assert.rejects(
    commitConnectorSyncWrites({
      companyId,
      connectionId,
      resourceId,
      lease: first.lease!,
      apply: () => undefined,
    }, context.dependencies),
    /lease is no longer current/,
  );
});

test("disconnect wins against an in-flight synchronization commit", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const acquired = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt,
  }, context.dependencies);
  await context.dependencies.database.doc(connectionPath).set({
    status: "disconnected",
    syncGeneration: 1,
  }, { merge: true });
  // Even a quick reconnect cannot make the pre-disconnect lease current again.
  await context.dependencies.database.doc(connectionPath).set({ status: "active" }, { merge: true });
  await assert.rejects(
    commitConnectorSyncWrites({
      companyId,
      connectionId,
      resourceId,
      lease: acquired.lease!,
      apply: () => undefined,
    }, context.dependencies),
    /connection is no longer active/,
  );
});

test("a queued run from before disconnect is skipped after reconnect", async () => {
  const context = fixture();
  const created = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "manual",
    resourceIds: [resourceId],
  }, context.dependencies);
  await context.dependencies.database.doc(connectionPath).set({
    status: "active",
    syncGeneration: 1,
  }, { merge: true });
  const claim = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
  }, context.dependencies);
  assert.equal(claim.claimed, false);
  assert.equal(context.memory.read(`${connectionPath}/syncRuns/${created.runId}`)?.status, "skipped");
});

test("a queued run from an older capability selection is fenced and replaced", async () => {
  const context = fixture();
  const created = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "selection",
    resourceIds: [resourceId],
  }, context.dependencies);
  await context.dependencies.database.doc(capabilityPath).set({
    syncGeneration: 1,
  }, { merge: true });
  const stale = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
  }, context.dependencies);
  assert.equal(stale.claimed, false);
  assert.equal(context.memory.read(`${connectionPath}/syncRuns/${created.runId}`)?.status, "skipped");

  const replacement = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "selection",
    resourceIds: [resourceId],
  }, context.dependencies);
  assert.equal(replacement.created, true);
  assert.notEqual(replacement.runId, created.runId);
  const claimed = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: replacement.runId,
  }, context.dependencies);
  assert.equal(claimed.claimed, true);
});

test("a permanent failure becomes attention immediately", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const acquired = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId,
    attempt,
  }, context.dependencies);
  const error = new Error("Calendar payload violated its contract");
  await failConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: acquired.lease!,
    attemptRef: acquired.attemptRef,
    error,
    failureKind: "permanent",
    retryAt: null,
  }, context.dependencies);
  const result = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt,
    results: [{
      resourceId,
      status: "attention",
      changes: 0,
      failureKind: "permanent",
      error: error.message,
    }],
  }, context.dependencies);
  assert.equal(result.status, "attention");
  assert.equal(context.memory.read(capabilityPath)?.status, "attention");
  assert.equal(context.memory.read(connectionPath)?.status, "attention");
});

test("typed Google failures distinguish retry, reauthorization, and permanent errors", () => {
  assert.equal(classifyConnectorSyncError(new GoogleApiError({
    label: "Google Drive",
    status: 429,
    message: "Rate limit exceeded",
    reasons: ["rateLimitExceeded"],
  })), "transient");
  assert.equal(classifyConnectorSyncError(new GoogleApiError({
    label: "Google Calendar",
    status: 401,
    message: "Invalid credentials",
    reasons: ["authError"],
  })), "reauthorization_required");
  assert.equal(classifyConnectorSyncError(new GoogleApiError({
    label: "Google Drive",
    status: 403,
    message: "Insufficient permission",
    reasons: ["insufficientPermissions"],
  })), "reauthorization_required");
  assert.equal(classifyConnectorSyncError(new GoogleApiError({
    label: "Google Calendar",
    status: 410,
    message: "Sync token expired",
  })), "permanent");
});

test("reauthorization failure marks the capability and connection explicitly", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  const result = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt,
    results: [{
      resourceId,
      status: "attention",
      changes: 0,
      failureKind: "reauthorization_required",
      error: "Google Workspace permission is incomplete",
    }],
  }, context.dependencies);
  assert.equal(result.status, "attention");
  assert.equal(context.memory.read(capabilityPath)?.status, "reauthorization_required");
  assert.equal(context.memory.read(connectionPath)?.status, "attention");
  assert.equal(context.memory.read(connectionPath)?.reauthorizationRequired, true);
});

test("a retry never erases a terminal sibling-resource failure", async () => {
  const context = fixture();
  const secondResourceId = "calendar-b";
  context.memory.seed(`${connectionPath}/resources/${secondResourceId}`, {
    connectionId,
    capabilityId,
    resourceType: "calendar",
    externalId: "secondary@example.com",
    displayName: "Secondary",
    status: "enabled",
    itemCount: 0,
  });
  const created = await createConnectorSyncRun({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    trigger: "manual",
    resourceIds: [resourceId, secondResourceId],
  }, context.dependencies);
  const claimed = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
  }, context.dependencies);
  const transient = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId: created.runId,
    attempt: claimed.attempt,
  }, context.dependencies);
  const permanent = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId: secondResourceId,
    runId: created.runId,
    attempt: claimed.attempt,
  }, context.dependencies);
  const retryAt = connectorSyncRetryAt(claimed.attempt, context.now());
  await failConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: transient.lease!,
    attemptRef: transient.attemptRef,
    error: new Error("Calendar API failed (503)"),
    failureKind: "transient",
    retryAt,
  }, context.dependencies);
  await failConnectorSyncResource({
    companyId,
    connectionId,
    resourceId: secondResourceId,
    lease: permanent.lease!,
    attemptRef: permanent.attemptRef,
    error: new Error("Malformed provider response"),
    failureKind: "permanent",
    retryAt: null,
  }, context.dependencies);
  const firstResult = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
    attempt: claimed.attempt,
    results: [
      {
        resourceId,
        status: "retry_scheduled",
        changes: 0,
        failureKind: "transient",
        error: "Calendar API failed (503)",
      },
      {
        resourceId: secondResourceId,
        status: "attention",
        changes: 0,
        failureKind: "permanent",
        error: "Malformed provider response",
      },
    ],
  }, context.dependencies);
  assert.equal(firstResult.status, "retry_scheduled");
  assert.deepEqual(
    context.memory.read(`${connectionPath}/syncRuns/${created.runId}`)?.failedResourceIds,
    [resourceId],
  );

  context.advance(60_001);
  const retry = await claimConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
  }, context.dependencies);
  const recovered = await acquireConnectorSyncLease({
    companyId,
    connectionId,
    capabilityId,
    serviceId: "calendar",
    resourceId,
    runId: created.runId,
    attempt: retry.attempt,
  }, context.dependencies);
  await completeConnectorSyncResource({
    companyId,
    connectionId,
    resourceId,
    lease: recovered.lease!,
    attemptRef: recovered.attemptRef,
    changes: 0,
    itemCount: 0,
  }, context.dependencies);
  const finalResult = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId: created.runId,
    attempt: retry.attempt,
    results: [{ resourceId, status: "succeeded", changes: 0, itemCount: 0 }],
  }, context.dependencies);
  assert.equal(finalResult.status, "attention");
  assert.deepEqual(
    context.memory.read(`${connectionPath}/syncRuns/${created.runId}`)?.failedResourceIds,
    [secondResourceId],
  );
  assert.equal(context.memory.read(capabilityPath)?.status, "attention");
});

test("terminal run recording does not recreate a deleted connection capability", async () => {
  const context = fixture();
  const { runId, attempt } = await createAndClaim(context);
  await context.dependencies.database.doc(connectionPath).set({ status: "disconnected" }, { merge: true });
  await context.dependencies.database.doc(capabilityPath).delete();
  const result = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt,
    results: [{
      resourceId,
      status: "attention",
      changes: 0,
      failureKind: "permanent",
      error: "Connection was removed",
    }],
  }, context.dependencies);
  assert.equal(result.status, "attention");
  assert.equal(context.memory.read(capabilityPath), undefined);
  assert.equal(context.memory.read(connectionPath)?.status, "disconnected");
});

test("the fourth transient attempt is bounded and remains replayable", async () => {
  const context = fixture();
  const { runId } = await createAndClaim(context);
  context.memory.patch(`${connectionPath}/syncRuns/${runId}`, {
    status: "running",
    attempt: 4,
  });
  const result = await completeConnectorSyncRun({
    companyId,
    connectionId,
    runId,
    attempt: 4,
    results: [{
      resourceId,
      status: "attention",
      changes: 0,
      failureKind: "transient",
      error: "Provider remains unavailable",
    }],
  }, context.dependencies);
  assert.equal(result.status, "attention");
  assert.equal(result.nextAttemptAt, null);
  assert.deepEqual(
    context.memory.read(`${connectionPath}/syncRuns/${runId}`)?.failedResourceIds,
    [resourceId],
  );
});
