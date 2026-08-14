import { Timestamp } from "firebase-admin/firestore";

import { companyDocumentPath } from "../tenancy.js";
import { FirestoreCompanyData, knowledgeKindForCollection } from "./knowledge.js";
import { memberThreadDocumentId } from "./threads.js";
import type { ToolCitation } from "./types.js";

export const conversationSessionVersion = "conversation-session-v1";
export const conversationSessionInactivityMs = 6 * 60 * 60 * 1000;
export const conversationRecentTokenBudget = 6_000;
const maximumRecentDocuments = 80;

export type ConversationSessionControl = "continue" | "start_fresh" | "forget";

export type ConversationEntityMemory = {
  kind: string;
  recordId: string;
  title: string;
  sourcePath: string;
};

export type ConversationSessionState = {
  subject: string | null;
  entities: ConversationEntityMemory[];
  unresolvedQuestions: string[];
  corrections: string[];
  decisions: string[];
  summary: string;
};

export type ConversationSessionHandle = {
  sessionId: string;
  memoryGeneration: number;
  stateVersion: number;
  state: ConversationSessionState;
  startedNew: boolean;
};

export type ConversationContextSnapshot = {
  sessionId: string;
  memoryGeneration: number;
  stateVersion: number;
  state: ConversationSessionState;
  priorMessages: Array<{
    id: string;
    role: "user" | "model";
    text: string;
  }>;
  estimatedTokens: number;
  selectedMemoryIds: string[];
};

function emptyState(): ConversationSessionState {
  return {
    subject: null,
    entities: [],
    unresolvedQuestions: [],
    corrections: [],
    decisions: [],
    summary: "Nothing has been retained for this session yet.",
  };
}

function timestampMillis(value: unknown): number {
  if (value && typeof value === "object"
    && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis(): number }).toMillis();
  }
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function threadRefFor(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  actorUid: string;
  threadId: string;
}) {
  return input.database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
}

function sessionState(value: unknown): ConversationSessionState {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const strings = (entry: unknown, maximum: number): string[] => Array.isArray(entry)
    ? entry.map(String).map((item) => item.trim()).filter(Boolean).slice(0, maximum)
    : [];
  const entities = Array.isArray(data.entities)
    ? data.entities.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const entity = entry as Record<string, unknown>;
      const sourcePath = String(entity.sourcePath || "");
      const recordId = String(entity.recordId || "");
      if (!sourcePath || !recordId) return [];
      return [{
        kind: String(entity.kind || "context_item"),
        recordId,
        title: String(entity.title || recordId).slice(0, 200),
        sourcePath,
      }];
    }).slice(0, 12)
    : [];
  return {
    subject: typeof data.subject === "string" && data.subject.trim()
      ? data.subject.trim().slice(0, 500)
      : null,
    entities,
    unresolvedQuestions: strings(data.unresolvedQuestions, 6),
    corrections: strings(data.corrections, 6),
    decisions: strings(data.decisions, 6),
    summary: typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim().slice(0, 2_000)
      : "Nothing has been retained for this session yet.",
  };
}

function sessionId(generation: number, sequence: number): string {
  return `session_${generation}_${String(sequence).padStart(6, "0")}`;
}

export async function beginConversationSession(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  activityAtMs: number;
  control?: ConversationSessionControl;
  idempotencyKey?: string;
  database: FirebaseFirestore.Firestore;
}): Promise<ConversationSessionHandle> {
  const threadRef = threadRefFor(input);
  return input.database.runTransaction(async (transaction) => {
    const operationRef = input.idempotencyKey
      ? threadRef.collection("sessionOperations").doc(input.idempotencyKey)
      : null;
    const [thread, operation] = await Promise.all([
      transaction.get(threadRef),
      operationRef ? transaction.get(operationRef) : Promise.resolve(null),
    ]);
    if (operation?.exists) {
      const operationData = operation.data() || {};
      const existingSessionId = String(operationData.sessionId || "");
      const existingSession = existingSessionId
        ? await transaction.get(threadRef.collection("sessions").doc(existingSessionId))
        : null;
      if (existingSession?.exists) {
        return {
          sessionId: existingSessionId,
          memoryGeneration: Number(operationData.memoryGeneration || 1),
          stateVersion: Number(existingSession.data()?.stateVersion || 0),
          state: sessionState(existingSession.data()?.state),
          startedNew: Boolean(operationData.startedNew),
        };
      }
    }
    const data = thread.data() || {};
    const control = input.control || "continue";
    const currentGeneration = Math.max(1, Number(data.memoryGeneration || 1));
    const memoryGeneration = control === "forget"
      ? currentGeneration + 1
      : currentGeneration;
    const lastActivityAtMs = timestampMillis(data.activeSessionLastActivityAt);
    const expired = Boolean(lastActivityAtMs
      && input.activityAtMs - lastActivityAtMs >= conversationSessionInactivityMs);
    const mustStart = control !== "continue"
      || expired
      || !String(data.activeSessionId || "");
    const previousSessionId = String(data.activeSessionId || "");
    const sequence = mustStart ? Number(data.sessionSequence || 0) + 1 : Number(data.sessionSequence || 0);
    const activeSessionId = mustStart
      ? sessionId(memoryGeneration, sequence)
      : previousSessionId;
    const activityAt = Timestamp.fromMillis(input.activityAtMs);
    if (mustStart && previousSessionId) {
      transaction.set(threadRef.collection("sessions").doc(previousSessionId), {
        status: control === "forget" ? "forgotten" : "closed",
        closedReason: control === "forget"
          ? "forget"
          : control === "start_fresh" ? "start_fresh" : "inactivity",
        closedAt: activityAt,
        updatedAt: activityAt,
      }, { merge: true });
    }
    const activeRef = threadRef.collection("sessions").doc(activeSessionId);
    let state = emptyState();
    let stateVersion = 0;
    if (!mustStart) {
      const active = await transaction.get(activeRef);
      state = sessionState(active.data()?.state);
      stateVersion = Number(active.data()?.stateVersion || 0);
    } else {
      transaction.set(activeRef, {
        sessionId: activeSessionId,
        threadId: input.threadId,
        ownerUid: input.actorUid,
        memoryGeneration,
        contractVersion: conversationSessionVersion,
        status: "active",
        stateVersion: 0,
        state,
        turnCount: 0,
        startedAt: activityAt,
        lastActivityAt: activityAt,
        createdAt: activityAt,
        updatedAt: activityAt,
      });
    }
    transaction.set(threadRef, {
      ownerUid: input.actorUid,
      clientThreadId: input.threadId,
      memoryGeneration,
      activeSessionId,
      activeSessionLastActivityAt: activityAt,
      sessionSequence: sequence,
      conversationSessionVersion,
      ...(control === "forget" ? { forgottenBefore: activityAt } : {}),
      updatedAt: activityAt,
    }, { merge: true });
    if (operationRef) {
      transaction.set(operationRef, {
        sessionId: activeSessionId,
        memoryGeneration,
        startedNew: mustStart,
        control,
        createdAt: activityAt,
      });
    }
    return {
      sessionId: activeSessionId,
      memoryGeneration,
      stateVersion,
      state,
      startedNew: mustStart,
    };
  });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function selectTokenBudgetedMessages<T extends { text: string }>(
  newestFirst: T[],
  budget = conversationRecentTokenBudget,
): { messages: T[]; estimatedTokens: number } {
  const selected: T[] = [];
  let estimatedTokens = 0;
  for (const message of newestFirst) {
    const tokens = estimateTokens(message.text);
    if (selected.length && estimatedTokens + tokens > budget) break;
    selected.push(message);
    estimatedTokens += Math.min(tokens, budget);
    if (estimatedTokens >= budget) break;
  }
  return { messages: selected.reverse(), estimatedTokens };
}

async function citationIsAuthorized(
  repository: FirestoreCompanyData,
  sourcePath: string,
): Promise<boolean> {
  const segments = sourcePath.split("/");
  if (segments.length !== 4 || segments[0] !== "companies") return false;
  const kind = knowledgeKindForCollection(segments[2] || "");
  const recordId = segments[3] || "";
  if (!kind || !recordId) return false;
  return Boolean(await repository.getRecord(kind, recordId));
}

export async function loadAuthorizedConversationContext(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  session: ConversationSessionHandle;
  excludeMessageId?: string;
  database: FirebaseFirestore.Firestore;
}): Promise<ConversationContextSnapshot> {
  const threadRef = threadRefFor(input);
  const messages = await threadRef.collection("messages")
    .orderBy("createdAt", "desc")
    .limit(maximumRecentDocuments)
    .get();
  const repository = new FirestoreCompanyData(input.database, input.companyId, input.actorUid);
  const candidates = await Promise.all(messages.docs.flatMap((document) => {
    if (document.id === input.excludeMessageId) return [];
    const data = document.data();
    if (String(data.sessionId || "") !== input.session.sessionId
      || Number(data.memoryGeneration || 0) !== input.session.memoryGeneration) return [];
    const role = data.role === "assistant" ? "model" as const
      : data.role === "user" ? "user" as const : null;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!role || !text) return [];
    return [(async () => {
      if (role === "model") {
        const citations = Array.isArray(data.citations) ? data.citations : [];
        const sourcePaths = citations.flatMap((citation) => citation
          && typeof citation === "object"
          && typeof (citation as Record<string, unknown>).sourcePath === "string"
          ? [String((citation as Record<string, unknown>).sourcePath)] : []);
        if (sourcePaths.length
          && !(await Promise.all(sourcePaths.map((path) => citationIsAuthorized(repository, path))))
            .every(Boolean)) return null;
      }
      return {
        id: document.id,
        role,
        text: text.replace(
          /\[C\d+(?:\s*,\s*C\d+)*\]/g,
          "[previous sources omitted; re-check with tools]",
        ).slice(0, 12_000),
      };
    })()];
  }));
  const authorized = candidates.filter((message): message is NonNullable<typeof message> => Boolean(message));
  const selected = selectTokenBudgetedMessages(authorized);
  const entities = (await Promise.all(input.session.state.entities.map(async (entity) => (
    await citationIsAuthorized(repository, entity.sourcePath) ? entity : null
  )))).filter((entity): entity is ConversationEntityMemory => Boolean(entity));
  const state = { ...input.session.state, entities };
  return {
    sessionId: input.session.sessionId,
    memoryGeneration: input.session.memoryGeneration,
    stateVersion: input.session.stateVersion,
    state,
    priorMessages: selected.messages,
    estimatedTokens: selected.estimatedTokens,
    selectedMemoryIds: input.session.stateVersion > 0
      ? [`${input.session.sessionId}:state:v${input.session.stateVersion}`]
      : [],
  };
}

export async function loadAuthorizedConversationContextForSession(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  sessionId: string;
  database: FirebaseFirestore.Firestore;
}): Promise<ConversationContextSnapshot> {
  const threadRef = threadRefFor(input);
  const session = await threadRef.collection("sessions").doc(input.sessionId).get();
  const data = session.data() || {};
  if (!session.exists
    || data.ownerUid !== input.actorUid
    || data.status === "forgotten") {
    throw new Error("The proposal's conversation session is no longer available.");
  }
  return loadAuthorizedConversationContext({
    ...input,
    session: {
      sessionId: input.sessionId,
      memoryGeneration: Number(data.memoryGeneration || 1),
      stateVersion: Number(data.stateVersion || 0),
      state: sessionState(data.state),
      startedNew: false,
    },
  });
}

function dedupe<T>(values: T[], key: (value: T) => string, maximum: number): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, maximum);
}

function compactSummary(state: Omit<ConversationSessionState, "summary">): string {
  const parts = [
    state.subject ? `Topic: ${state.subject}` : "",
    state.entities.length ? `Entities: ${state.entities.map((entity) => entity.title).join(", ")}` : "",
    state.corrections.length ? `Corrections: ${state.corrections.join(" | ")}` : "",
    state.decisions.length ? `Conversation decisions: ${state.decisions.join(" | ")}` : "",
    state.unresolvedQuestions.length ? `Unresolved: ${state.unresolvedQuestions.join(" | ")}` : "",
  ].filter(Boolean);
  return (parts.join("\n") || "Nothing has been retained for this session yet.").slice(0, 2_000);
}

export async function completeConversationSessionTurn(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  session: ConversationSessionHandle;
  userMessageId: string;
  assistantMessageId: string;
  question: string;
  route: string;
  citations?: ToolCitation[];
  confidence?: "high" | "medium" | "low";
  limitations?: string[];
  activityAtMs: number;
  database: FirebaseFirestore.Firestore;
}): Promise<{ stateVersion: number; state: ConversationSessionState }> {
  const threadRef = threadRefFor(input);
  const sessionRef = threadRef.collection("sessions").doc(input.session.sessionId);
  const turnRef = sessionRef.collection("turns").doc(input.userMessageId);
  const substantive = ["company_fact", "contextual_followup", "action_request"].includes(input.route);
  const correction = /^(?:correction\s*:|actually\b|to clarify\b|oprava\s*:|vlastně\b)/iu
    .test(input.question.trim());
  const decision = /^(?:decision\s*:|we decided\b|rozhodli jsme(?: se)?\b)/iu
    .test(input.question.trim());
  const newEntities = (input.citations || []).map((citation) => ({
    kind: citation.kind,
    recordId: citation.recordId,
    title: citation.title,
    sourcePath: citation.sourcePath,
  }));
  return input.database.runTransaction(async (transaction) => {
    const [current, completedTurn] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(turnRef),
    ]);
    if (completedTurn.exists) {
      return {
        stateVersion: Number(current.data()?.stateVersion || input.session.stateVersion),
        state: sessionState(current.data()?.state || input.session.state),
      };
    }
    const currentState = sessionState(current.data()?.state || input.session.state);
    const nextWithoutSummary = {
      subject: substantive ? input.question.slice(0, 500) : currentState.subject,
      entities: dedupe([...newEntities, ...currentState.entities], (entity) => entity.sourcePath, 12),
      unresolvedQuestions: input.confidence === "low" || (input.limitations || []).length
        ? dedupe([input.question, ...currentState.unresolvedQuestions], (value) => value, 6)
        : currentState.unresolvedQuestions,
      corrections: correction
        ? dedupe([input.question, ...currentState.corrections], (value) => value, 6)
        : currentState.corrections,
      decisions: decision
        ? dedupe([input.question, ...currentState.decisions], (value) => value, 6)
        : currentState.decisions,
    };
    const state = { ...nextWithoutSummary, summary: compactSummary(nextWithoutSummary) };
    const stateVersion = Number(current.data()?.stateVersion || 0) + 1;
    const activityAt = Timestamp.fromMillis(input.activityAtMs);
    transaction.set(sessionRef, {
      state,
      stateVersion,
      firstMessageId: current.data()?.firstMessageId || input.userMessageId,
      lastMessageId: input.assistantMessageId,
      turnCount: Number(current.data()?.turnCount || 0) + 1,
      lastActivityAt: activityAt,
      updatedAt: activityAt,
    }, { merge: true });
    transaction.set(threadRef, {
      activeSessionLastActivityAt: activityAt,
      updatedAt: activityAt,
    }, { merge: true });
    transaction.set(turnRef, {
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      stateVersion,
      completedAt: activityAt,
    });
    return { stateVersion, state };
  });
}

export function conversationStatePrompt(context: ConversationContextSnapshot): string {
  if (context.stateVersion === 0) return "";
  return [
    "Derived conversational state (for reference resolution only; never factual evidence):",
    context.state.summary,
    "Re-check every company fact with authorized tools, even when it appears above.",
  ].join("\n");
}

export function describeConversationMemory(context: ConversationContextSnapshot): string {
  const state = context.state;
  if (context.stateVersion === 0 || (!state.subject && !state.entities.length
    && !state.corrections.length && !state.decisions.length && !state.unresolvedQuestions.length)) {
    return "I’m not carrying any useful discussion state in this session yet.";
  }
  const lines = [
    state.subject ? `Current topic: ${state.subject}` : "",
    state.entities.length ? `Referenced records: ${state.entities.map((entity) => entity.title).join(", ")}` : "",
    state.corrections.length ? `Corrections: ${state.corrections.join(" | ")}` : "",
    state.decisions.length ? `Conversation decisions: ${state.decisions.join(" | ")}` : "",
    state.unresolvedQuestions.length ? `Still unresolved: ${state.unresolvedQuestions.join(" | ")}` : "",
    "I use this only for conversational continuity. I re-check current company facts and access before relying on them.",
  ].filter(Boolean);
  return lines.join("\n");
}
