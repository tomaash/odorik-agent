import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import {
  collectionByKnowledgeKind,
  knowledgeKindForCollection,
} from "./agent/knowledge.js";
import type { KnowledgeKind } from "./agent/types.js";
import { sha256Hex } from "./hash.js";

export type KnowledgeIndexDeliveryStatus =
  | "queued"
  | "running"
  | "retrying"
  | "attention"
  | "succeeded";

export type KnowledgeIndexHealth =
  | "unmeasured"
  | "indexing"
  | "retrying"
  | "attention"
  | "fresh";

export type KnowledgeIndexCompletion = {
  kind: KnowledgeKind;
  recordId: string;
  action: "upserted" | "deleted";
  points: number;
};

export type KnowledgeIndexDependencies = {
  database: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
  synchronize: (input: {
    companyId: string;
    collection: string;
    recordId: string;
  }) => Promise<KnowledgeIndexCompletion>;
};

export type KnowledgeIndexDeliveryResult = {
  deliveryId: string;
  status: KnowledgeIndexDeliveryStatus;
  attempt: number;
  generation: number;
  action?: "upserted" | "deleted" | null;
  points?: number;
  nextAttemptAt?: string | null;
};

export type KnowledgeIndexStatus = {
  health: KnowledgeIndexHealth;
  expectedRecords: number;
  trackedRecords: number;
  untrackedRecords: number;
  counts: {
    queued: number;
    running: number;
    retrying: number;
    attention: number;
    succeeded: number;
  };
  oldestOutstandingAt: string | null;
  lastSuccessAt: string | null;
  p95ContextToSearchMs: number | null;
  freshnessSampleSize: number;
  freshnessSampleTruncated: boolean;
  targetMs: number;
  attentionDeliveries: Array<{
    id: string;
    kind: KnowledgeKind;
    recordId: string;
    sourcePath: string;
    attempt: number;
    lastError: string | null;
    lastAttemptAt: string | null;
    sourceCommittedAt: string | null;
  }>;
};

export const knowledgeIndexLeaseMs = 12 * 60 * 1_000;
export const knowledgeIndexMaxAttempts = 4;
export const knowledgeIndexRetryDelaysMs = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const knowledgeIndexFreshnessTargetMs = 2 * 60 * 1_000;
const deletedDeliveryRetentionMs = 90 * 24 * 60 * 60 * 1_000;
const freshnessSampleLimit = 1_000;

function clock(dependencies: KnowledgeIndexDependencies): Timestamp {
  return dependencies.now?.() || Timestamp.now();
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value && typeof value === "object" && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return Number((value as { toMillis(): number }).toMillis());
  }
  return null;
}

function timestampIso(value: unknown): string | null {
  const millis = timestampMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function deliveryRef(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  deliveryId: string;
}): FirebaseFirestore.DocumentReference {
  return input.database.doc(
    `companies/${input.companyId}/knowledgeIndexDeliveries/${input.deliveryId}`,
  );
}

export function knowledgeIndexDeliveryId(collection: string, recordId: string): string {
  return `idx_${sha256Hex(`${collection}/${recordId}`)}`;
}

export function sanitizeKnowledgeIndexError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export function classifyKnowledgeIndexError(error: unknown): "transient" | "permanent" {
  const name = String((error as { name?: unknown })?.name || "");
  const message = sanitizeKnowledgeIndexError(error).toLowerCase();
  if (
    name === "AbortError"
    || name === "TimeoutError"
    || /\b(408|409|425|429|5\d\d)\b/.test(message)
    || /\b(timeout|timed out|temporar|network|fetch failed|socket|econnreset|rate limit)\b/.test(message)
    || /\b(resource_exhausted|unavailable|deadline_exceeded)\b/.test(message)
  ) return "transient";
  return "permanent";
}

export function knowledgeIndexRetryAt(attempt: number, now: Timestamp): Timestamp | null {
  const delay = knowledgeIndexRetryDelaysMs[attempt - 1];
  return delay === undefined ? null : Timestamp.fromMillis(now.toMillis() + delay);
}

function publicResult(
  deliveryId: string,
  data: FirebaseFirestore.DocumentData,
): KnowledgeIndexDeliveryResult {
  return {
    deliveryId,
    status: data.status as KnowledgeIndexDeliveryStatus,
    attempt: Number(data.attempt || 0),
    generation: Number(data.generation || 0),
    ...(data.action === "upserted" || data.action === "deleted"
      ? { action: data.action }
      : {}),
    ...(Number.isFinite(Number(data.points)) ? { points: Number(data.points) } : {}),
    nextAttemptAt: timestampIso(data.nextAttemptAt),
  };
}

function sourceScope(value: FirebaseFirestore.DocumentData | undefined): Record<string, string> | null {
  const source = value?.source && typeof value.source === "object"
    ? value.source as Record<string, unknown>
    : null;
  if (!source) return null;
  const scope = Object.fromEntries(
    ["adapterId", "capabilityId", "connectionId", "resourceId"]
      .filter((field) => typeof source[field] === "string" && String(source[field]).length > 0)
      .map((field) => [field, String(source[field])]),
  );
  return Object.keys(scope).length > 0 ? scope : null;
}

export async function enqueueKnowledgeIndexDelivery(input: {
  companyId: string;
  collection: string;
  recordId: string;
  eventId: string;
  sourceCommittedAt?: Timestamp | Date | string | null;
  sourceExists: boolean;
  sourceData?: FirebaseFirestore.DocumentData;
  trigger?: "firestore_write" | "operator_replay" | "operator_backfill";
  requestedBy?: string | null;
}, dependencies: KnowledgeIndexDependencies): Promise<{
  skipped: boolean;
  reason?: "collection_not_indexed" | "duplicate_event" | "older_event";
  deliveryId?: string;
  generation?: number;
}> {
  const kind = knowledgeKindForCollection(input.collection);
  if (!kind) return { skipped: true, reason: "collection_not_indexed" };
  const deliveryId = knowledgeIndexDeliveryId(input.collection, input.recordId);
  const reference = deliveryRef({
    database: dependencies.database,
    companyId: input.companyId,
    deliveryId,
  });
  return dependencies.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.data() || {};
    if (current.latestEventId === input.eventId) {
      return { skipped: true, reason: "duplicate_event" as const, deliveryId };
    }
    const now = clock(dependencies);
    const committedMillis = timestampMillis(input.sourceCommittedAt) ?? now.toMillis();
    const currentCommittedMillis = timestampMillis(current.sourceCommittedAt);
    if (currentCommittedMillis !== null && committedMillis < currentCommittedMillis) {
      return { skipped: true, reason: "older_event" as const, deliveryId };
    }
    const sourceCommittedAt = Timestamp.fromMillis(Math.max(
      committedMillis,
      currentCommittedMillis || 0,
    ));
    const generation = Number(current.generation || 0) + 1;
    const activeLease = current.status === "running" && typeof current.executionLeaseToken === "string";
    const scope = sourceScope(input.sourceData)
      || (current.sourceScope && typeof current.sourceScope === "object"
        ? current.sourceScope as Record<string, string>
        : null);
    transaction.set(reference, {
      companyId: input.companyId,
      deliveryId,
      kind,
      collection: input.collection,
      recordId: input.recordId,
      sourcePath: `companies/${input.companyId}/${input.collection}/${input.recordId}`,
      sourceScope: scope,
      sourceExists: input.sourceExists,
      indexingEnabled: input.sourceData?.indexingEnabled !== false,
      freshnessEligible: input.trigger !== "operator_backfill",
      generation,
      latestEventId: input.eventId,
      sourceCommittedAt,
      trigger: input.trigger || "firestore_write",
      requestedBy: input.requestedBy || null,
      queuedAt: now,
      lastQueuedAt: now,
      ...(snapshot.exists ? {} : { createdAt: now }),
      ...(activeLease ? {} : {
        status: "queued" satisfies KnowledgeIndexDeliveryStatus,
        attempt: 0,
        nextAttemptAt: null,
        executionGeneration: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        lastError: null,
      }),
      expiresAt: null,
      updatedAt: now,
    }, { merge: true });
    return { skipped: false, deliveryId, generation };
  });
}

async function claimKnowledgeIndexDelivery(input: {
  companyId: string;
  deliveryId: string;
}, dependencies: KnowledgeIndexDependencies): Promise<{
  claimed: boolean;
  data: FirebaseFirestore.DocumentData;
  generation: number;
  attempt: number;
  leaseToken?: string;
}> {
  const reference = deliveryRef({ ...input, database: dependencies.database });
  const leaseToken = randomBytes(16).toString("hex");
  return dependencies.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error("Knowledge-index delivery not found");
    const data = snapshot.data() || {};
    const status = data.status as KnowledgeIndexDeliveryStatus;
    const now = clock(dependencies);
    const leaseExpiresAt = timestampMillis(data.executionLeaseExpiresAt) || 0;
    if (status === "running" && leaseExpiresAt > now.toMillis()) {
      return {
        claimed: false,
        data,
        generation: Number(data.generation || 0),
        attempt: Number(data.attempt || 0),
      };
    }
    if (status === "retrying") {
      const nextAttemptAt = timestampMillis(data.nextAttemptAt);
      if (nextAttemptAt !== null && nextAttemptAt > now.toMillis()) {
        return {
          claimed: false,
          data,
          generation: Number(data.generation || 0),
          attempt: Number(data.attempt || 0),
        };
      }
    }
    if (!["queued", "running", "retrying"].includes(status)) {
      return {
        claimed: false,
        data,
        generation: Number(data.generation || 0),
        attempt: Number(data.attempt || 0),
      };
    }
    const generation = Number(data.generation || 0);
    const previousExecutionGeneration = Number(data.executionGeneration || 0);
    const attempt = previousExecutionGeneration === generation
      ? Number(data.attempt || 0) + 1
      : 1;
    if (attempt > Number(data.maxAttempts || knowledgeIndexMaxAttempts)) {
      transaction.set(reference, {
        status: "attention" satisfies KnowledgeIndexDeliveryStatus,
        lastError: "Knowledge-index delivery exhausted its recovery attempts",
        nextAttemptAt: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      }, { merge: true });
      return { claimed: false, data: { ...data, status: "attention" }, generation, attempt };
    }
    const claimedData = {
      ...data,
      status: "running" satisfies KnowledgeIndexDeliveryStatus,
      attempt,
      maxAttempts: knowledgeIndexMaxAttempts,
      executionGeneration: generation,
      executionLeaseToken: leaseToken,
      executionLeaseExpiresAt: Timestamp.fromMillis(now.toMillis() + knowledgeIndexLeaseMs),
      nextAttemptAt: null,
      startedAt: now,
      lastAttemptAt: now,
      updatedAt: now,
    };
    transaction.set(reference, claimedData, { merge: true });
    return { claimed: true, data: claimedData, generation, attempt, leaseToken };
  });
}

async function completeKnowledgeIndexDelivery(input: {
  companyId: string;
  deliveryId: string;
  generation: number;
  attempt: number;
  leaseToken: string;
  completion: KnowledgeIndexCompletion;
}, dependencies: KnowledgeIndexDependencies): Promise<{ followUp: boolean }> {
  const reference = deliveryRef({ ...input, database: dependencies.database });
  return dependencies.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error("Knowledge-index delivery not found");
    const data = snapshot.data() || {};
    if (
      data.status !== "running"
      || data.executionLeaseToken !== input.leaseToken
      || Number(data.executionGeneration || 0) !== input.generation
    ) return { followUp: false };
    const now = clock(dependencies);
    if (Number(data.generation || 0) !== input.generation) {
      transaction.set(reference, {
        status: "queued" satisfies KnowledgeIndexDeliveryStatus,
        attempt: 0,
        nextAttemptAt: null,
        executionGeneration: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      }, { merge: true });
      return { followUp: true };
    }
    const sourceCommittedAt = timestampMillis(data.sourceCommittedAt) || now.toMillis();
    const contextToSearchMs = data.freshnessEligible === false
      ? null
      : Math.max(0, now.toMillis() - sourceCommittedAt);
    transaction.set(reference, {
      status: "succeeded" satisfies KnowledgeIndexDeliveryStatus,
      action: input.completion.action,
      points: input.completion.points,
      deliveredGeneration: input.generation,
      nextAttemptAt: null,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
      lastError: null,
      lastSuccessAt: now,
      searchableAt: now,
      contextToSearchMs,
      finishedAt: now,
      expiresAt: input.completion.action === "deleted"
        ? Timestamp.fromMillis(now.toMillis() + deletedDeliveryRetentionMs)
        : null,
      updatedAt: now,
    }, { merge: true });
    return { followUp: false };
  });
}

async function failKnowledgeIndexDelivery(input: {
  companyId: string;
  deliveryId: string;
  generation: number;
  attempt: number;
  leaseToken: string;
  error: unknown;
}, dependencies: KnowledgeIndexDependencies): Promise<{ followUp: boolean }> {
  const reference = deliveryRef({ ...input, database: dependencies.database });
  return dependencies.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error("Knowledge-index delivery not found");
    const data = snapshot.data() || {};
    if (
      data.status !== "running"
      || data.executionLeaseToken !== input.leaseToken
      || Number(data.executionGeneration || 0) !== input.generation
    ) return { followUp: false };
    const now = clock(dependencies);
    if (Number(data.generation || 0) !== input.generation) {
      transaction.set(reference, {
        status: "queued" satisfies KnowledgeIndexDeliveryStatus,
        attempt: 0,
        nextAttemptAt: null,
        executionGeneration: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      }, { merge: true });
      return { followUp: true };
    }
    const failureKind = classifyKnowledgeIndexError(input.error);
    const retryAt = failureKind === "transient"
      ? knowledgeIndexRetryAt(input.attempt, now)
      : null;
    const canRetry = retryAt !== null && input.attempt < knowledgeIndexMaxAttempts;
    transaction.set(reference, {
      status: canRetry
        ? "retrying" satisfies KnowledgeIndexDeliveryStatus
        : "attention" satisfies KnowledgeIndexDeliveryStatus,
      failureKind,
      lastError: sanitizeKnowledgeIndexError(input.error),
      lastFailureAt: now,
      nextAttemptAt: canRetry ? retryAt : null,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
      ...(canRetry ? {} : { finishedAt: now }),
      updatedAt: now,
    }, { merge: true });
    return { followUp: false };
  });
}

export async function executeKnowledgeIndexDelivery(input: {
  companyId: string;
  deliveryId: string;
}, dependencies: KnowledgeIndexDependencies): Promise<KnowledgeIndexDeliveryResult> {
  const reference = deliveryRef({ ...input, database: dependencies.database });
  for (let followUps = 0; followUps < 2; followUps += 1) {
    const claimed = await claimKnowledgeIndexDelivery(input, dependencies);
    if (!claimed.claimed || !claimed.leaseToken) {
      const current = await reference.get();
      if (!current.exists) throw new Error("Knowledge-index delivery not found");
      return publicResult(input.deliveryId, current.data() || claimed.data);
    }
    let followUp = false;
    try {
      const completion = await dependencies.synchronize({
        companyId: input.companyId,
        collection: String(claimed.data.collection),
        recordId: String(claimed.data.recordId),
      });
      ({ followUp } = await completeKnowledgeIndexDelivery({
        ...input,
        generation: claimed.generation,
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        completion,
      }, dependencies));
    } catch (error) {
      ({ followUp } = await failKnowledgeIndexDelivery({
        ...input,
        generation: claimed.generation,
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        error,
      }, dependencies));
    }
    if (!followUp) break;
  }
  const current = await reference.get();
  if (!current.exists) throw new Error("Knowledge-index delivery not found");
  return publicResult(input.deliveryId, current.data() || {});
}

export async function replayKnowledgeIndexDelivery(input: {
  companyId: string;
  deliveryId: string;
  actorUid: string;
}, dependencies: KnowledgeIndexDependencies): Promise<KnowledgeIndexDeliveryResult> {
  const reference = deliveryRef({ ...input, database: dependencies.database });
  await dependencies.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error("Knowledge-index delivery not found");
    const data = snapshot.data() || {};
    if (data.status !== "attention") {
      throw new Error("Only a knowledge-index delivery needing attention can be replayed");
    }
    const now = clock(dependencies);
    transaction.set(reference, {
      status: "queued" satisfies KnowledgeIndexDeliveryStatus,
      generation: Number(data.generation || 0) + 1,
      attempt: 0,
      trigger: "operator_replay",
      requestedBy: input.actorUid,
      queuedAt: now,
      lastQueuedAt: now,
      nextAttemptAt: null,
      executionGeneration: null,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
      lastError: null,
      expiresAt: null,
      updatedAt: now,
    }, { merge: true });
  });
  return executeKnowledgeIndexDelivery(input, dependencies);
}

export async function enqueueKnowledgeIndexBackfill(input: {
  companyId: string;
  actorUid: string;
}, dependencies: KnowledgeIndexDependencies): Promise<{
  examined: number;
  queued: number;
  alreadyTracked: number;
}> {
  let examined = 0;
  let queued = 0;
  let alreadyTracked = 0;
  const now = clock(dependencies);
  for (const collection of Object.values(collectionByKnowledgeKind)) {
    const snapshot = await dependencies.database
      .collection(`companies/${input.companyId}/${collection}`)
      .get();
    for (const document of snapshot.docs) {
      examined += 1;
      const committedAt = document.updateTime || now;
      const result = await enqueueKnowledgeIndexDelivery({
        companyId: input.companyId,
        collection,
        recordId: document.id,
        eventId: `backfill:${document.id}:${committedAt.toMillis()}`,
        sourceCommittedAt: committedAt,
        sourceExists: true,
        sourceData: document.data(),
        trigger: "operator_backfill",
        requestedBy: input.actorUid,
      }, dependencies);
      if (result.skipped) alreadyTracked += 1;
      else queued += 1;
    }
  }
  return { examined, queued, alreadyTracked };
}

export async function recoverDueKnowledgeIndexDeliveries(
  dependencies: KnowledgeIndexDependencies,
  limit = 50,
): Promise<KnowledgeIndexDeliveryResult[]> {
  const now = clock(dependencies);
  const group = dependencies.database.collectionGroup("knowledgeIndexDeliveries");
  const [queued, retrying, expired] = await Promise.all([
    group.where("status", "==", "queued").limit(limit).get(),
    group.where("status", "==", "retrying")
      .where("nextAttemptAt", "<=", now)
      .limit(limit)
      .get(),
    group.where("status", "==", "running")
      .where("executionLeaseExpiresAt", "<=", now)
      .limit(limit)
      .get(),
  ]);
  const due = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const snapshot of [queued, retrying, expired]) {
    for (const document of snapshot.docs) due.set(document.ref.path, document);
  }
  const results: KnowledgeIndexDeliveryResult[] = [];
  for (const document of [...due.values()].slice(0, limit)) {
    const companyId = String(document.data().companyId || "");
    if (!companyId) continue;
    results.push(await executeKnowledgeIndexDelivery({
      companyId,
      deliveryId: document.id,
    }, dependencies));
  }
  return results;
}

async function queryCount(query: FirebaseFirestore.Query): Promise<number> {
  const result = await query.count().get();
  return result.data().count;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
}

export async function getKnowledgeIndexStatus(
  companyId: string,
  database: FirebaseFirestore.Firestore,
): Promise<KnowledgeIndexStatus> {
  const collection = database.collection(`companies/${companyId}/knowledgeIndexDeliveries`);
  const statuses: KnowledgeIndexDeliveryStatus[] = [
    "queued",
    "running",
    "retrying",
    "attention",
    "succeeded",
  ];
  const sourceCollections = Object.values(collectionByKnowledgeKind);
  const [
    countValues,
    sourceCountValues,
    disabledContextCount,
    trackedCount,
    attention,
    lastSuccess,
    freshnessSuccesses,
    ...oldestSnapshots
  ] = await Promise.all([
    Promise.all(statuses.map((status) => queryCount(collection.where("status", "==", status)))),
    Promise.all(sourceCollections.map((sourceCollection) => queryCount(
      database.collection(`companies/${companyId}/${sourceCollection}`),
    ))),
    queryCount(
      database.collection(`companies/${companyId}/contextItems`)
        .where("indexingEnabled", "==", false),
    ),
    queryCount(
      collection.where("sourceExists", "==", true)
        .where("indexingEnabled", "==", true),
    ),
    collection.where("status", "==", "attention")
      .orderBy("lastAttemptAt", "desc")
      .limit(20)
      .get(),
    collection.where("status", "==", "succeeded")
      .orderBy("lastSuccessAt", "desc")
      .limit(1)
      .get(),
    collection.where("status", "==", "succeeded")
      .where("freshnessEligible", "==", true)
      .orderBy("lastSuccessAt", "desc")
      .limit(freshnessSampleLimit)
      .get(),
    ...(["queued", "running", "retrying"] as const).map((status) => (
      collection.where("status", "==", status)
        .orderBy("queuedAt", "asc")
        .limit(1)
        .get()
    )),
  ]);
  const counts = Object.fromEntries(
    statuses.map((status, index) => [status, countValues[index] || 0]),
  ) as KnowledgeIndexStatus["counts"];
  const expectedRecords = Math.max(
    0,
    sourceCountValues.reduce((sum, count) => sum + count, 0) - disabledContextCount,
  );
  const trackedRecords = Math.min(expectedRecords, trackedCount);
  const untrackedRecords = Math.max(0, expectedRecords - trackedRecords);
  const oldestOutstandingAt = oldestSnapshots
    .flatMap((snapshot) => snapshot.docs.map((document) => timestampMillis(document.data().queuedAt)))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
  const durations = freshnessSuccesses.docs
    .map((document) => document.data().contextToSearchMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const lastSuccessAt = lastSuccess.docs
    .map((document) => timestampMillis(document.data().lastSuccessAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  const health: KnowledgeIndexHealth = counts.attention > 0
    ? "attention"
    : counts.retrying > 0
      ? "retrying"
      : counts.queued > 0 || counts.running > 0
        ? "indexing"
        : untrackedRecords > 0
          ? "unmeasured"
          : counts.succeeded > 0
          ? "fresh"
          : "unmeasured";
  return {
    health,
    expectedRecords,
    trackedRecords,
    untrackedRecords,
    counts,
    oldestOutstandingAt: oldestOutstandingAt === null
      ? null
      : new Date(oldestOutstandingAt).toISOString(),
    lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
    p95ContextToSearchMs: percentile95(durations),
    freshnessSampleSize: durations.length,
    freshnessSampleTruncated: freshnessSuccesses.size >= freshnessSampleLimit,
    targetMs: knowledgeIndexFreshnessTargetMs,
    attentionDeliveries: attention.docs.map((document) => {
      const data = document.data();
      return {
        id: document.id,
        kind: data.kind as KnowledgeKind,
        recordId: String(data.recordId || ""),
        sourcePath: String(data.sourcePath || ""),
        attempt: Number(data.attempt || 0),
        lastError: typeof data.lastError === "string" ? data.lastError : null,
        lastAttemptAt: timestampIso(data.lastAttemptAt),
        sourceCommittedAt: timestampIso(data.sourceCommittedAt),
      };
    }),
  };
}
