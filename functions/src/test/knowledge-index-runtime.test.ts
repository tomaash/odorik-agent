import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  enqueueKnowledgeIndexBackfill,
  enqueueKnowledgeIndexDelivery,
  executeKnowledgeIndexDelivery,
  getKnowledgeIndexStatus,
  knowledgeIndexDeliveryId,
  knowledgeIndexLeaseMs,
  recoverDueKnowledgeIndexDeliveries,
  replayKnowledgeIndexDelivery,
  type KnowledgeIndexCompletion,
  type KnowledgeIndexDependencies,
} from "../knowledge-index-runtime.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "explorers";
const collection = "contextItems";
const recordId = "drive-file-1";
const deliveryId = knowledgeIndexDeliveryId(collection, recordId);
const deliveryPath = `companies/${companyId}/knowledgeIndexDeliveries/${deliveryId}`;

function fixture(synchronize?: KnowledgeIndexDependencies["synchronize"]) {
  const memory = new MemoryFirestore();
  let now = Timestamp.fromDate(new Date("2026-08-02T10:00:00.000Z"));
  const defaultCompletion: KnowledgeIndexCompletion = {
    kind: "context_item",
    recordId,
    action: "upserted",
    points: 1,
  };
  const dependencies: KnowledgeIndexDependencies = {
    database: memory.asFirestore(),
    now: () => now,
    synchronize: synchronize || (async () => defaultCompletion),
  };
  return {
    memory,
    dependencies,
    now: () => now,
    advance(milliseconds: number) {
      now = Timestamp.fromMillis(now.toMillis() + milliseconds);
    },
    enqueue(eventId = "event-1", options: {
      committedAt?: Timestamp;
      exists?: boolean;
    } = {}) {
      return enqueueKnowledgeIndexDelivery({
        companyId,
        collection,
        recordId,
        eventId,
        sourceCommittedAt: options.committedAt || now,
        sourceExists: options.exists ?? true,
        sourceData: {
          indexingEnabled: options.exists ?? true,
          source: {
            adapterId: "google_drive",
            capabilityId: "context.document.read",
            connectionId: "google-1",
            resourceId: "folder-1",
          },
        },
      }, dependencies);
    },
  };
}

test("knowledge-index delivery records measurable success and ignores duplicate or older events", async () => {
  const context = fixture();
  const committedAt = context.now();
  const queued = await context.enqueue("event-1", { committedAt });
  assert.equal(queued.skipped, false);
  context.advance(2_000);
  const result = await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  assert.deepEqual(result, {
    deliveryId,
    status: "succeeded",
    attempt: 1,
    generation: 1,
    action: "upserted",
    points: 1,
    nextAttemptAt: null,
  });
  assert.equal(context.memory.read(deliveryPath)?.contextToSearchMs, 2_000);
  assert.deepEqual(
    (context.memory.read(deliveryPath)?.sourceScope || {}),
    {
      adapterId: "google_drive",
      capabilityId: "context.document.read",
      connectionId: "google-1",
      resourceId: "folder-1",
    },
  );

  const duplicate = await context.enqueue("event-1", { committedAt });
  assert.equal(duplicate.reason, "duplicate_event");
  const older = await context.enqueue("event-old", {
    committedAt: Timestamp.fromMillis(committedAt.toMillis() - 1),
  });
  assert.equal(older.reason, "older_event");
  assert.equal(context.memory.read(deliveryPath)?.generation, 1);

  const status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.health, "fresh");
  assert.equal(status.counts.succeeded, 1);
  assert.equal(status.p95ContextToSearchMs, 2_000);
  assert.equal(status.lastSuccessAt, "2026-08-02T10:00:02.000Z");
});

test("existing Firestore records remain unmeasured until an administrator queues the backfill", async () => {
  const context = fixture();
  const sourcePath = `companies/${companyId}/${collection}/${recordId}`;
  context.memory.seed(sourcePath, {
    title: "Existing document",
    indexingEnabled: true,
    source: { connectionId: "google-1", resourceId: "folder-1" },
  });
  let status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.health, "unmeasured");
  assert.equal(status.expectedRecords, 1);
  assert.equal(status.trackedRecords, 0);
  assert.equal(status.untrackedRecords, 1);

  const backfill = await enqueueKnowledgeIndexBackfill({
    companyId,
    actorUid: "admin-1",
  }, context.dependencies);
  assert.deepEqual(backfill, { examined: 1, queued: 1, alreadyTracked: 0 });
  status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.health, "indexing");
  assert.equal(status.trackedRecords, 1);
  assert.equal(status.untrackedRecords, 0);
  assert.equal((await recoverDueKnowledgeIndexDeliveries(context.dependencies))[0]?.status, "succeeded");
  status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.lastSuccessAt, "2026-08-02T10:00:00.000Z");
  assert.equal(status.p95ContextToSearchMs, null);
  assert.equal(status.freshnessSampleSize, 0);

  const repeated = await enqueueKnowledgeIndexBackfill({
    companyId,
    actorUid: "admin-1",
  }, context.dependencies);
  assert.deepEqual(repeated, { examined: 1, queued: 0, alreadyTracked: 1 });
});

test("a transient indexing failure retries only when due and then succeeds idempotently", async () => {
  let calls = 0;
  const context = fixture(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Qdrant 503: unavailable");
    return {
      kind: "context_item",
      recordId,
      action: "upserted",
      points: 2,
    };
  });
  await context.enqueue();
  const failed = await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  assert.equal(failed.status, "retrying");
  assert.equal(failed.attempt, 1);
  assert.equal(context.memory.read(deliveryPath)?.failureKind, "transient");

  context.advance(59_000);
  assert.deepEqual(await recoverDueKnowledgeIndexDeliveries(context.dependencies), []);
  context.advance(1_000);
  const recovered = await recoverDueKnowledgeIndexDeliveries(context.dependencies);
  assert.equal(recovered[0]?.status, "succeeded");
  assert.equal(recovered[0]?.attempt, 2);
  assert.equal(recovered[0]?.points, 2);
  assert.equal(calls, 2);
});

test("the fourth transient failure is bounded and remains visible for replay", async () => {
  const context = fixture(async () => {
    throw new Error("Gemini embedding 503: unavailable");
  });
  await context.enqueue();
  let result = await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  for (const delay of [60_000, 5 * 60_000, 30 * 60_000]) {
    assert.equal(result.status, "retrying");
    context.advance(delay);
    const recovered = await recoverDueKnowledgeIndexDeliveries(context.dependencies);
    assert.ok(recovered[0]);
    result = recovered[0];
  }
  assert.equal(result.status, "attention");
  assert.equal(result.attempt, 4);
  assert.equal(context.memory.read(deliveryPath)?.nextAttemptAt, null);
});

test("a permanent failure enters attention and an administrator can replay it", async () => {
  let healthy = false;
  const context = fixture(async () => {
    if (!healthy) throw new Error("Qdrant 401: unauthorized");
    return {
      kind: "context_item",
      recordId,
      action: "upserted",
      points: 1,
    };
  });
  await context.enqueue();
  const failed = await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  assert.equal(failed.status, "attention");
  let status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.health, "attention");
  assert.equal(status.attentionDeliveries[0]?.lastError, "Qdrant 401: unauthorized");
  await assert.rejects(
    replayKnowledgeIndexDelivery({
      companyId: "another-company",
      deliveryId,
      actorUid: "admin-1",
    }, context.dependencies),
    /not found/,
  );

  healthy = true;
  const replayed = await replayKnowledgeIndexDelivery({
    companyId,
    deliveryId,
    actorUid: "admin-1",
  }, context.dependencies);
  assert.equal(replayed.status, "succeeded");
  assert.equal(replayed.generation, 2);
  assert.equal(context.memory.read(deliveryPath)?.requestedBy, "admin-1");
  status = await getKnowledgeIndexStatus(companyId, context.dependencies.database);
  assert.equal(status.health, "fresh");
  assert.equal(status.counts.attention, 0);
});

test("a source change during execution becomes a fenced successor generation", async () => {
  let calls = 0;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const context = fixture(async () => {
    calls += 1;
    if (calls === 1) {
      announceStarted();
      await firstMayFinish;
    }
    return {
      kind: "context_item",
      recordId,
      action: "upserted",
      points: calls,
    };
  });
  await context.enqueue("event-1");
  const execution = executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  await started;
  context.advance(1_000);
  const successor = await context.enqueue("event-2");
  assert.equal(successor.generation, 2);
  assert.equal(context.memory.read(deliveryPath)?.status, "running");
  releaseFirst();
  const result = await execution;

  assert.equal(result.status, "succeeded");
  assert.equal(result.generation, 2);
  assert.equal(result.attempt, 1);
  assert.equal(result.points, 2);
  assert.equal(calls, 2);
  assert.equal(context.memory.read(deliveryPath)?.deliveredGeneration, 2);
});

test("an expired lease is reclaimed and its older worker cannot overwrite completion state", async () => {
  let calls = 0;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let releaseOldWorker!: () => void;
  const oldWorkerMayFinish = new Promise<void>((resolve) => { releaseOldWorker = resolve; });
  const context = fixture(async () => {
    calls += 1;
    if (calls === 1) {
      announceStarted();
      await oldWorkerMayFinish;
      return {
        kind: "context_item",
        recordId,
        action: "upserted",
        points: 1,
      };
    }
    return {
      kind: "context_item",
      recordId,
      action: "upserted",
      points: 2,
    };
  });
  await context.enqueue();
  const oldExecution = executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  await started;
  context.advance(knowledgeIndexLeaseMs + 1);
  const recovered = await recoverDueKnowledgeIndexDeliveries(context.dependencies);
  assert.equal(recovered[0]?.status, "succeeded");
  assert.equal(recovered[0]?.attempt, 2);
  assert.equal(recovered[0]?.points, 2);

  releaseOldWorker();
  await oldExecution;
  assert.equal(context.memory.read(deliveryPath)?.points, 2);
  assert.equal(context.memory.read(deliveryPath)?.attempt, 2);
  assert.equal(calls, 2);
});

test("deletion is delivered and runtime records never recursively enqueue themselves", async () => {
  const sourcePath = `companies/${companyId}/${collection}/${recordId}`;
  const context = fixture(async () => ({
    kind: "context_item",
    recordId,
    action: context.memory.read(sourcePath) ? "upserted" : "deleted",
    points: context.memory.read(sourcePath) ? 1 : 0,
  }));
  context.memory.seed(sourcePath, { title: "Current document", indexingEnabled: true });
  await context.enqueue("event-create");
  assert.equal(
    (await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies)).action,
    "upserted",
  );

  context.advance(1_000);
  context.memory.remove(sourcePath);
  await context.enqueue("event-delete", { exists: false });
  const deleted = await executeKnowledgeIndexDelivery({ companyId, deliveryId }, context.dependencies);
  assert.equal(deleted.action, "deleted");
  assert.equal(deleted.points, 0);
  assert.ok(context.memory.read(deliveryPath)?.expiresAt instanceof Timestamp);

  const recursive = await enqueueKnowledgeIndexDelivery({
    companyId,
    collection: "knowledgeIndexDeliveries",
    recordId: deliveryId,
    eventId: "delivery-write",
    sourceExists: true,
  }, context.dependencies);
  assert.deepEqual(recursive, { skipped: true, reason: "collection_not_indexed" });
  const publicStatus = JSON.stringify(
    await getKnowledgeIndexStatus(companyId, context.dependencies.database),
  );
  assert.doesNotMatch(publicStatus, /executionLease|leaseToken|nextAttemptAt/);
});
