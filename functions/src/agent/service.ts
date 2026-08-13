import { Timestamp } from "firebase-admin/firestore";

import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { GeminiRestAgentModel } from "./gemini.js";
import { FirestoreCompanyData } from "./knowledge.js";
import { runFactAgent, factAgentPromptVersion } from "./loop.js";
import { qdrantFromEnvironment } from "./search.js";
import { CompanyFactTools } from "./tools.js";
import { memberThreadDocumentId } from "./threads.js";

export type AgentMessageOrigin = "web" | "slack_dm";

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
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const threadRef = database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
  const messagesRef = threadRef.collection("messages");
  const [threadSnapshot, historySnapshot] = await Promise.all([
    threadRef.get(),
    messagesRef.orderBy("createdAt", "desc").limit(8).get(),
  ]);
  const priorMessages = historySnapshot.docs.reverse().flatMap((document) => {
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
  });
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
  });
  const userAt = Timestamp.now();
  const answerAt = Timestamp.fromMillis(userAt.toMillis() + 1);
  const userMessageRef = messagesRef.doc();
  const answerMessageRef = messagesRef.doc();
  const runRef = database.collection(
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
  batch.set(userMessageRef, {
    role: "user",
    text: input.question,
    actorUid: input.actorUid,
    origin,
    originMetadata,
    createdAt: userAt,
  });
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
    latencyMs: Date.now() - startedAt,
    createdAt: answerAt,
  });
  await batch.commit();
  return { ...answer, runId: runRef.id, messageId: answerMessageRef.id };
}
