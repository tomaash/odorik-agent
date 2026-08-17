import { Timestamp } from "firebase-admin/firestore";
import { jsonSafe } from "../firestore.js";
import type { CapabilityServiceId, SourceCapabilityId } from "./types.js";

export type ConnectorSyncTrigger =
  | "manual"
  | "scheduled"
  | "selection"
  | "webhook"
  | "retry"
  | "operator_replay";

export type ConnectorSyncRunStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "attention"
  | "skipped";

export type ConnectorSyncHealth =
  | "never_synced"
  | "syncing"
  | "retrying"
  | "fresh"
  | "stale"
  | "attention"
  | "unmeasured";

export type ConnectorSyncFailureKind =
  | "transient"
  | "permanent"
  | "reauthorization_required";

export type ConnectorSyncLease = {
  runId: string;
  attemptId: string;
  generation: number;
  connectionGeneration: number;
  expiresAt: Timestamp;
};

export type ConnectorSyncResourceResult = {
  resourceId: string;
  status: "succeeded" | "retry_scheduled" | "attention" | "skipped";
  changes: number;
  itemCount?: number;
  failureKind?: ConnectorSyncFailureKind;
  error?: string;
};

export type ConnectorSyncRunResult = {
  runId: string;
  status: ConnectorSyncRunStatus;
  attempt: number;
  resources: number;
  succeeded: number;
  failed: number;
  changes: number;
  nextAttemptAt?: string | null;
};

export type ConnectorSyncExecutionResource<
  TData extends FirebaseFirestore.DocumentData = FirebaseFirestore.DocumentData,
> = {
  id: string;
  data: TData;
};

export type ConnectorSyncResourceCompletion = {
  changes: number;
  itemCount: number;
  resourcePatch?: Record<string, unknown>;
  cursorAfter?: string | null;
  cursorMode?: string | null;
};

export type ConnectorSyncDependencies = {
  database: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
};

export const connectorSyncLeaseMs = 12 * 60 * 1_000;
export const connectorSyncMaxAttempts = 4;
export const connectorSyncRetryDelaysMs = [60_000, 5 * 60_000, 30 * 60_000] as const;

const activeRunStatuses = new Set<ConnectorSyncRunStatus>([
  "queued",
  "running",
  "retry_scheduled",
]);
const activeConnectionStatuses = new Set(["active", "attention"]);
const activeCapabilityStatuses = new Set(["active", "attention"]);

function clock(deps: ConnectorSyncDependencies): Timestamp {
  return deps.now?.() || Timestamp.now();
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function latestTimestamp(values: unknown[]): unknown | null {
  return values.reduce<{ value: unknown; millis: number } | null>((latest, value) => {
    const millis = timestampMillis(value);
    if (millis === null || (latest && latest.millis >= millis)) return latest;
    return { value, millis };
  }, null)?.value || null;
}

function earliestTimestamp(values: unknown[]): unknown | null {
  return values.reduce<{ value: unknown; millis: number } | null>((earliest, value) => {
    const millis = timestampMillis(value);
    if (millis === null || (earliest && earliest.millis <= millis)) return earliest;
    return { value, millis };
  }, null)?.value || null;
}

function earliestCompleteTimestamp(values: unknown[]): unknown | null {
  if (values.length === 0 || values.some((value) => timestampMillis(value) === null)) return null;
  return earliestTimestamp(values);
}

export function sanitizeConnectorSyncError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export function classifyConnectorSyncError(error: unknown): ConnectorSyncFailureKind {
  const typed = error as {
    code?: unknown;
    status?: unknown;
    reasons?: unknown;
    googleStatus?: unknown;
  };
  const code = String(typed?.code || "").toUpperCase();
  const name = String((error as { name?: unknown })?.name || "");
  const message = sanitizeConnectorSyncError(error).toLowerCase();
  const status = Number(typed?.status || 0);
  const reasons = Array.isArray(typed?.reasons)
    ? typed.reasons.map((reason) => String(reason).toLowerCase())
    : [];
  if (
    code === "GOOGLE_REAUTHORIZATION_REQUIRED"
    || name === "GoogleReauthorizationRequiredError"
  ) return "reauthorization_required";
  if (
    code === "GOOGLE_API_ERROR"
    && (
      status === 401
      || (
        status === 403
        && reasons.some((reason) => [
          "autherror",
          "insufficientpermissions",
          "insufficient_scope",
        ].includes(reason))
      )
    )
  ) return "reauthorization_required";
  if (
    name === "AbortError"
    || name === "TimeoutError"
    || (
      code === "GOOGLE_API_ERROR"
      && ([408, 409, 425, 429].includes(status) || status >= 500)
    )
    || /\((408|409|425|429|5\d\d)\)/.test(message)
    || /\b(timeout|timed out|temporar|network|fetch failed|socket|econnreset|rate limit)\b/.test(message)
  ) return "transient";
  return "permanent";
}

export function connectorSyncRetryAt(attempt: number, now: Timestamp): Timestamp | null {
  const delay = connectorSyncRetryDelaysMs[attempt - 1];
  return delay === undefined ? null : Timestamp.fromMillis(now.toMillis() + delay);
}

function syncRunRef(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  runId: string;
}) {
  return input.database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}/syncRuns/${input.runId}`,
  );
}

function capabilityRef(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  serviceId: CapabilityServiceId;
}) {
  return input.database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}/capabilities/${input.serviceId}`,
  );
}

function resourceRef(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  resourceId: string;
}) {
  return input.database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}/resources/${input.resourceId}`,
  );
}

function connectionRef(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
}) {
  return input.database.doc(`companies/${input.companyId}/connections/${input.connectionId}`);
}

function connectorSyncRunDocument(input: {
  companyId: string;
  connectionId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  trigger: ConnectorSyncTrigger;
  requestedBy?: string | null;
  resourceIds: string[];
  replayOfRunId?: string | null;
  connectionGeneration: number;
  capabilityGeneration: number;
  now: Timestamp;
}): Record<string, unknown> {
  return {
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId: input.capabilityId,
    serviceId: input.serviceId,
    trigger: input.trigger,
    requestedBy: input.requestedBy || null,
    replayOfRunId: input.replayOfRunId || null,
    connectionGeneration: input.connectionGeneration,
    capabilityGeneration: input.capabilityGeneration,
    resourceIds: [...new Set(input.resourceIds)],
    status: "queued" satisfies ConnectorSyncRunStatus,
    attempt: 0,
    maxAttempts: connectorSyncMaxAttempts,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: Timestamp.fromMillis(input.now.toMillis() + 90 * 24 * 60 * 60 * 1_000),
  };
}

export async function createConnectorSyncRun(input: {
  companyId: string;
  connectionId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  trigger: ConnectorSyncTrigger;
  requestedBy?: string | null;
  resourceIds: string[];
  replayOfRunId?: string | null;
}, deps: ConnectorSyncDependencies): Promise<{
  runId: string;
  created: boolean;
  deferred?: boolean;
}> {
  const runRef = connectionRef({ ...input, database: deps.database })
    .collection("syncRuns").doc();
  const connection = connectionRef({ ...input, database: deps.database });
  const capability = capabilityRef({ ...input, database: deps.database });
  return deps.database.runTransaction(async (transaction) => {
    const [connectionSnapshot, capabilitySnapshot] = await Promise.all([
      transaction.get(connection),
      transaction.get(capability),
    ]);
    if (
      !connectionSnapshot.exists
      || !activeConnectionStatuses.has(String(connectionSnapshot.data()?.status))
      || !capabilitySnapshot.exists
      || !activeCapabilityStatuses.has(String(capabilitySnapshot.data()?.status))
      || capabilitySnapshot.data()?.capabilityId !== input.capabilityId
    ) {
      throw new Error("Active connector capability not found");
    }
    const activeRunId = String(capabilitySnapshot.data()?.stats?.activeRunId || "");
    if (activeRunId) {
      const activeRun = await transaction.get(syncRunRef({ ...input, database: deps.database, runId: activeRunId }));
      if (
        activeRun.exists
        && activeRunStatuses.has(activeRun.data()?.status)
        && Number(activeRun.data()?.capabilityGeneration || 0)
          === Number(capabilitySnapshot.data()?.syncGeneration || 0)
      ) {
        const currentResourceIds = Array.isArray(activeRun.data()?.resourceIds)
          ? activeRun.data()!.resourceIds.map(String)
          : [];
        const requestedResourceIds = [...new Set(input.resourceIds)];
        const mergedResourceIds = [...new Set([...currentResourceIds, ...requestedResourceIds])];
        if (activeRun.data()?.status !== "running") {
          const now = clock(deps);
          if (mergedResourceIds.length !== currentResourceIds.length) {
            const failedResourceIds = Array.isArray(activeRun.data()?.failedResourceIds)
              ? activeRun.data()!.failedResourceIds.map(String)
              : [];
            transaction.set(activeRun.ref, {
              resourceIds: mergedResourceIds,
              ...(activeRun.data()?.status === "retry_scheduled" ? {
                failedResourceIds: [...new Set([...failedResourceIds, ...requestedResourceIds])],
              } : {}),
              updatedAt: now,
            }, { merge: true });
          }
          transaction.set(capability, {
            stats: {
              latestRunId: activeRun.id,
              syncHealth: activeRun.data()?.status === "retry_scheduled"
                ? "retrying"
                : "syncing",
              lastAttemptAt: now,
            },
            updatedAt: now,
          }, { merge: true });
          return { runId: activeRun.id, created: false };
        }
        if (requestedResourceIds.every((resourceId) => currentResourceIds.includes(resourceId))) {
          return { runId: activeRun.id, created: false };
        }
        const pendingRunId = String(capabilitySnapshot.data()?.stats?.pendingRunId || "");
        if (pendingRunId) {
          const pendingRun = await transaction.get(syncRunRef({
            ...input,
            database: deps.database,
            runId: pendingRunId,
          }));
          if (pendingRun.exists && pendingRun.data()?.status === "queued") {
            const pendingResources = Array.isArray(pendingRun.data()?.resourceIds)
              ? pendingRun.data()!.resourceIds.map(String)
              : [];
            transaction.set(pendingRun.ref, {
              resourceIds: [...new Set([...pendingResources, ...requestedResourceIds])],
              updatedAt: clock(deps),
            }, { merge: true });
            return { runId: pendingRun.id, created: false, deferred: true };
          }
        }
        const now = clock(deps);
        transaction.create(runRef, connectorSyncRunDocument({
          ...input,
          connectionGeneration: Number(connectionSnapshot.data()?.syncGeneration || 0),
          capabilityGeneration: Number(capabilitySnapshot.data()?.syncGeneration || 0),
          now,
        }));
        transaction.set(capability, {
          stats: {
            pendingRunId: runRef.id,
            latestRunId: runRef.id,
            syncHealth: "syncing" satisfies ConnectorSyncHealth,
            lastAttemptAt: now,
          },
          updatedAt: now,
        }, { merge: true });
        return { runId: runRef.id, created: true, deferred: true };
      }
    }
    const now = clock(deps);
    transaction.create(runRef, connectorSyncRunDocument({
      ...input,
      connectionGeneration: Number(connectionSnapshot.data()?.syncGeneration || 0),
      capabilityGeneration: Number(capabilitySnapshot.data()?.syncGeneration || 0),
      now,
    }));
    transaction.set(capability, {
      stats: {
        activeRunId: runRef.id,
        pendingRunId: null,
        latestRunId: runRef.id,
        syncHealth: "syncing" satisfies ConnectorSyncHealth,
        lastAttemptAt: now,
      },
      updatedAt: now,
    }, { merge: true });
    return { runId: runRef.id, created: true };
  });
}

export async function claimConnectorSyncRun(input: {
  companyId: string;
  connectionId: string;
  runId: string;
}, deps: ConnectorSyncDependencies): Promise<{
  claimed: boolean;
  attempt: number;
  data: FirebaseFirestore.DocumentData;
}> {
  const runRef = syncRunRef({ ...input, database: deps.database });
  return deps.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runRef);
    if (!snapshot.exists) throw new Error("Connector sync run not found");
    const data = snapshot.data() || {};
    const status = data.status as ConnectorSyncRunStatus;
    const now = clock(deps);
    const serviceId = data.serviceId as CapabilityServiceId;
    const capability = capabilityRef({ ...input, database: deps.database, serviceId });
    const connection = connectionRef({ ...input, database: deps.database });
    const [capabilitySnapshot, connectionSnapshot] = await Promise.all([
      transaction.get(capability),
      transaction.get(connection),
    ]);
    if (
      !capabilitySnapshot.exists
      || !connectionSnapshot.exists
      || !activeConnectionStatuses.has(String(connectionSnapshot.data()?.status))
      || Number(capabilitySnapshot.data()?.syncGeneration || 0)
        !== Number(data.capabilityGeneration || 0)
      || Number(connectionSnapshot.data()?.syncGeneration || 0)
        !== Number(data.connectionGeneration || 0)
    ) {
      transaction.set(runRef, {
        status: "skipped" satisfies ConnectorSyncRunStatus,
        lastError: null,
        executionLeaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      }, { merge: true });
      if (
        capabilitySnapshot.exists
        && (
          capabilitySnapshot.data()?.stats?.activeRunId === input.runId
          || capabilitySnapshot.data()?.stats?.pendingRunId === input.runId
        )
      ) {
        transaction.set(capability, {
          stats: {
            ...(capabilitySnapshot.data()?.stats?.activeRunId === input.runId
              ? { activeRunId: null }
              : {}),
            ...(capabilitySnapshot.data()?.stats?.pendingRunId === input.runId
              ? { pendingRunId: null }
              : {}),
          },
          updatedAt: now,
        }, { merge: true });
      }
      return {
        claimed: false,
        attempt: Number(data.attempt || 0),
        data: { ...data, status: "skipped" },
      };
    }
    const activeRunId = String(capabilitySnapshot.data()?.stats?.activeRunId || "");
    if (activeRunId && activeRunId !== input.runId) {
      const activeRun = await transaction.get(syncRunRef({
        ...input,
        database: deps.database,
        runId: activeRunId,
      }));
      if (activeRun.exists && activeRunStatuses.has(activeRun.data()?.status)) {
        return { claimed: false, attempt: Number(data.attempt || 0), data };
      }
    }
    const leaseExpiresAt = timestampMillis(data.executionLeaseExpiresAt) || 0;
    if (status === "running" && leaseExpiresAt > now.toMillis()) {
      return { claimed: false, attempt: Number(data.attempt || 0), data };
    }
    if (!["queued", "retry_scheduled", "running"].includes(status)) {
      return { claimed: false, attempt: Number(data.attempt || 0), data };
    }
    const nextAttemptAt = timestampMillis(data.nextAttemptAt);
    if (status === "retry_scheduled" && nextAttemptAt !== null && nextAttemptAt > now.toMillis()) {
      return { claimed: false, attempt: Number(data.attempt || 0), data };
    }
    const attempt = Number(data.attempt || 0) + 1;
    if (attempt > Number(data.maxAttempts || connectorSyncMaxAttempts)) {
      return { claimed: false, attempt: Number(data.attempt || 0), data };
    }
    transaction.set(runRef, {
      status: "running" satisfies ConnectorSyncRunStatus,
      attempt,
      startedAt: now,
      lastAttemptAt: now,
      nextAttemptAt: null,
      executionLeaseExpiresAt: Timestamp.fromMillis(now.toMillis() + connectorSyncLeaseMs),
      updatedAt: now,
    }, { merge: true });
    transaction.set(capability, {
      stats: {
        activeRunId: input.runId,
        ...(capabilitySnapshot.data()?.stats?.pendingRunId === input.runId
          ? { pendingRunId: null }
          : {}),
        latestRunId: input.runId,
        syncHealth: "syncing" satisfies ConnectorSyncHealth,
        lastAttemptAt: now,
      },
      updatedAt: now,
    }, { merge: true });
    return { claimed: true, attempt, data: { ...data, status: "running", attempt } };
  });
}

export async function acquireConnectorSyncLease(input: {
  companyId: string;
  connectionId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  resourceId: string;
  runId: string;
  attempt: number;
  cursorBefore?: string | null;
  cursorMode?: string | null;
}, deps: ConnectorSyncDependencies): Promise<{
  acquired: boolean;
  reason?: "inactive" | "busy";
  lease?: ConnectorSyncLease;
  attemptRef: FirebaseFirestore.DocumentReference;
}> {
  const connection = connectionRef({ ...input, database: deps.database });
  const capability = capabilityRef({ ...input, database: deps.database });
  const resource = resourceRef({ ...input, database: deps.database });
  const run = syncRunRef({ ...input, database: deps.database });
  const attemptId = `${String(input.attempt).padStart(3, "0")}_${input.resourceId}`;
  const attemptRef = run.collection("resourceAttempts").doc(attemptId);
  return deps.database.runTransaction(async (transaction) => {
    const [connectionSnapshot, capabilitySnapshot, resourceSnapshot] = await Promise.all([
      transaction.get(connection),
      transaction.get(capability),
      transaction.get(resource),
    ]);
    const now = clock(deps);
    const expiresAt = Timestamp.fromMillis(now.toMillis() + 90 * 24 * 60 * 60 * 1_000);
    if (
      !connectionSnapshot.exists
      || !activeConnectionStatuses.has(String(connectionSnapshot.data()?.status))
      || !capabilitySnapshot.exists
      || !activeCapabilityStatuses.has(String(capabilitySnapshot.data()?.status))
      || capabilitySnapshot.data()?.capabilityId !== input.capabilityId
      || !resourceSnapshot.exists
      || resourceSnapshot.data()?.status !== "enabled"
      || resourceSnapshot.data()?.capabilityId !== input.capabilityId
    ) {
      transaction.create(attemptRef, {
        runId: input.runId,
        attempt: input.attempt,
        resourceId: input.resourceId,
        status: "skipped",
        reason: "inactive",
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        expiresAt,
      });
      return { acquired: false, reason: "inactive" as const, attemptRef };
    }
    const resourceData = resourceSnapshot.data() || {};
    const currentLease = resourceData.syncLease as Record<string, unknown> | undefined;
    const currentLeaseExpiresAt = timestampMillis(currentLease?.expiresAt) || 0;
    if (currentLeaseExpiresAt > now.toMillis() && currentLease?.runId !== input.runId) {
      transaction.create(attemptRef, {
        runId: input.runId,
        attempt: input.attempt,
        resourceId: input.resourceId,
        status: "retry_scheduled",
        reason: "busy",
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        expiresAt,
      });
      return { acquired: false, reason: "busy" as const, attemptRef };
    }
    const generation = Number(resourceData.syncLeaseGeneration || 0) + 1;
    const connectionGeneration = Number(connectionSnapshot.data()?.syncGeneration || 0);
    const lease: ConnectorSyncLease = {
      runId: input.runId,
      attemptId,
      generation,
      connectionGeneration,
      expiresAt: Timestamp.fromMillis(now.toMillis() + connectorSyncLeaseMs),
    };
    transaction.set(resource, {
      syncLeaseGeneration: generation,
      syncLease: lease,
      sync: {
        health: "syncing" satisfies ConnectorSyncHealth,
        latestRunId: input.runId,
        latestAttemptId: attemptId,
        lastAttemptAt: now,
        nextRetryAt: null,
        lastError: null,
      },
      updatedAt: now,
    }, { merge: true });
    transaction.create(attemptRef, {
      runId: input.runId,
      attempt: input.attempt,
      resourceId: input.resourceId,
      status: "running",
      leaseGeneration: generation,
      connectionGeneration,
      cursorBefore: input.cursorBefore || null,
      cursorMode: input.cursorMode || null,
      startedAt: now,
      createdAt: now,
      expiresAt,
    });
    return { acquired: true, lease, attemptRef };
  });
}

function assertLeaseData(
  data: FirebaseFirestore.DocumentData | undefined,
  lease: ConnectorSyncLease,
): void {
  if (
    !data
    || data.status !== "enabled"
    || data.syncLease?.runId !== lease.runId
    || data.syncLease?.attemptId !== lease.attemptId
    || Number(data.syncLease?.generation) !== lease.generation
  ) throw new Error("Connector sync lease is no longer current");
}

function assertActiveConnectionData(
  data: FirebaseFirestore.DocumentData | undefined,
  lease?: ConnectorSyncLease,
): void {
  if (
    !data
    || !activeConnectionStatuses.has(String(data.status))
    || (lease && Number(data.syncGeneration || 0) !== lease.connectionGeneration)
  ) {
    throw new Error("Connector connection is no longer active");
  }
}

export async function assertConnectorSyncLease(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  lease: ConnectorSyncLease;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const [connection, resource] = await Promise.all([
    connectionRef({ ...input, database: deps.database }).get(),
    resourceRef({ ...input, database: deps.database }).get(),
  ]);
  assertActiveConnectionData(connection.data(), input.lease);
  assertLeaseData(resource.data(), input.lease);
}

export async function commitConnectorSyncWrites(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  lease: ConnectorSyncLease;
  apply: (transaction: FirebaseFirestore.Transaction) => void;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const resource = resourceRef({ ...input, database: deps.database });
  const connection = connectionRef({ ...input, database: deps.database });
  await deps.database.runTransaction(async (transaction) => {
    const [connectionSnapshot, snapshot] = await Promise.all([
      transaction.get(connection),
      transaction.get(resource),
    ]);
    assertActiveConnectionData(connectionSnapshot.data(), input.lease);
    assertLeaseData(snapshot.data(), input.lease);
    input.apply(transaction);
  });
}

export async function completeConnectorSyncResource(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  lease: ConnectorSyncLease;
  attemptRef: FirebaseFirestore.DocumentReference;
  changes: number;
  itemCount: number;
  resourcePatch?: Record<string, unknown>;
  cursorAfter?: string | null;
  cursorMode?: string | null;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const resource = resourceRef({ ...input, database: deps.database });
  const connection = connectionRef({ ...input, database: deps.database });
  const now = clock(deps);
  await deps.database.runTransaction(async (transaction) => {
    const [connectionSnapshot, snapshot] = await Promise.all([
      transaction.get(connection),
      transaction.get(resource),
    ]);
    assertActiveConnectionData(connectionSnapshot.data(), input.lease);
    assertLeaseData(snapshot.data(), input.lease);
    const priorSync = snapshot.data()?.sync || {};
    transaction.set(resource, {
      ...(input.resourcePatch || {}),
      requiresFullSync: null,
      itemCount: input.itemCount,
      lastSyncAt: now,
      lastObservedAt: input.changes > 0
        ? now
        : priorSync.lastChangeObservedAt || snapshot.data()?.lastObservedAt || null,
      lastError: null,
      syncLease: null,
      sync: {
        health: "fresh" satisfies ConnectorSyncHealth,
        latestRunId: input.lease.runId,
        latestAttemptId: input.lease.attemptId,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastChangeObservedAt: input.changes > 0
          ? now
          : priorSync.lastChangeObservedAt || null,
        lastReconciledAt: now,
        consecutiveFailures: 0,
        nextRetryAt: null,
        lastError: null,
      },
      updatedAt: now,
    }, { merge: true });
    transaction.set(input.attemptRef, {
      status: "succeeded",
      changes: input.changes,
      itemCount: input.itemCount,
      cursorAfter: input.cursorAfter || null,
      cursorMode: input.cursorMode || null,
      finishedAt: now,
      updatedAt: now,
    }, { merge: true });
  });
}

export async function failConnectorSyncResource(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  lease: ConnectorSyncLease;
  attemptRef: FirebaseFirestore.DocumentReference;
  error: unknown;
  failureKind: ConnectorSyncFailureKind;
  retryAt: Timestamp | null;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const resource = resourceRef({ ...input, database: deps.database });
  const now = clock(deps);
  const message = sanitizeConnectorSyncError(input.error);
  await deps.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(resource);
    if (
      snapshot.data()?.syncLease?.runId !== input.lease.runId
      || Number(snapshot.data()?.syncLease?.generation) !== input.lease.generation
    ) return;
    const failures = Number(snapshot.data()?.sync?.consecutiveFailures || 0) + 1;
    const retrying = Boolean(input.retryAt && input.failureKind === "transient");
    transaction.set(resource, {
      syncLease: null,
      lastError: message,
      sync: {
        health: retrying
          ? "retrying" satisfies ConnectorSyncHealth
          : "attention" satisfies ConnectorSyncHealth,
        latestRunId: input.lease.runId,
        latestAttemptId: input.lease.attemptId,
        lastAttemptAt: now,
        consecutiveFailures: failures,
        nextRetryAt: input.retryAt,
        lastError: message,
      },
      updatedAt: now,
    }, { merge: true });
    transaction.set(input.attemptRef, {
      status: retrying ? "retry_scheduled" : "attention",
      failureKind: input.failureKind,
      error: message,
      nextAttemptAt: input.retryAt,
      finishedAt: now,
      updatedAt: now,
    }, { merge: true });
  });
}

function connectorSyncWasInvalidated(error: unknown): boolean {
  const message = sanitizeConnectorSyncError(error);
  return message === "Connector sync lease is no longer current"
    || message === "Connector connection is no longer active";
}

async function abandonConnectorSyncResource(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  lease: ConnectorSyncLease;
  attemptRef: FirebaseFirestore.DocumentReference;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const resource = resourceRef({ ...input, database: deps.database });
  const now = clock(deps);
  await deps.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(resource);
    if (
      snapshot.exists
      && snapshot.data()?.syncLease?.runId === input.lease.runId
      && Number(snapshot.data()?.syncLease?.generation) === input.lease.generation
    ) {
      transaction.set(resource, { syncLease: null, updatedAt: now }, { merge: true });
    }
    transaction.set(input.attemptRef, {
      status: "skipped",
      reason: "inactive",
      finishedAt: now,
      updatedAt: now,
    }, { merge: true });
  });
}

export function connectorSyncRunResultFromData(
  runId: string,
  data: FirebaseFirestore.DocumentData,
): ConnectorSyncRunResult {
  return {
    runId,
    status: data.status || "queued",
    attempt: Number(data.attempt || 0),
    resources: Number(data.resources || data.resourceIds?.length || 0),
    succeeded: Number(data.succeeded || 0),
    failed: Number(data.failed || 0),
    changes: Number(data.changes || 0),
    nextAttemptAt: data.nextAttemptAt?.toDate?.().toISOString?.()
      || data.nextAttemptAt
      || null,
  };
}

export async function executeConnectorSyncRun<
  TPreparation,
  TResourceData extends FirebaseFirestore.DocumentData = FirebaseFirestore.DocumentData,
>(input: {
  companyId: string;
  connectionId: string;
  runId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  prepare: () => Promise<TPreparation>;
  listResources: (
    preparation: TPreparation,
  ) => Promise<Array<ConnectorSyncExecutionResource<TResourceData>>>;
  cursorBefore?: (
    resource: ConnectorSyncExecutionResource<TResourceData>,
  ) => string | null;
  cursorMode?: (
    resource: ConnectorSyncExecutionResource<TResourceData>,
  ) => string | null;
  synchronizeResource: (value: {
    preparation: TPreparation;
    resource: ConnectorSyncExecutionResource<TResourceData>;
    attempt: number;
    trigger: ConnectorSyncTrigger;
    lease: ConnectorSyncLease;
    attemptRef: FirebaseFirestore.DocumentReference;
    dependencies: ConnectorSyncDependencies;
  }) => Promise<ConnectorSyncResourceCompletion>;
  classifyError?: (error: unknown) => ConnectorSyncFailureKind;
}, deps: ConnectorSyncDependencies): Promise<ConnectorSyncRunResult> {
  const runRef = syncRunRef({ ...input, database: deps.database });
  const claimed = await claimConnectorSyncRun(input, deps);
  if (!claimed.claimed) {
    const current = await runRef.get();
    return connectorSyncRunResultFromData(input.runId, current.data() || claimed.data);
  }
  const configuredResourceIds = (claimed.attempt > 1
    ? claimed.data.failedResourceIds
    : claimed.data.resourceIds) as unknown;
  const resourceIds = Array.isArray(configuredResourceIds)
    ? configuredResourceIds.map(String)
    : [];
  const results: ConnectorSyncResourceResult[] = [];
  const classifyError = input.classifyError || classifyConnectorSyncError;
  try {
    const preparation = await input.prepare();
    const availableResources = await input.listResources(preparation);
    const resources = availableResources.filter(
      (resource) => resourceIds.length === 0 || resourceIds.includes(resource.id),
    );
    for (const missingResourceId of resourceIds.filter(
      (resourceId) => !availableResources.some((resource) => resource.id === resourceId),
    )) {
      results.push({ resourceId: missingResourceId, status: "skipped", changes: 0 });
    }
    for (const resource of resources) {
      const acquired = await acquireConnectorSyncLease({
        companyId: input.companyId,
        connectionId: input.connectionId,
        capabilityId: input.capabilityId,
        serviceId: input.serviceId,
        resourceId: resource.id,
        runId: input.runId,
        attempt: claimed.attempt,
        cursorBefore: input.cursorBefore?.(resource) || null,
        cursorMode: input.cursorMode?.(resource) || null,
      }, deps);
      if (!acquired.acquired || !acquired.lease) {
        results.push({
          resourceId: resource.id,
          status: acquired.reason === "busy" ? "retry_scheduled" : "skipped",
          changes: 0,
          ...(acquired.reason === "busy" ? {
            failureKind: "transient" as const,
            error: "Another synchronization attempt still owns this resource",
          } : {}),
        });
        continue;
      }
      try {
        const completion = await input.synchronizeResource({
          preparation,
          resource,
          attempt: claimed.attempt,
          trigger: claimed.data.trigger as ConnectorSyncTrigger,
          lease: acquired.lease,
          attemptRef: acquired.attemptRef,
          dependencies: deps,
        });
        await completeConnectorSyncResource({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: resource.id,
          lease: acquired.lease,
          attemptRef: acquired.attemptRef,
          ...completion,
        }, deps);
        results.push({
          resourceId: resource.id,
          status: "succeeded",
          changes: completion.changes,
          itemCount: completion.itemCount,
        });
      } catch (error) {
        if (connectorSyncWasInvalidated(error)) {
          await abandonConnectorSyncResource({
            companyId: input.companyId,
            connectionId: input.connectionId,
            resourceId: resource.id,
            lease: acquired.lease,
            attemptRef: acquired.attemptRef,
          }, deps);
          results.push({ resourceId: resource.id, status: "skipped", changes: 0 });
          continue;
        }
        const failureKind = classifyError(error);
        const retryAt = failureKind === "transient"
          ? connectorSyncRetryAt(claimed.attempt, clock(deps))
          : null;
        await failConnectorSyncResource({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: resource.id,
          lease: acquired.lease,
          attemptRef: acquired.attemptRef,
          error,
          failureKind,
          retryAt,
        }, deps);
        results.push({
          resourceId: resource.id,
          status: retryAt ? "retry_scheduled" : "attention",
          changes: 0,
          failureKind,
          error: sanitizeConnectorSyncError(error),
        });
      }
    }
    return completeConnectorSyncRun({
      companyId: input.companyId,
      connectionId: input.connectionId,
      runId: input.runId,
      attempt: claimed.attempt,
      results,
    }, deps);
  } catch (error) {
    return completeConnectorSyncRun({
      companyId: input.companyId,
      connectionId: input.connectionId,
      runId: input.runId,
      attempt: claimed.attempt,
      results,
      preparationError: error,
      preparationFailureKind: classifyError(error),
    }, deps);
  }
}

export async function completeConnectorSyncRun(input: {
  companyId: string;
  connectionId: string;
  runId: string;
  attempt: number;
  results: ConnectorSyncResourceResult[];
  preparationError?: unknown;
  preparationFailureKind?: ConnectorSyncFailureKind;
}, deps: ConnectorSyncDependencies): Promise<ConnectorSyncRunResult> {
  const run = syncRunRef({ ...input, database: deps.database });
  const runSnapshot = await run.get();
  if (!runSnapshot.exists) throw new Error("Connector sync run not found");
  const runData = runSnapshot.data() || {};
  const now = clock(deps);
  const retryAt = connectorSyncRetryAt(input.attempt, now);
  const hasTransientFailure = input.preparationFailureKind === "transient"
    || input.results.some((result) => result.failureKind === "transient");
  const hasReauthorizationFailure = input.preparationFailureKind === "reauthorization_required"
    || input.results.some((result) => result.failureKind === "reauthorization_required");
  const canRetry = hasTransientFailure
    && input.attempt < Number(runData.maxAttempts || connectorSyncMaxAttempts)
    && retryAt !== null;
  const failed = input.results.filter(
    (result) => result.status === "retry_scheduled" || result.status === "attention",
  );
  const succeeded = input.results.filter((result) => result.status === "succeeded");
  const skipped = input.results.filter((result) => result.status === "skipped");
  const priorTerminalFailures = Array.isArray(runData.terminalFailedResourceIds)
    ? runData.terminalFailedResourceIds.map(String)
    : [];
  const currentTerminalFailures = input.preparationError
    && (input.preparationFailureKind !== "transient" || !canRetry)
    ? (runData.resourceIds || []).map(String)
    : failed.filter((result) => result.failureKind !== "transient" || !canRetry)
      .map((result) => result.resourceId);
  const terminalFailedResourceIds = [...new Set([
    ...priorTerminalFailures,
    ...currentTerminalFailures,
  ])];
  const configuredResourceCount = Array.isArray(runData.resourceIds)
    ? runData.resourceIds.length
    : 0;
  const status: ConnectorSyncRunStatus = canRetry
    ? "retry_scheduled"
    : input.preparationError || failed.length > 0 || terminalFailedResourceIds.length > 0
      ? "attention"
      : succeeded.length === 0 && (skipped.length > 0 || configuredResourceCount === 0)
        ? "skipped"
        : "succeeded";
  const nextAttemptAt = status === "retry_scheduled" ? retryAt : null;
  const error = input.preparationError
    ? sanitizeConnectorSyncError(input.preparationError)
    : failed[0]?.error || null;
  const retryResourceIds = input.preparationError && input.preparationFailureKind === "transient"
    ? (runData.resourceIds || []).map(String)
    : failed.filter((result) => result.failureKind === "transient")
      .map((result) => result.resourceId);
  const failedResourceIds = canRetry ? retryResourceIds : terminalFailedResourceIds;
  const runResult: ConnectorSyncRunResult = {
    runId: input.runId,
    status,
    attempt: input.attempt,
    resources: input.results.length || Number((runData.resourceIds || []).length),
    succeeded: succeeded.length,
    failed: canRetry
      ? retryResourceIds.length
      : terminalFailedResourceIds.length || failed.length + (input.preparationError ? 1 : 0),
    changes: succeeded.reduce((sum, result) => sum + result.changes, 0),
    nextAttemptAt: nextAttemptAt?.toDate().toISOString() || null,
  };
  const capability = capabilityRef({
    ...input,
    database: deps.database,
    serviceId: runData.serviceId as CapabilityServiceId,
  });
  await deps.database.runTransaction(async (transaction) => {
    const latestConnectionRef = connectionRef({ ...input, database: deps.database });
    const [latestRun, latestCapability, latestConnection] = await Promise.all([
      transaction.get(run),
      transaction.get(capability),
      transaction.get(latestConnectionRef),
    ]);
    if (!latestRun.exists || Number(latestRun.data()?.attempt) !== input.attempt) return;
    const capabilityData = latestCapability.data() || {};
    const capabilityStats = capabilityData.stats || {};
    const currentStatus = String(capabilityData.status || "attention");
    const capabilityStatus = currentStatus === "disabled"
      ? currentStatus
      : hasReauthorizationFailure || currentStatus === "reauthorization_required"
        ? "reauthorization_required"
      : status === "attention" ? "attention" : "active";
    transaction.set(run, {
      ...runResult,
      failedResourceIds,
      terminalFailedResourceIds,
      lastError: error,
      nextAttemptAt,
      executionLeaseExpiresAt: null,
      ...(status === "succeeded" || status === "attention" || status === "skipped"
        ? { finishedAt: now }
        : {}),
      updatedAt: now,
    }, { merge: true });
    if (
      !latestCapability.exists
      || !latestConnection.exists
      || !activeConnectionStatuses.has(String(latestConnection.data()?.status))
    ) return;
    if (
      Number(latestConnection.data()?.syncGeneration || 0)
        !== Number(runData.connectionGeneration || 0)
      || Number(latestCapability.data()?.syncGeneration || 0)
        !== Number(runData.capabilityGeneration || 0)
    ) {
      const ownsActiveRun = capabilityStats.activeRunId === input.runId;
      const ownsPendingRun = capabilityStats.pendingRunId === input.runId;
      if (ownsActiveRun || ownsPendingRun) {
        transaction.set(capability, {
          stats: {
            ...(ownsActiveRun ? { activeRunId: null } : {}),
            ...(ownsPendingRun ? { pendingRunId: null } : {}),
            syncHealth: capabilityStats.lastReconciledAt || capabilityStats.lastSyncAt
              ? "fresh"
              : "unmeasured",
          },
          updatedAt: now,
        }, { merge: true });
      }
      return;
    }
    const ownsActiveRun = capabilityStats.activeRunId === input.runId;
    const pendingRunId = typeof capabilityStats.pendingRunId === "string"
      ? capabilityStats.pendingRunId
      : null;
    const hasPendingRun = Boolean(pendingRunId && pendingRunId !== input.runId);
    const promotesPendingRun = status !== "retry_scheduled" && ownsActiveRun && hasPendingRun;
    const nextActiveRunId = status === "retry_scheduled"
      ? input.runId
      : promotesPendingRun
        ? pendingRunId
      : ownsActiveRun
        ? null
        : capabilityStats.activeRunId || null;
    const syncHealth: ConnectorSyncHealth = status === "attention"
      ? "attention"
      : status === "retry_scheduled"
        ? "retrying"
        : hasPendingRun
          ? "syncing"
          : status === "skipped"
            ? "unmeasured"
            : "fresh";
    transaction.set(capability, {
      status: capabilityStatus,
      stats: {
        activeRunId: nextActiveRunId,
        pendingRunId: promotesPendingRun ? null : pendingRunId,
        latestRunId: hasPendingRun && status !== "attention"
          ? pendingRunId
          : input.runId,
        syncHealth,
        lastAttemptAt: now,
        ...(status === "succeeded" ? {
          lastSuccessAt: now,
          lastReconciledAt: now,
          lastSyncAt: now,
          lastError: null,
        } : {
          lastError: error,
        }),
        nextRetryAt: nextAttemptAt,
      },
      updatedAt: now,
    }, { merge: true });
    if (hasReauthorizationFailure) {
      transaction.set(latestConnectionRef, {
        status: "attention",
        reauthorizationRequired: true,
        stats: { lastError: error },
        updatedAt: now,
      }, { merge: true });
    }
  });
  await refreshConnectorSyncAggregates({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId: runData.capabilityId as SourceCapabilityId,
    serviceId: runData.serviceId as CapabilityServiceId,
  }, deps);
  return runResult;
}

export async function refreshConnectorSyncAggregates(input: {
  companyId: string;
  connectionId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
}, deps: ConnectorSyncDependencies): Promise<void> {
  const connection = connectionRef({ ...input, database: deps.database });
  const capability = capabilityRef({ ...input, database: deps.database });
  const [connectionSnapshot, capabilitySnapshot, resourcesSnapshot] = await Promise.all([
    connection.get(),
    capability.get(),
    connection.collection("resources")
      .where("capabilityId", "==", input.capabilityId)
      .where("status", "==", "enabled")
      .get(),
  ]);
  if (!connectionSnapshot.exists || !capabilitySnapshot.exists) return;
  const resources = resourcesSnapshot.docs.map((document) => document.data());
  const capabilityData = capabilitySnapshot.data() || {};
  const capabilityStats = capabilityData.stats || {};
  const itemCount = resources.reduce((sum, resource) => sum + Number(resource.itemCount || 0), 0);
  const lastChangeObservedAt = latestTimestamp(resources.map(
    (resource) => resource.sync?.lastChangeObservedAt || resource.lastObservedAt,
  ));
  await capability.set({
    stats: {
      itemCount,
      ...(resources.length === 0 && !capabilityStats.activeRunId
        ? { syncHealth: "unmeasured" satisfies ConnectorSyncHealth }
        : {}),
      lastObservedAt: lastChangeObservedAt || capabilityStats.lastObservedAt || null,
      lastChangeObservedAt: lastChangeObservedAt || capabilityStats.lastChangeObservedAt || null,
    },
  }, { merge: true });

  const capabilitiesSnapshot = await connection.collection("capabilities").get();
  const activeCapabilities = capabilitiesSnapshot.docs.filter(
    (document) => document.data().status !== "disabled",
  );
  const capabilityValues = activeCapabilities.map((document) => document.data());
  const attention = capabilityValues.find((value) => (
    value.status === "attention" || value.status === "reauthorization_required"
  ));
  const aggregateItemCount = capabilityValues.reduce(
    (sum, value) => sum + Number(value.stats?.itemCount || 0),
    0,
  );
  const lastAttemptAt = latestTimestamp(capabilityValues.map((value) => value.stats?.lastAttemptAt));
  const lastSuccessAt = earliestCompleteTimestamp(capabilityValues.map(
    (value) => value.stats?.lastSuccessAt || value.stats?.lastSyncAt,
  ));
  const lastReconciledAt = earliestCompleteTimestamp(capabilityValues.map(
    (value) => value.stats?.lastReconciledAt || value.stats?.lastSyncAt,
  ));
  const aggregateLastObservedAt = latestTimestamp(capabilityValues.map(
    (value) => value.stats?.lastChangeObservedAt || value.stats?.lastObservedAt,
  ));
  const capabilityHealth = capabilityValues.map((value) => (
    value.stats?.syncHealth
    || (value.stats?.lastReconciledAt || value.stats?.lastSyncAt ? "fresh" : "never_synced")
  ));
  const syncHealth: ConnectorSyncHealth = attention
    ? "attention"
    : capabilityHealth.includes("retrying")
      ? "retrying"
      : capabilityHealth.includes("syncing")
        ? "syncing"
        : capabilityHealth.includes("never_synced")
          ? "never_synced"
          : capabilityHealth.includes("unmeasured")
            ? "unmeasured"
            : capabilityValues.length > 0
              ? "fresh"
              : "unmeasured";
  if (!activeConnectionStatuses.has(String(connectionSnapshot.data()?.status))) return;
  await connection.set({
    status: attention ? "attention" : "active",
    stats: {
      itemCount: aggregateItemCount,
      syncHealth,
      lastAttemptAt,
      lastSuccessAt,
      lastReconciledAt,
      lastSyncAt: lastReconciledAt,
      lastChangeObservedAt: aggregateLastObservedAt,
      lastObservedAt: aggregateLastObservedAt,
      lastError: attention?.stats?.lastError || null,
    },
  }, { merge: true });
}

export type DueConnectorSyncRun = {
  runId: string;
  companyId: string;
  connectionId: string;
  serviceId: CapabilityServiceId;
};

export async function listDueConnectorSyncRuns(input: {
  serviceId: CapabilityServiceId;
  limit?: number;
}, deps: ConnectorSyncDependencies): Promise<DueConnectorSyncRun[]> {
  const now = clock(deps);
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const [queued, scheduled, abandoned] = await Promise.all([
    deps.database.collectionGroup("syncRuns")
      .where("serviceId", "==", input.serviceId)
      .where("status", "==", "queued")
      .where("queuedAt", "<=", Timestamp.fromMillis(now.toMillis() - 60_000))
      .limit(limit)
      .get(),
    deps.database.collectionGroup("syncRuns")
      .where("serviceId", "==", input.serviceId)
      .where("status", "==", "retry_scheduled")
      .where("nextAttemptAt", "<=", now)
      .limit(limit)
      .get(),
    deps.database.collectionGroup("syncRuns")
      .where("serviceId", "==", input.serviceId)
      .where("status", "==", "running")
      .where("executionLeaseExpiresAt", "<=", now)
      .limit(limit)
      .get(),
  ]);
  const due = new Map(
    [...queued.docs, ...scheduled.docs, ...abandoned.docs].map((run) => [run.ref.path, run]),
  );
  return [...due.values()].slice(0, limit).flatMap((run) => {
    const data = run.data();
    const companyId = String(data.companyId || "");
    const connectionId = String(data.connectionId || "");
    if (!companyId || !connectionId) return [];
    return [{
      runId: run.id,
      companyId,
      connectionId,
      serviceId: input.serviceId,
    }];
  });
}

export async function replayableConnectorSyncResources(input: {
  companyId: string;
  connectionId: string;
  runId: string;
  capabilityId: SourceCapabilityId;
  serviceId: CapabilityServiceId;
}, deps: ConnectorSyncDependencies): Promise<string[]> {
  const prior = await syncRunRef({ ...input, database: deps.database }).get();
  if (
    !prior.exists
    || prior.data()?.companyId !== input.companyId
    || prior.data()?.connectionId !== input.connectionId
    || prior.data()?.capabilityId !== input.capabilityId
    || prior.data()?.serviceId !== input.serviceId
    || prior.data()?.status !== "attention"
  ) throw new Error("Only an attention-required connector sync run can be replayed");
  return Array.isArray(prior.data()?.failedResourceIds)
    ? prior.data()!.failedResourceIds.map(String)
    : [];
}

export function connectorSyncPublicState(
  statsValue: unknown,
  options?: { staleAfterMs?: number; nowMs?: number; fallbackObservedAt?: unknown },
): Record<string, unknown> {
  const stats = (statsValue && typeof statsValue === "object"
    ? statsValue
    : {}) as Record<string, unknown>;
  const lastReconciledAt = stats.lastReconciledAt || stats.lastSyncAt || null;
  let health = String(
    stats.health || stats.syncHealth || (lastReconciledAt ? "fresh" : "never_synced"),
  );
  const reconciledMillis = timestampMillis(lastReconciledAt);
  if (
    health === "fresh"
    && options?.staleAfterMs
    && reconciledMillis !== null
    && (options.nowMs || Date.now()) - reconciledMillis > options.staleAfterMs
  ) health = "stale";
  return jsonSafe({
    health,
    latestRunId: typeof stats.latestRunId === "string" ? stats.latestRunId : null,
    lastAttemptAt: stats.lastAttemptAt || null,
    lastSuccessAt: stats.lastSuccessAt || stats.lastSyncAt || null,
    lastChangeObservedAt: stats.lastChangeObservedAt
      || stats.lastObservedAt
      || options?.fallbackObservedAt
      || null,
    lastReconciledAt,
    nextRetryAt: stats.nextRetryAt || null,
    lastError: typeof stats.lastError === "string" ? stats.lastError : null,
  }) as Record<string, unknown>;
}
