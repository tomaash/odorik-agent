import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import {
  askFromWebWithBoundSession,
  conversationThreadUrl,
  slackConversationHandoff,
  teamsConversationHandoff,
} from "../agent/cross-surface-continuity.js";
import { askCompanyFactAgent } from "../agent/service.js";
import { memberThreadDocumentId } from "../agent/threads.js";
import { MemoryFirestore } from "./firestore-harness.js";

test("cross-surface handoffs target one exact encoded Agent Erik thread", () => {
  const threadId = "slack_abc-123";
  const url = conversationThreadUrl("https://app.agenterik.cz/", threadId);
  assert.equal(url, "https://app.agenterik.cz/ask?thread=slack_abc-123");
  assert.match(slackConversationHandoff("Answer", "https://app.agenterik.cz", threadId),
    /<https:\/\/app\.agenterik\.cz\/ask\?thread=slack_abc-123\|Continue this conversation/);
  assert.match(teamsConversationHandoff("Answer", "https://app.agenterik.cz", threadId),
    /\[Continue this conversation in Agent Erik\]\(https:\/\/app\.agenterik\.cz\/ask\?thread=slack_abc-123\)/);
});

test("web continuation reuses the active bound session and is idempotent", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const companyId = "acme";
  const actorUid = "member-1";
  const threadId = "slack_bound";
  const documentId = memberThreadDocumentId(actorUid, threadId);
  const threadPath = `companies/${companyId}/agentThreads/${documentId}`;
  memory.seed(threadPath, {
    ownerUid: actorUid,
    clientThreadId: threadId,
    boundSurface: "slack_dm",
    activeSessionId: "session_1_000001",
    activeSessionLastActivityAt: Timestamp.fromMillis(1_000),
    sessionSequence: 1,
    memoryGeneration: 1,
  });
  memory.seed(`${threadPath}/sessions/session_1_000001`, {
    sessionId: "session_1_000001",
    threadId,
    ownerUid: actorUid,
    memoryGeneration: 1,
    status: "active",
    stateVersion: 0,
    state: {
      subject: null,
      entities: [],
      unresolvedQuestions: [],
      corrections: [],
      decisions: [],
      summary: "Nothing retained yet.",
    },
    turnCount: 0,
    startedAt: Timestamp.fromMillis(1_000),
    lastActivityAt: Timestamp.fromMillis(1_000),
  });

  let calls = 0;
  const ask = async (input: Parameters<typeof askCompanyFactAgent>[0]) => {
    calls += 1;
    assert.equal(input.conversationContext?.sessionId, "session_1_000001");
    assert.equal(input.originMetadata?.continuedFromSurface, "slack_dm");
    const answer = {
      answer: "Grounded answer",
      citations: [],
      confidence: "high" as const,
      limitations: [],
      toolTrace: [],
      usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0, totalTokens: 2 },
      runId: "run-web-1",
      messageId: "assistant-web-1",
    };
    await database.doc(`${threadPath}/messages/${answer.messageId}`).set({
      role: "assistant",
      text: answer.answer,
      sessionId: input.conversationContext?.sessionId,
      memoryGeneration: input.conversationContext?.memoryGeneration,
      createdAt: Timestamp.fromMillis(2_001),
    });
    await database.doc(`companies/${companyId}/agentRuns/${answer.runId}`).set({
      kind: "fact_agent",
      createdAt: Timestamp.fromMillis(2_001),
    });
    return answer;
  };

  const request = {
    companyId,
    actorUid,
    threadId,
    question: "Continue this discussion",
    requestId: "request_same_123",
    geminiApiKey: "unused",
    activityAtMs: 2_000,
    database,
    dependencies: { ask },
  };
  const first = await askFromWebWithBoundSession(request);
  const second = await askFromWebWithBoundSession(request);
  assert.equal(first.messageId, "assistant-web-1");
  assert.equal(second.messageId, "assistant-web-1");
  assert.equal(calls, 2, "the injected model stub runs twice, while session completion remains idempotent");
  assert.equal(memory.read(`${threadPath}/sessions/session_1_000001`)?.turnCount, 1);
  assert.equal(memory.read(threadPath)?.boundSurface, "slack_dm");
  assert.equal(memory.read(`companies/${companyId}/agentRuns/run-web-1`)?.contextUsed
    && (memory.read(`companies/${companyId}/agentRuns/run-web-1`)?.contextUsed as Record<string, unknown>).resultingStateVersion, 1);
});
