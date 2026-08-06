import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFirestore } from "./firestore-harness.js";
import { chatNotificationPath, deliverApprovalNotifications } from "../chat/deliver.js";
import { SlackApiError } from "../chat/slack.js";
import { SlackNotifyGrantMissingError } from "../connectors/slack-oauth.js";

const companyId = "company-1";
const connectionId = "slack_abc";
const channelId = "C123";
const appOrigin = "https://app.agenterik.cz";
const credentialKey = Buffer.alloc(32, 7).toString("base64");

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    decisionStatus: "pending",
    approverName: "Tomáš Holas",
    access: { visibility: "company" },
    scope: { caseId: "case-9", contactId: "contact-1", callId: "call-1" },
    action: { kind: "mail.draft.create", to: ["buyer@acme.cz"], body: "secret body" },
    ...overrides,
  };
}

function seedDestination(memory: MemoryFirestore, overrides: Record<string, unknown> = {}) {
  const connectionPath = `companies/${companyId}/connections/${connectionId}`;
  memory.seed(connectionPath, {
    connectorId: "slack",
    status: "active",
    ...overrides,
  });
  memory.seed(`${connectionPath}/resources/channel_1`, {
    connectionId,
    capabilityId: "action.chat.notify",
    resourceType: "channel",
    externalId: channelId,
    displayName: "#sales",
    status: "enabled",
  });
}

function deliveryDependencies(posts: { count: number }) {
  return {
    authorize: async () => ({ botToken: "xoxb-test", teamId: "T1" }),
    post: async () => {
      posts.count += 1;
      return {
        channelId,
        messageTs: "1717.0001",
        permalink: "https://acme.slack.com/archives/C123/p17170001",
      };
    },
  };
}

test("one approval posts once per destination, however often the trigger fires", async () => {
  const memory = new MemoryFirestore();
  seedDestination(memory);
  const posts = { count: 0 };
  const input = {
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database: memory.asFirestore(),
    ...deliveryDependencies(posts),
  };

  const first = await deliverApprovalNotifications(input);
  const second = await deliverApprovalNotifications(input);
  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 0, "a re-fired trigger must not post again");
  assert.equal(posts.count, 1);

  const record = memory.read(chatNotificationPath(companyId, "approval-1", channelId));
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.messageTs, "1717.0001");
});

test("a restricted approval reaches no channel at all", async () => {
  const memory = new MemoryFirestore();
  seedDestination(memory);
  const posts = { count: 0 };
  const result = await deliverApprovalNotifications({
    companyId,
    approval: pendingApproval({
      access: { visibility: "restricted", memberIds: ["member-1"] },
    }),
    appOrigin,
    credentialKey,
    database: memory.asFirestore(),
    ...deliveryDependencies(posts),
  });
  assert.equal(result.skipped, "not_notifiable");
  assert.equal(posts.count, 0);
});

test("no configured destination is a quiet no-op, not a failure", async () => {
  const memory = new MemoryFirestore();
  const posts = { count: 0 };
  const result = await deliverApprovalNotifications({
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database: memory.asFirestore(),
    ...deliveryDependencies(posts),
  });
  assert.equal(result.skipped, "no_destination");
  assert.equal(posts.count, 0);
});

test("a retryable failure can be retried; an unknown outcome cannot", async () => {
  const memory = new MemoryFirestore();
  seedDestination(memory);
  let attempt = 0;
  const database = memory.asFirestore();
  const base = {
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database,
    authorize: async () => ({ botToken: "xoxb-test", teamId: "T1" }),
  };

  // A terminal Slack error: nothing was posted, so a later attempt is free to try.
  await deliverApprovalNotifications({
    ...base,
    post: async () => {
      attempt += 1;
      throw new SlackApiError({
        label: "post",
        status: 200,
        slackError: "channel_not_found",
      });
    },
  });
  const path = chatNotificationPath(companyId, "approval-1", channelId);
  assert.equal(memory.read(path)?.status, "failed_safe_to_retry");

  await deliverApprovalNotifications({
    ...base,
    post: async () => {
      attempt += 1;
      throw new Error("fetch failed");
    },
  });
  assert.equal(attempt, 2, "a retryable failure is retried");
  assert.equal(
    memory.read(path)?.status,
    "outcome_unknown",
    "a dead connection may have carried the message",
  );

  // From outcome_unknown, nothing may post again without a human.
  await deliverApprovalNotifications({
    ...base,
    post: async () => {
      attempt += 1;
      throw new Error("must not post from an unknown outcome");
    },
  });
  assert.equal(attempt, 2, "an unknown outcome is never blindly retried");
});

test("a missing Slack grant is recorded and never fails the approval", async () => {
  const memory = new MemoryFirestore();
  seedDestination(memory);
  const result = await deliverApprovalNotifications({
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database: memory.asFirestore(),
    authorize: async () => {
      throw new SlackNotifyGrantMissingError();
    },
    post: async () => {
      throw new Error("must not post without a grant");
    },
  });
  assert.equal(result.delivered, 0);
  const record = memory.read(chatNotificationPath(companyId, "approval-1", channelId));
  assert.equal(record?.status, "failed_safe_to_retry");
  assert.match(String(record?.error), /Slack notifications are not enabled/);
});

test("a disabled channel and a disconnected workspace stop delivery", async () => {
  const memory = new MemoryFirestore();
  seedDestination(memory, { status: "disconnected" });
  const posts = { count: 0 };
  const disconnected = await deliverApprovalNotifications({
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database: memory.asFirestore(),
    ...deliveryDependencies(posts),
  });
  assert.equal(disconnected.skipped, "no_destination");

  const reconnected = new MemoryFirestore();
  seedDestination(reconnected);
  reconnected.seed(
    `companies/${companyId}/connections/${connectionId}/resources/channel_1`,
    {
      connectionId,
      capabilityId: "action.chat.notify",
      externalId: channelId,
      status: "disabled",
    },
  );
  const disabled = await deliverApprovalNotifications({
    companyId,
    approval: pendingApproval(),
    appOrigin,
    credentialKey,
    database: reconnected.asFirestore(),
    ...deliveryDependencies(posts),
  });
  assert.equal(disabled.skipped, "no_destination");
  assert.equal(posts.count, 0);
});
