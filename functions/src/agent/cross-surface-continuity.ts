import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import {
  beginConversationSession,
  completeConversationSessionTurn,
  loadAuthorizedConversationContext,
} from "./conversation-memory.js";
import {
  askCompanyFactAgent,
  persistCompanyAgentInbound,
} from "./service.js";
import { memberThreadDocumentId } from "./threads.js";

export const crossSurfaceWebContextVersion = "cross-surface-web-v1";
export type ExternalConversationSurface = "slack_dm" | "teams_personal";

export function conversationThreadUrl(appOrigin: string, threadId: string): string {
  const url = new URL("/ask", appOrigin.replace(/\/+$/, "") || appOrigin);
  url.searchParams.set("thread", threadId);
  return url.toString();
}
export function slackConversationHandoff(
  text: string,
  appOrigin: string,
  threadId: string,
): string {
  const footer = `<${conversationThreadUrl(appOrigin, threadId)}|Continue this conversation in Agent Erik> · send \`new topic\` here to start fresh.`;
  return `${text.slice(0, Math.max(0, 39_000 - footer.length - 2))}\n\n${footer}`;
}

export function teamsConversationHandoff(
  text: string,
  appOrigin: string,
  threadId: string,
): string {
  const footer = `[Continue this conversation in Agent Erik](${conversationThreadUrl(appOrigin, threadId)}) · send \`new topic\` here to start fresh.`;
  return `${text.slice(0, Math.max(0, 25_000 - footer.length - 2))}\n\n${footer}`;
}

export async function askFromWebWithBoundSession(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  question: string;
  requestId: string;
  geminiApiKey: string;
  activityAtMs?: number;
  database?: FirebaseFirestore.Firestore;
  dependencies?: { ask?: typeof askCompanyFactAgent };
}) {
  const database = input.database || db;
  const ask = input.dependencies?.ask || askCompanyFactAgent;
  const threadRef = database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
  const thread = await threadRef.get();
  const threadData = thread.data() || {};
  const boundSurface = String(threadData.boundSurface || "");
  const hasBoundSession = thread.exists
    && threadData.ownerUid === input.actorUid
    && ["slack_dm", "teams_personal"].includes(boundSurface)
    && Boolean(threadData.activeSessionId);
  if (!hasBoundSession) {
    return ask({
      companyId: input.companyId,
      actorUid: input.actorUid,
      threadId: input.threadId,
      question: input.question,
      geminiApiKey: input.geminiApiKey,
      origin: "web",
      idempotencyKey: input.requestId,
      database,
    });
  }

  const activityAtMs = input.activityAtMs ?? Date.now();
  const inboundMessageId = `web_${sha256Hex(input.requestId).slice(0, 40)}`;
  const session = await beginConversationSession({
    companyId: input.companyId,
    actorUid: input.actorUid,
    threadId: input.threadId,
    activityAtMs,
    control: "continue",
    idempotencyKey: inboundMessageId,
    database,
  });
  const originMetadata = {
    continuedFromSurface: boundSurface,
    sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration,
  };
  await persistCompanyAgentInbound({
    companyId: input.companyId,
    actorUid: input.actorUid,
    threadId: input.threadId,
    question: input.question,
    messageId: inboundMessageId,
    createdAtMs: activityAtMs,
    origin: "web",
    originMetadata,
    sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration,
    database,
  });
  const context = await loadAuthorizedConversationContext({
    companyId: input.companyId,
    actorUid: input.actorUid,
    threadId: input.threadId,
    session,
    excludeMessageId: inboundMessageId,
    database,
  });
  const answer = await ask({
    companyId: input.companyId,
    actorUid: input.actorUid,
    threadId: input.threadId,
    question: input.question,
    geminiApiKey: input.geminiApiKey,
    origin: "web",
    originMetadata,
    inboundMessageId,
    idempotencyKey: input.requestId,
    turnMetadata: {
      route: "company_fact",
      contextVersion: crossSurfaceWebContextVersion,
      toolPolicy: "fresh_company_evidence_required",
    },
    conversationContext: context,
    database,
  });
  const completed = await completeConversationSessionTurn({
    companyId: input.companyId,
    actorUid: input.actorUid,
    threadId: input.threadId,
    session,
    userMessageId: inboundMessageId,
    assistantMessageId: answer.messageId,
    question: input.question,
    route: "company_fact",
    citations: answer.citations,
    confidence: answer.confidence,
    limitations: answer.limitations,
    activityAtMs,
    database,
  });
  await database.doc(companyDocumentPath(
    input.companyId,
    "agentRuns",
    answer.runId,
  )).set({
    contextUsed: { resultingStateVersion: completed.stateVersion },
    updatedAt: Timestamp.fromMillis(activityAtMs),
  }, { merge: true });
  return answer;
}
