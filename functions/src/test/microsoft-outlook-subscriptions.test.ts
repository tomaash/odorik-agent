import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import { queueMicrosoftGraphNotifications } from "../connectors/microsoft-outlook-subscriptions.js";
import { sha256Hex } from "../hash.js";
import { MemoryFirestore } from "./firestore-harness.js";

const now = Timestamp.fromDate(new Date("2026-08-17T12:00:00.000Z"));

test("Microsoft notifications validate clientState and queue replay-idempotently", async () => {
  const memory = new MemoryFirestore();
  memory.seed("microsoftGraphSubscriptions/subscription-doc", {
    companyId: "company-1",
    connectionId: "microsoft-1",
    providerSubscriptionId: "graph-subscription-1",
    clientStateHash: sha256Hex("correct-secret"),
    status: "active",
  });
  const valid = {
    id: "notification-1",
    subscriptionId: "graph-subscription-1",
    clientState: "correct-secret",
    changeType: "updated",
    resource: "me/mailFolders('inbox')/messages/message-1",
    resourceData: { id: "message-1" },
  };
  const first = await queueMicrosoftGraphNotifications({
    notifications: [valid, { ...valid, id: "invalid", clientState: "wrong-secret" }],
    database: memory.asFirestore(),
    now: () => now,
  });
  assert.deepEqual(first, { queued: 1, duplicate: 0, ignored: 1 });
  const second = await queueMicrosoftGraphNotifications({
    notifications: [valid], database: memory.asFirestore(), now: () => now,
  });
  assert.deepEqual(second, { queued: 0, duplicate: 1, ignored: 0 });
  const queued = memory.list("microsoftGraphNotifications");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.status, "queued");
  assert.equal(queued[0]?.companyId, "company-1");
});

test("subscription lifecycle removal is durable and still wakes delta recovery", async () => {
  const memory = new MemoryFirestore();
  memory.seed("microsoftGraphSubscriptions/subscription-doc", {
    companyId: "company-1",
    connectionId: "microsoft-1",
    providerSubscriptionId: "graph-subscription-1",
    clientStateHash: sha256Hex("correct-secret"),
    status: "active",
  });
  const result = await queueMicrosoftGraphNotifications({
    notifications: [{
      id: "lifecycle-1",
      subscriptionId: "graph-subscription-1",
      clientState: "correct-secret",
      lifecycleEvent: "subscriptionRemoved",
    }],
    database: memory.asFirestore(),
    now: () => now,
  });
  assert.equal(result.queued, 1);
  assert.equal(memory.read("microsoftGraphSubscriptions/subscription-doc")?.status, "removed");
  assert.equal(memory.list("microsoftGraphNotifications").length, 1);
});
