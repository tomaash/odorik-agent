import { Timestamp } from "firebase-admin/firestore";

import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { GeminiRestAgentModel } from "./gemini.js";
import { FirestoreCompanyData } from "./knowledge.js";
import { runFactAgent, factAgentPromptVersion } from "./loop.js";
import { qdrantFromEnvironment } from "./search.js";
import { CompanyFactTools } from "./tools.js";
import { memberThreadDocumentId } from "./threads.js";
import { sha256Hex } from "../hash.js";
import {
  conversationStatePrompt,
  selectTokenBudgetedMessages,
  type ConversationContextSnapshot,
} from "./conversation-memory.js";

export type AgentMessageOrigin = "web" | "slack_dm";

export type ConversationTurnMetadata = {
  route?: string;
  contextVersion?: string;
  toolPolicy?: string;
  replyIdentity?: Record<string, unknown>;
  contextUsed?: Record<string, unknown>;
  proposal?: Record<string, unknown>;
  toolTrace?: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
};

function conversationRefs(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  actorUid: string;
  threadId: string;
}) {
  const threadRef = input.database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
  return { threadRef, messagesRef: threadRef.collection("messages") };
}

/** Persist a connector turn before any model or retrieval work starts. */
export async function persistCompanyAgentInbound(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  messageId: string;
  question: string;
  createdAtMs: number;
  origin: AgentMessageOrigin;
  originMetadata?: Record<string, unknown>;
  sessionId?: string;
  memoryGeneration?: number;
  database?: FirebaseFirestore.Firestore;
}): Promise<void> {
  const database = input.database || db;
  const { threadRef, messagesRef } = conversationRefs({ ...input, database });
  const threadSnapshot = await threadRef.get();
  const createdAt = Timestamp.fromMillis(input.createdAtMs);
  const batch = database.batch();
  batch.set(threadRef, {
    ownerUid: input.actorUid,
    clientThreadId: input.threadId,
    ...(!threadSnapshot.exists || !threadSnapshot.data()?.lastMessageAt ? {
      title: input.question.slice(0, 80),
    } : {}),
    ...(threadSnapshot.exists ? {} : { createdAt }),
    updatedAt: createdAt,
    lastMessageAt: createdAt,
    lastOrigin: input.origin,
  }, { merge: true });
  batch.set(messagesRef.doc(input.messageId), {
    role: "user",
    text: input.question,
    actorUid: input.actorUid,
    origin: input.origin,
    originMetadata: jsonSafe(input.originMetadata || {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.memoryGeneration ? { memoryGeneration: input.memoryGeneration } : {}),
    createdAt,
  }, { merge: true });
  await batch.commit();
}

export async function persistCompanyConversationReply(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  inboundMessageId: string;
  idempotencyKey: string;
  question: string;
  answer: string;
  origin: AgentMessageOrigin;
  originMetadata?: Record<string, unknown>;
  turnMetadata?: ConversationTurnMetadata;
  sessionId?: string;
  memoryGeneration?: number;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const { threadRef, messagesRef } = conversationRefs({ ...input, database });
  const suffix = sha256Hex(input.idempotencyKey).slice(0, 40);
  const answerRef = messagesRef.doc(`assistant_${suffix}`);
  const runRef = database.collection(companyCollectionPath(input.companyId, "agentRuns"))
    .doc(`conversation_${suffix}`);
  const existing = await answerRef.get();
  if (existing.exists) {
    return { runId: runRef.id, messageId: answerRef.id };
  }
  const answerAt = Timestamp.now();
  const originMetadata = jsonSafe(input.originMetadata || {});
  const turnMetadata = jsonSafe(input.turnMetadata || {});
  const batch = database.batch();
  batch.set(threadRef, {
    updatedAt: answerAt,
    lastMessageAt: answerAt,
    lastOrigin: input.origin,
  }, { merge: true });
  batch.set(answerRef, {
    role: "assistant",
    text: input.answer,
    citations: [],
    confidence: "high",
    limitations: [],
    runId: runRef.id,
    actorUid: input.actorUid,
    origin: input.origin,
    originMetadata,
    replyToMessageId: input.inboundMessageId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.memoryGeneration ? { memoryGeneration: input.memoryGeneration } : {}),
    createdAt: answerAt,
  });
  batch.set(runRef, {
    kind: "conversation_turn",
    companyId: input.companyId,
    threadId: input.threadId,
    question: input.question,
    answer: input.answer,
    citations: [],
    confidence: "high",
    limitations: [],
    toolTrace: [],
    usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 },
    actorUid: input.actorUid,
    origin: input.origin,
    originMetadata,
    ...(turnMetadata as Record<string, unknown>),
    createdAt: answerAt,
  });
  await batch.commit();
  return { runId: runRef.id, messageId: answerRef.id };
}

/**
 * Run one read-only company assistant turn and persist the same thread/run audit
 * envelope regardless of which trusted interface submitted the question.
 */
export async function askCompanyFactAgent(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  question: string;
  geminiApiKey: string;
  origin?: AgentMessageOrigin;
  originMetadata?: Record<string, unknown>;
  inboundMessageId?: string;
  idempotencyKey?: string;
  turnMetadata?: ConversationTurnMetadata;
  conversationContext?: ConversationContextSnapshot;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const { threadRef, messagesRef } = conversationRefs({ ...input, database });
  const stableSuffix = input.idempotencyKey
    ? sha256Hex(input.idempotencyKey).slice(0, 40)
    : "";
  const stableAnswerRef = stableSuffix
    ? messagesRef.doc(`assistant_${stableSuffix}`)
    : null;
  const stableRunRef = stableSuffix
    ? database.collection(companyCollectionPath(input.companyId, "agentRuns"))
      .doc(`fact_${stableSuffix}`)
    : null;
  if (stableAnswerRef && stableRunRef) {
    const [message, run] = await Promise.all([stableAnswerRef.get(), stableRunRef.get()]);
    if (message.exists && run.exists) {
      const messageData = message.data() || {};
      const runData = run.data() || {};
      return {
        answer: String(messageData.text || ""),
        citations: (messageData.citations || []) as never[],
        confidence: messageData.confidence as "high" | "medium" | "low",
        limitations: (messageData.limitations || []) as string[],
        toolTrace: (runData.toolTrace || []) as never[],
        usage: (runData.usage || {
          promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0,
        }) as never,
        runId: stableRunRef.id,
        messageId: stableAnswerRef.id,
      };
    }
  }
  const [threadSnapshot, historySnapshot] = await Promise.all([
    threadRef.get(),
    input.conversationContext
      ? Promise.resolve(null)
      : messagesRef.orderBy("createdAt", "desc").limit(80).get(),
  ]);
  const fallbackNewest = historySnapshot?.docs.flatMap((document) => {
    if (document.id === input.inboundMessageId) return [];
    const data = document.data();
    const role = data.role === "assistant"
      ? "model" as const
      : data.role === "user" ? "user" as const : null;
    const text = typeof data.text === "string"
      ? data.text.replace(
        /\[C\d+(?:\s*,\s*C\d+)*\]/g,
        "[previous sources omitted; re-check with tools]",
      )
      : "";
    return role && text ? [{ role, text }] : [];
  }) || [];
  const fallback = selectTokenBudgetedMessages(fallbackNewest);
  const priorMessages = input.conversationContext?.priorMessages || fallback.messages;
  const repository = new FirestoreCompanyData(database, input.companyId, input.actorUid);
  const { search } = qdrantFromEnvironment({
    geminiApiKey: input.geminiApiKey,
    companyId: input.companyId,
    memberId: input.actorUid,
  });
  const tools = new CompanyFactTools(repository, search);
  const startedAt = Date.now();
  const answer = await runFactAgent({
    question: input.question,
    model: new GeminiRestAgentModel(input.geminiApiKey),
    tools,
    priorMessages,
    conversationStateInstruction: input.conversationContext
      ? conversationStatePrompt(input.conversationContext)
      : "",
  });
  const userAt = Timestamp.now();
  const answerAt = Timestamp.fromMillis(userAt.toMillis() + 1);
  const userMessageRef = input.inboundMessageId
    ? messagesRef.doc(input.inboundMessageId)
    : messagesRef.doc();
  const answerMessageRef = stableAnswerRef || messagesRef.doc();
  const runRef = stableRunRef || database.collection(
    companyCollectionPath(input.companyId, "agentRuns"),
  ).doc();
  const origin = input.origin || "web";
  const originMetadata = jsonSafe(input.originMetadata || {});
  const batch = database.batch();
  batch.set(threadRef, {
    ownerUid: input.actorUid,
    clientThreadId: input.threadId,
    ...(!threadSnapshot.exists || !threadSnapshot.data()?.lastMessageAt ? {
      title: input.question.slice(0, 80),
    } : {}),
    ...(threadSnapshot.exists ? {} : { createdAt: userAt }),
    updatedAt: answerAt,
    lastMessageAt: answerAt,
    lastOrigin: origin,
  }, { merge: true });
  if (!input.inboundMessageId) {
    batch.set(userMessageRef, {
      role: "user",
      text: input.question,
      actorUid: input.actorUid,
      origin,
      originMetadata,
      createdAt: userAt,
    });
  }
  const safeCitations = jsonSafe(answer.citations);
  batch.set(answerMessageRef, {
    role: "assistant",
    text: answer.answer,
    citations: safeCitations,
    confidence: answer.confidence,
    limitations: answer.limitations,
    runId: runRef.id,
    actorUid: input.actorUid,
    origin,
    originMetadata,
    replyToMessageId: input.inboundMessageId || userMessageRef.id,
    ...(input.conversationContext ? {
      sessionId: input.conversationContext.sessionId,
      memoryGeneration: input.conversationContext.memoryGeneration,
    } : {}),
    createdAt: answerAt,
  });
  batch.set(runRef, {
    kind: "fact_agent",
    companyId: input.companyId,
    threadId: input.threadId,
    question: input.question,
    answer: answer.answer,
    citations: safeCitations,
    confidence: answer.confidence,
    limitations: answer.limitations,
    toolTrace: jsonSafe(answer.toolTrace),
    usage: answer.usage,
    model: "gemini-3.5-flash-lite",
    promptVersion: factAgentPromptVersion,
    actorUid: input.actorUid,
    origin,
    originMetadata,
    ...(jsonSafe(input.turnMetadata || {}) as Record<string, unknown>),
    contextUsed: jsonSafe(input.conversationContext ? {
      sessionId: input.conversationContext.sessionId,
      memoryGeneration: input.conversationContext.memoryGeneration,
      stateVersion: input.conversationContext.stateVersion,
      recentMessageIds: input.conversationContext.priorMessages.map((message) => message.id),
      estimatedRecentTokens: input.conversationContext.estimatedTokens,
      selectedMemoryIds: input.conversationContext.selectedMemoryIds,
      companyEvidencePolicy: "fresh_authorized_tools_required",
    } : {
      recentMessageCount: priorMessages.length,
      estimatedRecentTokens: fallback.estimatedTokens,
    }),
    latencyMs: Date.now() - startedAt,
    createdAt: answerAt,
  });
  await batch.commit();
  return { ...answer, runId: runRef.id, messageId: answerMessageRef.id };
}
