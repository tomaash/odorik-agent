import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import {
  backfillLegacyConversationRetentionMetadata,
  conversationContentRetentionMs,
  conversationRetentionMetadata,
  inspectMemberConversationData,
  redactExpiredConversationContent,
  redactExternalConversationsForConnection,
  redactMemberConversationData,
} from "../agent/conversation-retention.js";
import { memberThreadDocumentId } from "../agent/threads.js";
import {
  queueSlackDmEvent,
  slackConversationEventPath,
  slackConversationId,
  type QueuedSlackDmEvent,
} from "../chat/slack-events.js";
import { MemoryFirestore } from "./firestore-harness.js";
import { sha256Hex } from "../hash.js";

const companyId = "acme";
const actorUid = "member-1";
const threadId = "slack_retained";
const threadPath = `companies/${companyId}/agentThreads/${memberThreadDocumentId(actorUid, threadId)}`;

test("conversation retention is exactly bounded and inspectable only through the owned thread", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const activityAtMs = 10_000;
  const metadata = conversationRetentionMetadata(activityAtMs);
  assert.equal(metadata.contentExpiresAt.toMillis(), activityAtMs + conversationContentRetentionMs);

  memory.seed(threadPath, {
    ownerUid: actorUid,
    clientThreadId: threadId,
    boundSurface: "slack_dm",
    memoryGeneration: 3,
    activeSessionId: "session_3_000003",
    ...metadata,
  });
  memory.seed(`${threadPath}/messages/message-1`, { text: "retained", memoryGeneration: 3 });
  memory.seed(`${threadPath}/messages/message-2`, { contentRedacted: true, memoryGeneration: 2 });
  memory.seed(`${threadPath}/sessions/session_3_000003`, { state: {}, memoryGeneration: 3 });
  const inspected = await inspectMemberConversationData({
    companyId, actorUid, threadId, database,
  });
  assert.equal(inspected.surface, "slack_dm");
  assert.equal(inspected.retentionDays, 30);
  assert.equal(inspected.retainedMessages, 1);
  assert.equal(inspected.redactedMessages, 1);
  assert.equal(inspected.memoryGeneration, 3);

  await assert.rejects(() => inspectMemberConversationData({
    companyId, actorUid: "another-member", threadId, database,
  }), /Conversation not found/);
});

test("member forget removes prior content while preserving dedupe records, current generation, and approval audit", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  memory.seed(threadPath, {
    ownerUid: actorUid,
    clientThreadId: threadId,
    title: "Sensitive customer question",
    memoryGeneration: 2,
  });
  memory.seed(`${threadPath}/messages/old-user`, {
    role: "user", text: "Sensitive customer question", originMetadata: { channelId: "D1" },
    memoryGeneration: 1,
  });
  memory.seed(`${threadPath}/messages/current-user`, {
    role: "user", text: "forget this", memoryGeneration: 2,
  });
  memory.seed(`${threadPath}/sessions/session_1_000001`, {
    state: { summary: "Sensitive summary" }, stateVersion: 4, memoryGeneration: 1,
  });
  memory.seed(`${threadPath}/sessions/session_2_000002`, {
    state: { summary: "Empty new generation" }, stateVersion: 0, memoryGeneration: 2,
  });
  memory.seed("companies/acme/agentRuns/run-old", {
    actorUid, threadId, question: "Sensitive customer question", answer: "Sensitive answer",
    toolTrace: [{ result: "Sensitive tool result" }], memoryGeneration: 1,
  });
  memory.seed("companies/acme/actionApprovals/approval-1", {
    approverUid: actorUid, effectDigest: "digest", action: { title: "Required exact effect" },
  });
  memory.seed("slackConversations/conversation-1/events/event-1", {
    companyId, actorUid, threadId, text: "Sensitive customer question",
    replyText: "Sensitive answer", eventId: "Ev-1", orderKey: "1:Ev-1",
    status: "processed", pending: false, memoryGeneration: 1,
  });
  memory.seed("slackConversations/conversation-2/events/event-2", {
    companyId: "another-company", actorUid, threadId, text: "Other tenant",
    eventId: "Ev-2", memoryGeneration: 1,
  });

  const result = await redactMemberConversationData({
    companyId, actorUid, threadId,
    reason: "member_forget",
    beforeMemoryGeneration: 2,
    database,
  });
  assert.deepEqual(result, { messages: 1, sessions: 1, runs: 1, events: 1 });
  const oldMessage = memory.read(`${threadPath}/messages/old-user`);
  assert.equal(oldMessage?.text, undefined);
  assert.equal(oldMessage?.originMetadata, undefined);
  assert.equal(oldMessage?.role, "user");
  assert.equal(oldMessage?.contentRedacted, true);
  assert.equal(memory.read(`${threadPath}/messages/current-user`)?.text, "forget this");
  assert.equal(memory.read(`${threadPath}/sessions/session_1_000001`)?.state, undefined);
  assert.equal(memory.read(`${threadPath}/sessions/session_2_000002`)?.stateVersion, 0);
  assert.equal(memory.read("companies/acme/agentRuns/run-old")?.question, undefined);
  const event = memory.read("slackConversations/conversation-1/events/event-1");
  assert.equal(event?.text, undefined);
  assert.equal(event?.replyText, undefined);
  assert.equal(event?.eventId, undefined);
  assert.equal(event?.orderKey, "1:Ev-1");
  assert.equal(event?.status, "processed");
  assert.equal(memory.read("companies/acme/actionApprovals/approval-1")?.effectDigest, "digest");
  assert.equal(memory.read("slackConversations/conversation-2/events/event-2")?.text, "Other tenant");
});

test("scheduled expiry redacts content in place and a late provider retry remains a duplicate", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const event: QueuedSlackDmEvent = {
    eventId: "Ev-expired",
    teamId: "T1",
    slackUserId: "U1",
    channelId: "D1",
    text: "Delete me after retention",
    eventTs: "100.001",
  };
  assert.equal(await queueSlackDmEvent({ event, database }), "queued");
  const eventPath = slackConversationEventPath(event);
  memory.seed(eventPath, {
    ...memory.read(eventPath),
    replyText: "Also delete me",
    contentExpiresAt: Timestamp.fromMillis(1_000),
    contentRedacted: false,
  });
  const conversationPath = `slackConversations/${slackConversationId(event)}`;
  memory.seed(conversationPath, {
    ...memory.read(conversationPath),
    contentExpiresAt: Timestamp.fromMillis(1_000),
    contentRedacted: false,
  });
  memory.seed(`${threadPath}/messages/expired`, {
    role: "user", text: "Expired thread text",
    contentExpiresAt: Timestamp.fromMillis(1_000), contentRedacted: false,
  });
  memory.seed(`${threadPath}/messages/fresh`, {
    role: "user", text: "Fresh thread text",
    contentExpiresAt: Timestamp.fromMillis(99_000), contentRedacted: false,
  });

  const result = await redactExpiredConversationContent({ nowMs: 2_000, database });
  assert.equal(result.redacted, 3);
  assert.equal(memory.read(eventPath)?.text, undefined);
  assert.equal(memory.read(eventPath)?.replyText, undefined);
  assert.equal(memory.read(`${threadPath}/messages/expired`)?.text, undefined);
  assert.equal(memory.read(`${threadPath}/messages/fresh`)?.text, "Fresh thread text");
  assert.equal(memory.read(conversationPath)?.conversationId, slackConversationId(event));
  assert.equal(await queueSlackDmEvent({ event, database }), "duplicate");
  assert.equal(memory.read(eventPath)?.text, undefined, "duplicate delivery cannot restore redacted content");
});

test("member forget also finds provider events written before explicit thread binding metadata", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const legacyThreadId = `slack_${sha256Hex(`T1:D1:${actorUid}`).slice(0, 40)}`;
  const legacyThreadPath = `companies/${companyId}/agentThreads/${memberThreadDocumentId(
    actorUid,
    legacyThreadId,
  )}`;
  memory.seed(legacyThreadPath, {
    ownerUid: actorUid, clientThreadId: legacyThreadId, memoryGeneration: 2,
  });
  memory.seed("slackConversations/legacy-bound", {
    conversationId: "legacy-bound", teamId: "T1", slackUserId: "U1", channelId: "D1",
  });
  memory.seed("slackConversations/legacy-bound/events/event-1", {
    eventId: "Ev-legacy", text: "Legacy content without threadId", status: "processed",
  });

  const result = await redactMemberConversationData({
    companyId, actorUid, threadId: legacyThreadId,
    reason: "member_forget", beforeMemoryGeneration: 2, database,
  });
  assert.equal(result.events, 1);
  assert.equal(memory.read("slackConversations/legacy-bound/events/event-1")?.text, undefined);
  assert.equal(memory.read("slackConversations/legacy-bound")?.teamId, "T1",
    "forget redacts content without revoking the still-active binding");
});

test("connector deletion revokes bindings and redacts provider copies without deleting dedupe records", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  memory.seed("companies/acme/connections/slack-1", {
    connectorId: "slack", providerAccountId: "T1",
  });
  memory.seed("slackConversations/conversation-1", {
    conversationId: "conversation-1", companyId, connectionId: "slack-1",
    teamId: "T1", slackUserId: "U1", channelId: "D1", bindingStatus: "active",
  });
  memory.seed("slackConversations/conversation-1/events/event-1", {
    eventId: "Ev-1", text: "Sensitive", replyText: "Sensitive reply", status: "processed",
  });
  memory.seed("slackConversations/legacy-conversation", {
    conversationId: "legacy-conversation", teamId: "T1", slackUserId: "U1", channelId: "D2",
  });
  memory.seed("slackConversations/legacy-conversation/events/legacy-event", {
    eventId: "Ev-legacy", text: "Legacy sensitive content", status: "processed",
  });
  memory.seed("slackConversations/other", {
    conversationId: "other", companyId: "other-company", connectionId: "slack-1",
    teamId: "T2",
  });

  const result = await redactExternalConversationsForConnection({
    companyId, connectionId: "slack-1", reason: "connector_deleted", database,
  });
  assert.deepEqual(result, { conversations: 2, events: 2 });
  const conversation = memory.read("slackConversations/conversation-1");
  assert.equal(conversation?.conversationId, "conversation-1");
  assert.equal(conversation?.teamId, undefined);
  assert.equal(conversation?.bindingStatus, "revoked");
  const event = memory.read("slackConversations/conversation-1/events/event-1");
  assert.equal(event?.eventId, undefined);
  assert.equal(event?.text, undefined);
  assert.equal(memory.read("slackConversations/legacy-conversation")?.teamId, undefined);
  assert.equal(memory.read("slackConversations/legacy-conversation/events/legacy-event")?.text,
    undefined);
  assert.equal(memory.read("slackConversations/other")?.teamId, "T2");
});

test("the resumable adoption pass stamps fresh legacy content and immediately redacts expired legacy content", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const nowMs = conversationContentRetentionMs + 10_000;
  memory.seed(`${threadPath}/messages/old-legacy`, {
    role: "user", text: "Already beyond retention", createdAt: Timestamp.fromMillis(1_000),
  });
  memory.seed(`${threadPath}/messages/fresh-legacy`, {
    role: "user", text: "Still inside retention", createdAt: Timestamp.fromMillis(nowMs - 1_000),
  });
  memory.seed("slackWorkspaces/T1", {
    status: "active", companyId, connectionId: "slack-1",
  });
  memory.seed("companies/acme/connections/slack-1/slackUsers/U1", {
    status: "active", uid: actorUid,
  });
  memory.seed("slackConversations/legacy-root", {
    conversationId: "legacy-root", teamId: "T1", slackUserId: "U1", channelId: "D1",
    updatedAt: Timestamp.fromMillis(nowMs - 1_000),
  });

  const result = await backfillLegacyConversationRetentionMetadata({ nowMs, database });
  assert.equal(result.complete, true);
  assert.equal(result.redacted, 1);
  assert.equal(result.stamped, 2);
  assert.equal(memory.read(`${threadPath}/messages/old-legacy`)?.text, undefined);
  assert.equal(memory.read(`${threadPath}/messages/old-legacy`)?.contentRedactionReason,
    "retention_expired");
  assert.equal(memory.read(`${threadPath}/messages/fresh-legacy`)?.text, "Still inside retention");
  assert.ok(memory.read(`${threadPath}/messages/fresh-legacy`)?.contentExpiresAt);
  assert.equal(memory.read("slackConversations/legacy-root")?.threadId,
    `slack_${sha256Hex(`T1:D1:${actorUid}`).slice(0, 40)}`);
  assert.equal(memory.read("maintenance/conversation-retention-v1")?.complete, true);
});
