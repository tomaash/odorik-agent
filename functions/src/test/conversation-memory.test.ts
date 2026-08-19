import assert from "node:assert/strict";
import test from "node:test";

import {
  beginConversationSession,
  completeConversationSessionTurn,
  conversationRecentTokenBudget,
  conversationSessionInactivityMs,
  loadAuthorizedConversationContext,
  loadAuthorizedConversationContextForSession,
  selectTokenBudgetedMessages,
} from "../agent/conversation-memory.js";
import { memberThreadDocumentId } from "../agent/threads.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "acme";
const actorUid = "member-1";
const threadId = "slack-thread";

function threadPath(): string {
  return `companies/${companyId}/agentThreads/${memberThreadDocumentId(actorUid, threadId)}`;
}

test("recent conversation turns are selected newest-first under a token budget", () => {
  const newestFirst = [
    { id: "new", text: "n".repeat(40) },
    { id: "middle", text: "m".repeat(40) },
    { id: "old", text: "o".repeat(40) },
  ];
  const selected = selectTokenBudgetedMessages(newestFirst, 20);
  assert.deepEqual(selected.messages.map((message) => message.id), ["middle", "new"]);
  assert.equal(selected.estimatedTokens, 20);
  assert.equal(conversationRecentTokenBudget, 6_000);
});

test("sessions close after inactivity and explicit forget rotates the memory generation", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const first = await beginConversationSession({
    companyId, actorUid, threadId, activityAtMs: 1_000, database,
  });
  const continued = await beginConversationSession({
    companyId, actorUid, threadId,
    activityAtMs: 1_000 + conversationSessionInactivityMs - 1,
    database,
  });
  assert.equal(continued.sessionId, first.sessionId);
  const expired = await beginConversationSession({
    companyId, actorUid, threadId,
    activityAtMs: 1_000 + 2 * conversationSessionInactivityMs,
    database,
  });
  assert.notEqual(expired.sessionId, first.sessionId);
  assert.equal(memory.read(`${threadPath()}/sessions/${first.sessionId}`)?.closedReason, "inactivity");
  const forgotten = await beginConversationSession({
    companyId, actorUid, threadId,
    activityAtMs: 1_000 + 2 * conversationSessionInactivityMs + 1,
    control: "forget",
    database,
  });
  assert.equal(forgotten.memoryGeneration, first.memoryGeneration + 1);
  assert.notEqual(forgotten.sessionId, expired.sessionId);
  assert.equal(memory.read(threadPath())?.memoryGeneration, forgotten.memoryGeneration);
  assert.equal(memory.read(`${threadPath()}/sessions/${expired.sessionId}`)?.status, "forgotten");
  const forgottenRetry = await beginConversationSession({
    companyId, actorUid, threadId,
    activityAtMs: 1_000 + 2 * conversationSessionInactivityMs + 2,
    control: "forget", idempotencyKey: "forget-turn",
    database,
  });
  const sameForgottenRetry = await beginConversationSession({
    companyId, actorUid, threadId,
    activityAtMs: 1_000 + 2 * conversationSessionInactivityMs + 3,
    control: "forget", idempotencyKey: "forget-turn",
    database,
  });
  assert.equal(sameForgottenRetry.sessionId, forgottenRetry.sessionId);
  assert.equal(sameForgottenRetry.memoryGeneration, forgottenRetry.memoryGeneration);
});

test("conversation state has exact message bounds and revoked evidence leaves new context", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  memory.seed("companies/acme/workItems/task-1", {
    title: "Call Acme",
    status: "open",
    access: { visibility: "company" },
  });
  const session = await beginConversationSession({
    companyId, actorUid, threadId, activityAtMs: 10_000, database,
  });
  memory.seed(`${threadPath()}/messages/user-1`, {
    role: "user", text: "Tell me about the Acme task",
    sessionId: session.sessionId, memoryGeneration: session.memoryGeneration,
    createdAt: 10_000,
  });
  memory.seed(`${threadPath()}/messages/assistant-1`, {
    role: "assistant", text: "Call Acme is open [C1]",
    citations: [{ sourcePath: "companies/acme/workItems/task-1" }],
    sessionId: session.sessionId, memoryGeneration: session.memoryGeneration,
    createdAt: 10_001,
  });
  const completed = await completeConversationSessionTurn({
    companyId, actorUid, threadId, session,
    userMessageId: "user-1", assistantMessageId: "assistant-1",
    question: "Tell me about the Acme task", route: "company_fact",
    citations: [{
      citationId: "C1", kind: "task", recordId: "task-1",
      sourcePath: "companies/acme/workItems/task-1", title: "Call Acme",
      excerpt: "open", occurredAt: null,
    }],
    confidence: "high", activityAtMs: 10_001, database,
  });
  const stored = memory.read(`${threadPath()}/sessions/${session.sessionId}`);
  assert.equal(stored?.firstMessageId, "user-1");
  assert.equal(stored?.lastMessageId, "assistant-1");
  assert.equal(completed.state.entities[0]?.recordId, "task-1");
  const completedRetry = await completeConversationSessionTurn({
    companyId, actorUid, threadId, session,
    userMessageId: "user-1", assistantMessageId: "assistant-1",
    question: "Tell me about the Acme task", route: "company_fact",
    confidence: "high", activityAtMs: 10_002, database,
  });
  assert.equal(completedRetry.stateVersion, completed.stateVersion);
  assert.equal(memory.read(`${threadPath()}/sessions/${session.sessionId}`)?.turnCount, 1);

  const authorized = await loadAuthorizedConversationContext({
    companyId, actorUid, threadId,
    session: { ...session, stateVersion: completed.stateVersion, state: completed.state },
    database,
  });
  assert.equal(authorized.state.entities.length, 1);
  assert.deepEqual(authorized.priorMessages.map((message) => message.id), ["user-1", "assistant-1"]);

  memory.seed("companies/acme/workItems/task-1", {
    title: "Call Acme", status: "open",
    access: { visibility: "restricted", memberIds: ["someone-else"] },
  });
  const revoked = await loadAuthorizedConversationContext({
    companyId, actorUid, threadId,
    session: { ...session, stateVersion: completed.stateVersion, state: completed.state },
    database,
  });
  assert.equal(revoked.state.entities.length, 0);
  assert.deepEqual(revoked.priorMessages.map((message) => message.id), ["user-1"]);

  memory.seed(`${threadPath()}/sessions/${session.sessionId}`, {
    ...memory.read(`${threadPath()}/sessions/${session.sessionId}`),
    contentRedacted: true,
  });
  await assert.rejects(() => loadAuthorizedConversationContextForSession({
    companyId, actorUid, threadId, sessionId: session.sessionId, database,
  }), /no longer available/);
});
