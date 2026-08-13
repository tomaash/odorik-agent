import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import {
  askCompanyFactAgent,
  persistCompanyAgentInbound,
  persistCompanyConversationReply,
} from "../agent/service.js";
import {
  beginConversationSession,
  completeConversationSessionTurn,
  describeConversationMemory,
  loadAuthorizedConversationContext,
  type ConversationSessionControl,
} from "../agent/conversation-memory.js";
import { authorizedSlackDirect } from "../connectors/slack-oauth.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { createSlackLink, slackIdentityPath } from "./slack-link.js";
import {
  classifySlackDeliveryFailure,
  postSlackText,
} from "./slack.js";

export class SlackEventRequestError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SlackEventRequestError";
  }
}

export function verifySlackRequestSignature(input: {
  rawBody: Buffer;
  timestamp?: string;
  signature?: string;
  signingSecret: string;
  nowMs?: number;
}): void {
  const timestamp = String(input.timestamp || "");
  const signature = String(input.signature || "");
  const seconds = Number(timestamp);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > 5 * 60 * 1000) {
    throw new SlackEventRequestError("Stale Slack request", 401);
  }
  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${timestamp}:${input.rawBody.toString("utf8")}`)
    .digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new SlackEventRequestError("Invalid Slack signature", 401);
  }
}

export type QueuedSlackDmEvent = {
  eventId: string;
  teamId: string;
  slackUserId: string;
  channelId: string;
  text: string;
  eventTs: string;
};

export type SlackTurnRoute =
  | "social"
  | "capability"
  | "company_fact"
  | "contextual_followup"
  | "action_request"
  | "memory_inspect"
  | "session_reset"
  | "memory_forget";

export const slackConversationContextVersion = "slack-conversation-v2";
// Longer than the five-minute function timeout: a live worker cannot be
// reclaimed merely because one grounded answer is slow.
export const slackConversationLeaseMs = 6 * 60 * 1000;
export const slackReorderWindowMs = 750;

export class SlackConversationBusyError extends Error {
  constructor() {
    super("Slack conversation is already being processed");
    this.name = "SlackConversationBusyError";
  }
}

export function routeSlackTurn(text: string, hasPriorTurn = false): SlackTurnRoute {
  const normalized = text.trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
  if (/^(?:what do you remember|what are we discussing|co si pamatuješ|o čem se bavíme)[?.!]*$/u.test(normalized)) {
    return "memory_inspect";
  }
  if (/^(?:new topic|start fresh|nové téma|začni znovu)[?.!]*$/u.test(normalized)) {
    return "session_reset";
  }
  if (/^(?:forget this conversation|forget our conversation|zapomeň (?:tento|náš) rozhovor)[?.!]*$/u.test(normalized)) {
    return "memory_forget";
  }
  if (/^(hi|hello|hey|ahoj|čau|dobrý den|good (morning|afternoon|evening))( erik)?[!.?]*$/u.test(normalized)
    || /^(thanks|thank you|díky|děkuji|bye|goodbye|nashledanou)[!.?]*$/u.test(normalized)) {
    return "social";
  }
  if (/\b(what can you do|how can you help|what are your capabilities|co umíš|s čím (mi )?můžeš pomoct)\b/u.test(normalized)) {
    return "capability";
  }
  const request = normalized.replace(
    /^(?:hi|hello|hey|ahoj|čau|dobrý den)[,! ]+/u,
    "",
  );
  if (
    /^(?:(?:can|could|would) you |please |prosím )?(?:approve|reject|delete|move|assign|schedule|schval|odmítni|smaž|přesuň|přiřaď|naplánuj)\b/u.test(request)
    || /^(?:(?:can|could|would) you |please |prosím )?(?:send|draft|pošli)\b.{0,80}\b(?:email|message|mail|e-mail|zpráv)/u.test(request)
    || /^(?:(?:can|could|would) you |please |prosím )?(?:(?:create|make|vytvoř)\b|(?:update|uprav)\b(?! me\b)).{0,80}\b(?:task|case|contact|record|draft|email|event|calendar|úkol|případ|kontakt|záznam|koncept|událost|kalendář)/u.test(request)
  ) {
    return "action_request";
  }
  if (hasPriorTurn && (
    /^(and |also |what about|how about|why |when |where |who |which |a co|a jak|proč|kdy|kde|kdo|kter)/u.test(normalized)
    || /\b(it|its|that|those|them|they|this|he|she|his|her|to|jeho|její|oni|ten|ta|ty)\b/u.test(normalized)
  )) return "contextual_followup";
  return "company_fact";
}

export function slackEventOrderKey(eventTs: string, eventId: string): string {
  const micros = Math.max(0, Math.round(Number(eventTs) * 1_000_000));
  return `${String(micros).padStart(20, "0")}:${eventId}`;
}

export function slackConversationId(event: Pick<QueuedSlackDmEvent,
  "teamId" | "channelId" | "slackUserId"
>): string {
  return sha256Hex(`${event.teamId}:${event.channelId}:${event.slackUserId}`).slice(0, 48);
}

export function slackConversationEventPath(event: QueuedSlackDmEvent): string {
  return `slackConversations/${slackConversationId(event)}/events/${sha256Hex(event.eventId)}`;
}

export function parseSlackDmEvent(body: unknown): QueuedSlackDmEvent | null {
  if (!body || typeof body !== "object") throw new SlackEventRequestError("Invalid Slack payload");
  const envelope = body as Record<string, unknown>;
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || typeof event !== "object") return null;
  const message = event as Record<string, unknown>;
  if (
    message.type !== "message"
    || message.channel_type !== "im"
    || message.subtype
    || message.bot_id
    || message.hidden
  ) return null;
  const eventId = String(envelope.event_id || "").trim();
  const teamId = String(envelope.team_id || "").trim();
  const slackUserId = String(message.user || "").trim();
  const channelId = String(message.channel || "").trim();
  const text = String(message.text || "").trim();
  const eventTs = String(message.event_ts || message.ts || "").trim();
  if (
    !eventId || !teamId || !slackUserId || !channelId || !text || !eventTs
    || !Number.isFinite(Number(eventTs))
  ) return null;
  return { eventId, teamId, slackUserId, channelId, text: text.slice(0, 3000), eventTs };
}

export async function queueSlackDmEvent(input: {
  event: QueuedSlackDmEvent;
  database?: FirebaseFirestore.Firestore;
}): Promise<"queued" | "duplicate"> {
  const database = input.database || db;
  const conversationId = slackConversationId(input.event);
  const conversationRef = database.doc(`slackConversations/${conversationId}`);
  const ref = database.doc(slackConversationEventPath(input.event));
  return database.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) return "duplicate";
    const conversation = await transaction.get(conversationRef);
    const generation = Number(conversation.data()?.enqueueGeneration || 0) + 1;
    transaction.set(conversationRef, {
      conversationId,
      teamId: input.event.teamId,
      slackUserId: input.event.slackUserId,
      channelId: input.event.channelId,
      enqueueGeneration: generation,
      ...(!conversation.exists ? { createdAt: Timestamp.now() } : {}),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    transaction.create(ref, {
      ...input.event,
      status: "queued",
      pending: true,
      orderKey: slackEventOrderKey(input.event.eventTs, input.event.eventId),
      attempts: 0,
      createdAt: Timestamp.now(),
    });
    return "queued";
  });
}

async function resolveSlackWorkspace(
  teamId: string,
  database: FirebaseFirestore.Firestore,
): Promise<{ companyId: string; connectionId: string } | null> {
  const mapping = await database.doc(`slackWorkspaces/${teamId}`).get();
  if (mapping.exists && mapping.data()?.status === "active") {
    return {
      companyId: String(mapping.data()?.companyId || ""),
      connectionId: String(mapping.data()?.connectionId || ""),
    };
  }
  const matches = await database.collectionGroup("connections")
    .where("providerAccountId", "==", teamId)
    .limit(2)
    .get();
  if (matches.size !== 1) return null;
  const connection = matches.docs[0]!;
  const segments = connection.ref.path.split("/");
  const companyId = segments[1] || "";
  const connectionId = connection.id;
  if (!companyId || !connectionId) return null;
  await database.doc(`slackWorkspaces/${teamId}`).set({
    teamId,
    companyId,
    connectionId,
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  }, { merge: true });
  return { companyId, connectionId };
}

function slackAnswerText(
  answer: Awaited<ReturnType<typeof askCompanyFactAgent>>,
  appOrigin: string,
): string {
  const citations = answer.citations
    .filter((citation) => citation.externalUrl || citation.internalRoute)
    .slice(0, 8)
    .map((citation) => {
      const internalRoute = citation.internalRoute || "";
      const url = citation.externalUrl || (internalRoute
        ? `${appOrigin.replace(/\/+$/, "")}/${internalRoute.replace(/^\/+/, "")}`
        : "");
      return `<${url}|${citation.citationId}: ${citation.title}>`;
    });
  return [answer.answer, citations.length ? `\nSources:\n${citations.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 39_000);
}

function socialReply(text: string): string {
  if (/thank|thanks|díky|děkuji/i.test(text)) return "You’re welcome.";
  if (/bye|goodbye|nashledanou/i.test(text)) return "Goodbye — message me whenever you need company context.";
  return "Hello! Ask me about your company’s calls, contacts, cases, tasks, documents, mail, or recent work.";
}

const capabilityReply = "I can answer read-only questions about the company data you’re allowed to access and show the supporting sources. I won’t approve or execute consequential actions from an ordinary Slack reply.";
const actionRequestReply = "I won’t execute or approve an action from an ordinary Slack message. I can help verify the relevant company context here; use Agent Erik’s authenticated approval surface for consequential actions.";
const sessionResetReply = "Started a fresh topic. I won’t automatically use the previous session’s discussion state.";
const memoryForgetReply = "Forgot the conversation context I was carrying. Retained transport and audit records will not be used as memory in future turns.";

type PreparedSlackReply = {
  outcome: "answered" | "link_requested" | "ignored";
  replyText: string | null;
  route: SlackTurnRoute | "identity_link" | "ignored";
  companyId?: string;
  connectionId?: string;
  botToken?: string;
  uid?: string;
  threadId?: string;
  runId?: string;
};

export type SlackConversationDependencies = {
  ask?: typeof askCompanyFactAgent;
  persistInbound?: typeof persistCompanyAgentInbound;
  persistReply?: typeof persistCompanyConversationReply;
  post?: typeof postSlackText;
  authorize?: typeof authorizedSlackDirect;
  createLink?: typeof createSlackLink;
  wait?: (milliseconds: number) => Promise<void>;
};

export async function processSlackDmEvent(input: {
  event: QueuedSlackDmEvent;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  hasPriorTurn?: boolean;
  lateArrival?: boolean;
  dependencies?: SlackConversationDependencies;
  database?: FirebaseFirestore.Firestore;
}): Promise<PreparedSlackReply> {
  const database = input.database || db;
  const ask = input.dependencies?.ask || askCompanyFactAgent;
  const persistInbound = input.dependencies?.persistInbound || persistCompanyAgentInbound;
  const persistReply = input.dependencies?.persistReply || persistCompanyConversationReply;
  const authorize = input.dependencies?.authorize || authorizedSlackDirect;
  const createLink = input.dependencies?.createLink || createSlackLink;
  const workspace = await resolveSlackWorkspace(input.event.teamId, database);
  if (!workspace) return { outcome: "ignored", replyText: null, route: "ignored" };
  const authorization = await authorize({
    ...workspace,
    credentialKey: input.credentialKey,
    database,
  });
  if (authorization.botUserId && authorization.botUserId === input.event.slackUserId) {
    return { outcome: "ignored", replyText: null, route: "ignored" };
  }
  const identity = await database.doc(slackIdentityPath({
    ...workspace,
    slackUserId: input.event.slackUserId,
  })).get();
  const uid = identity.data()?.status === "active" ? String(identity.data()?.uid || "") : "";
  const membership = uid
    ? await database.doc(`companies/${workspace.companyId}/memberships/${uid}`).get()
    : null;
  if (!uid || !membership?.exists || membership.data()?.status !== "active") {
    const link = await createLink({
      ...workspace,
      teamId: input.event.teamId,
      slackUserId: input.event.slackUserId,
      appOrigin: input.appOrigin,
      database,
    });
    return {
      outcome: "link_requested",
      replyText: `To protect company data, link this Slack account to your Agent Erik account first:\n${link.url}\n\nThe link expires in 15 minutes.`,
      route: "identity_link",
      ...workspace,
      botToken: authorization.botToken,
    };
  }
  const threadId = `slack_${sha256Hex(`${input.event.teamId}:${input.event.channelId}:${uid}`).slice(0, 40)}`;
  const inboundMessageId = `slack_${sha256Hex(input.event.eventId).slice(0, 40)}`;
  const route = routeSlackTurn(input.event.text, input.hasPriorTurn);
  const sessionControl: ConversationSessionControl = route === "memory_forget"
    ? "forget"
    : route === "session_reset" ? "start_fresh" : "continue";
  const activityAtMs = input.lateArrival
    ? Date.now()
    : Math.round(Number(input.event.eventTs) * 1000);
  const session = await beginConversationSession({
    companyId: workspace.companyId,
    actorUid: uid,
    threadId,
    activityAtMs,
    control: sessionControl,
    idempotencyKey: inboundMessageId,
    database,
  });
  const originMetadata = {
    teamId: input.event.teamId,
    slackUserId: input.event.slackUserId,
    channelId: input.event.channelId,
    eventId: input.event.eventId,
    eventTs: input.event.eventTs,
    sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration,
    ...(input.lateArrival ? { lateArrival: true } : {}),
  };
  await persistInbound({
    companyId: workspace.companyId,
    actorUid: uid,
    threadId,
    question: input.event.text,
    messageId: inboundMessageId,
    createdAtMs: activityAtMs,
    origin: "slack_dm",
    originMetadata,
    sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration,
    database,
  });
  const context = await loadAuthorizedConversationContext({
    companyId: workspace.companyId,
    actorUid: uid,
    threadId,
    session,
    excludeMessageId: inboundMessageId,
    database,
  });
  const turnMetadata = {
    route,
    contextVersion: slackConversationContextVersion,
    toolPolicy: ["company_fact", "contextual_followup"].includes(route)
      ? "fresh_company_evidence_required"
      : "no_company_tools",
    contextUsed: {
      sessionId: context.sessionId,
      memoryGeneration: context.memoryGeneration,
      stateVersion: context.stateVersion,
      recentMessageIds: context.priorMessages.map((message) => message.id),
      estimatedRecentTokens: context.estimatedTokens,
      selectedMemoryIds: context.selectedMemoryIds,
    },
    replyIdentity: { slackEventId: input.event.eventId, clientMessageId: input.event.eventId },
  };
  let replyText = "";
  let runId = "";
  let assistantMessageId = "";
  let citations: Awaited<ReturnType<typeof askCompanyFactAgent>>["citations"] = [];
  let confidence: "high" | "medium" | "low" = "high";
  let limitations: string[] = [];
  if (route === "company_fact" || route === "contextual_followup") {
    const answer = await ask({
      companyId: workspace.companyId,
      actorUid: uid,
      threadId,
      question: input.event.text,
      geminiApiKey: input.geminiApiKey,
      origin: "slack_dm",
      originMetadata,
      inboundMessageId,
      idempotencyKey: input.event.eventId,
      turnMetadata,
      conversationContext: context,
      database,
    });
    replyText = slackAnswerText(answer, input.appOrigin);
    runId = answer.runId;
    assistantMessageId = answer.messageId;
    citations = answer.citations;
    confidence = answer.confidence;
    limitations = answer.limitations;
  } else {
    replyText = route === "social"
      ? socialReply(input.event.text)
      : route === "capability" ? capabilityReply
        : route === "memory_inspect" ? describeConversationMemory(context)
          : route === "session_reset" ? sessionResetReply
            : route === "memory_forget" ? memoryForgetReply
              : actionRequestReply;
    const persisted = await persistReply({
      companyId: workspace.companyId,
      actorUid: uid,
      threadId,
      inboundMessageId,
      idempotencyKey: input.event.eventId,
      question: input.event.text,
      answer: replyText,
      origin: "slack_dm",
      originMetadata,
      turnMetadata,
      sessionId: session.sessionId,
      memoryGeneration: session.memoryGeneration,
      database,
    });
    runId = persisted.runId;
    assistantMessageId = persisted.messageId;
  }
  const completed = await completeConversationSessionTurn({
    companyId: workspace.companyId,
    actorUid: uid,
    threadId,
    session,
    userMessageId: inboundMessageId,
    assistantMessageId,
    question: input.event.text,
    route,
    citations,
    confidence,
    limitations,
    activityAtMs,
    database,
  });
  await database.doc(companyDocumentPath(workspace.companyId, "agentRuns", runId)).set({
    contextUsed: {
      ...turnMetadata.contextUsed,
      resultingStateVersion: completed.stateVersion,
    },
  }, { merge: true });
  return {
    outcome: "answered",
    replyText,
    route,
    ...workspace,
    botToken: authorization.botToken,
    uid,
    threadId,
    runId,
  };
}

async function claimSlackConversation(input: {
  conversationId: string;
  database: FirebaseFirestore.Firestore;
}): Promise<{ leaseId: string; generation: number } | null> {
  const ref = input.database.doc(`slackConversations/${input.conversationId}`);
  const leaseId = randomBytes(16).toString("hex");
  return input.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() || {};
    const leaseExpiresAt = data.executionLeaseExpiresAt?.toMillis?.() || 0;
    if (data.executionLeaseId && leaseExpiresAt > Date.now()) return null;
    transaction.set(ref, {
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + slackConversationLeaseMs),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    return { leaseId, generation: Number(data.enqueueGeneration || 0) };
  });
}

async function finishSlackConversationLease(input: {
  conversationId: string;
  leaseId: string;
  database: FirebaseFirestore.Firestore;
  lastCommittedOrderKey?: string;
}): Promise<void> {
  const ref = input.database.doc(`slackConversations/${input.conversationId}`);
  await input.database.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (current.data()?.executionLeaseId !== input.leaseId) return;
    const currentOrderKey = String(current.data()?.lastCommittedOrderKey || "");
    const nextOrderKey = input.lastCommittedOrderKey
      && input.lastCommittedOrderKey > currentOrderKey
      ? input.lastCommittedOrderKey
      : currentOrderKey;
    transaction.set(ref, {
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      ...(nextOrderKey ? { lastCommittedOrderKey: nextOrderKey } : {}),
      updatedAt: Timestamp.now(),
    }, { merge: true });
  });
}

async function assertSlackConversationLease(input: {
  conversationId: string;
  leaseId: string;
  database: FirebaseFirestore.Firestore;
}): Promise<void> {
  const current = await input.database.doc(`slackConversations/${input.conversationId}`).get();
  if (current.data()?.executionLeaseId !== input.leaseId) {
    throw new SlackConversationBusyError();
  }
}

export async function drainSlackConversation(input: {
  conversationId: string;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: SlackConversationDependencies;
}): Promise<{ processed: number; acquired: boolean }> {
  const database = input.database || db;
  const wait = input.dependencies?.wait || ((milliseconds: number) => new Promise(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  await wait(slackReorderWindowMs);
  const claim = await claimSlackConversation({ conversationId: input.conversationId, database });
  if (!claim) return { processed: 0, acquired: false };
  const conversationRef = database.doc(`slackConversations/${input.conversationId}`);
  const eventsRef = conversationRef.collection("events");
  const conversation = await conversationRef.get();
  const committedBeforeRun = String(conversation.data()?.lastCommittedOrderKey || "");
  let processed = 0;
  let lastCommittedOrderKey = "";
  try {
    while (processed < 100) {
      const pending = await eventsRef.where("pending", "==", true)
        .orderBy("orderKey", "asc").limit(1).get();
      const document = pending.docs[0];
      if (!document) break;
      const event = document.data() as QueuedSlackDmEvent & Record<string, unknown>;
      const orderKey = String(event.orderKey || "");
      const lateArrival = Boolean(committedBeforeRun && orderKey <= committedBeforeRun);
      await document.ref.set({
        status: "processing",
        attempts: Number(event.attempts || 0) + 1,
        lastAttemptAt: Timestamp.now(),
        executionLeaseId: claim.leaseId,
        ...(lateArrival ? { lateArrival: true } : {}),
      }, { merge: true });
      let deliveryStarted = false;
      try {
        let prepared: PreparedSlackReply;
        const storedReply = typeof event.replyText === "string" ? event.replyText : "";
        if (storedReply) {
          const workspace = await resolveSlackWorkspace(event.teamId, database);
          if (!workspace) {
            prepared = { outcome: "ignored", replyText: null, route: "ignored" };
          } else {
            const authorize = input.dependencies?.authorize || authorizedSlackDirect;
            const authorization = await authorize({
              ...workspace,
              credentialKey: input.credentialKey,
              database,
            });
            prepared = {
              outcome: String(event.outcome || "answered") as "answered" | "link_requested",
              replyText: storedReply,
              route: String(event.route || "company_fact") as SlackTurnRoute,
              ...workspace,
              botToken: authorization.botToken,
              runId: String(event.runId || ""),
            };
          }
        } else {
          prepared = await processSlackDmEvent({
            event,
            credentialKey: input.credentialKey,
            geminiApiKey: input.geminiApiKey,
            appOrigin: input.appOrigin,
            hasPriorTurn: Boolean(lastCommittedOrderKey
              || (await conversationRef.get()).data()?.lastCommittedOrderKey),
            lateArrival,
            dependencies: input.dependencies,
            database,
          });
          await document.ref.set({
            outcome: prepared.outcome,
            route: prepared.route,
            replyText: prepared.replyText,
            runId: prepared.runId || null,
            status: prepared.replyText ? "reply_ready" : "processed",
            pending: Boolean(prepared.replyText),
            preparedAt: Timestamp.now(),
          }, { merge: true });
        }
        if (prepared.replyText && prepared.botToken) {
          await assertSlackConversationLease({
            conversationId: input.conversationId,
            leaseId: claim.leaseId,
            database,
          });
          deliveryStarted = true;
          const post = input.dependencies?.post || postSlackText;
          const posted = await post({
            token: prepared.botToken,
            channelId: event.channelId,
            text: prepared.replyText,
            clientMessageId: event.eventId,
          });
          await document.ref.set({
            status: "processed",
            pending: false,
            messageTs: posted.messageTs,
            processedAt: Timestamp.now(),
            lastError: null,
            executionLeaseId: null,
          }, { merge: true });
          if (prepared.companyId && prepared.runId) {
            await database.doc(companyDocumentPath(
              prepared.companyId,
              "agentRuns",
              prepared.runId,
            )).set({
              replyIdentity: {
                slackEventId: event.eventId,
                clientMessageId: event.eventId,
                messageTs: posted.messageTs,
                channelId: event.channelId,
                deliveryStatus: "succeeded",
              },
              deliveredAt: Timestamp.now(),
            }, { merge: true });
          }
        } else {
          await document.ref.set({
            status: "processed",
            pending: false,
            processedAt: Timestamp.now(),
            executionLeaseId: null,
          }, { merge: true });
        }
        processed += 1;
        lastCommittedOrderKey = String(event.orderKey || "");
      } catch (error) {
        if (!deliveryStarted) {
          const attempts = Number(event.attempts || 0) + 1;
          const retryable = attempts < 4;
          await document.ref.set({
            status: retryable ? "failed_safe_to_retry" : "failed",
            pending: retryable,
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
            failedAt: Timestamp.now(),
            executionLeaseId: null,
          }, { merge: true });
          if (retryable) throw error;
          processed += 1;
          lastCommittedOrderKey = orderKey;
          continue;
        }
        const status = classifySlackDeliveryFailure(error);
        const attempts = Number(event.attempts || 0) + 1;
        const retryable = status === "failed_safe_to_retry" && attempts < 4;
        await document.ref.set({
          status: retryable ? status : status === "failed_safe_to_retry" ? "failed" : status,
          pending: retryable,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
          failedAt: Timestamp.now(),
          executionLeaseId: null,
        }, { merge: true });
        if (retryable) throw error;
        processed += 1;
        lastCommittedOrderKey = String(event.orderKey || "");
      }
    }
    return { processed, acquired: true };
  } finally {
    await finishSlackConversationLease({
      conversationId: input.conversationId,
      leaseId: claim.leaseId,
      database,
      lastCommittedOrderKey,
    });
  }
}
