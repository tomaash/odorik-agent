import { randomBytes } from "node:crypto";
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
import { teamsConversationHandoff } from "../agent/cross-surface-continuity.js";
import { prepareConversationTaskProposal } from "../agent/task-proposal.js";
import { prepareConversationMailDraftProposal } from "../agent/mail-draft-proposal.js";
import { resolveMicrosoftTeamsTenant } from "../connectors/microsoft-teams.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { routeSlackTurn, type SlackTurnRoute } from "./slack-events.js";
import { assertMicrosoftTeamsServiceUrl, sendMicrosoftTeamsActivity } from "./microsoft-teams-bot.js";
import {
  createMicrosoftTeamsLink,
  microsoftTeamsGlobalIdentityPath,
  microsoftTeamsIdentityPath,
  resolveMicrosoftTeamsLinkedIdentity,
} from "./microsoft-teams-link.js";
import {
  bindMicrosoftTeamsApprovalTicket,
  issueMicrosoftTeamsApprovalTicket,
  microsoftTeamsProposalCard,
} from "./microsoft-teams-interactions.js";

export type QueuedMicrosoftTeamsMessage = {
  activityId: string;
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
  conversationId: string;
  serviceUrl: string;
  text: string;
  timestamp: string;
};

export class MicrosoftTeamsActivityError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MicrosoftTeamsActivityError";
  }
}

export class MicrosoftTeamsConversationBusyError extends Error {
  constructor() {
    super("Teams conversation is already being processed");
    this.name = "MicrosoftTeamsConversationBusyError";
  }
}

export const microsoftTeamsConversationContextVersion = "teams-conversation-v1";
export const microsoftTeamsConversationLeaseMs = 6 * 60 * 1_000;
export const microsoftTeamsReorderWindowMs = 750;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function parseMicrosoftTeamsPersonalMessage(activity: unknown): QueuedMicrosoftTeamsMessage | null {
  const value = record(activity);
  if (value.type !== "message" || value.channelId !== "msteams") return null;
  const conversation = record(value.conversation);
  if (conversation.conversationType !== "personal") return null;
  const from = record(value.from);
  const channelData = record(value.channelData);
  const tenant = record(channelData.tenant);
  const timestamp = String(value.timestamp || "");
  const result = {
    activityId: String(value.id || "").trim(),
    tenantId: String(tenant.id || conversation.tenantId || "").trim(),
    entraObjectId: String(from.aadObjectId || from.id || "").trim(),
    teamsUserId: String(from.id || "").trim(),
    conversationId: String(conversation.id || "").trim(),
    serviceUrl: String(value.serviceUrl || "").trim(),
    text: String(value.text || "").replace(/<at>.*?<\/at>/giu, "").trim().slice(0, 3_000),
    timestamp,
  };
  if (!result.text) return null;
  if (!result.activityId || !result.tenantId || !result.entraObjectId || !result.teamsUserId
    || !result.conversationId || !result.serviceUrl || !timestamp
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new MicrosoftTeamsActivityError("Incomplete Teams personal-message identity");
  }
  try {
    assertMicrosoftTeamsServiceUrl(result.serviceUrl);
  } catch (error) {
    throw new MicrosoftTeamsActivityError(error instanceof Error ? error.message : String(error));
  }
  return result;
}

export function microsoftTeamsConversationId(event: Pick<QueuedMicrosoftTeamsMessage,
  "tenantId" | "conversationId" | "entraObjectId"
>) {
  return sha256Hex(`${event.tenantId}:${event.conversationId}:${event.entraObjectId}`).slice(0, 48);
}

export function microsoftTeamsEventPath(event: QueuedMicrosoftTeamsMessage) {
  return `microsoftTeamsConversations/${microsoftTeamsConversationId(event)}/events/${sha256Hex(event.activityId)}`;
}

export function microsoftTeamsEventOrderKey(event: Pick<QueuedMicrosoftTeamsMessage, "timestamp" | "activityId">) {
  return `${String(Date.parse(event.timestamp)).padStart(20, "0")}:${event.activityId}`;
}

export async function queueMicrosoftTeamsMessage(input: {
  event: QueuedMicrosoftTeamsMessage;
  database?: FirebaseFirestore.Firestore;
}): Promise<"queued" | "duplicate"> {
  const database = input.database || db;
  const conversationId = microsoftTeamsConversationId(input.event);
  const conversationRef = database.doc(`microsoftTeamsConversations/${conversationId}`);
  const eventRef = database.doc(microsoftTeamsEventPath(input.event));
  return database.runTransaction(async (transaction) => {
    const existing = await transaction.get(eventRef);
    if (existing.exists) return "duplicate";
    const conversation = await transaction.get(conversationRef);
    transaction.set(conversationRef, {
      conversationId,
      tenantId: input.event.tenantId,
      entraObjectId: input.event.entraObjectId,
      teamsUserId: input.event.teamsUserId,
      providerConversationId: input.event.conversationId,
      serviceUrl: input.event.serviceUrl,
      enqueueGeneration: Number(conversation.data()?.enqueueGeneration || 0) + 1,
      ...(!conversation.exists ? { createdAt: Timestamp.now() } : {}),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    transaction.create(eventRef, {
      ...input.event,
      status: "queued",
      pending: true,
      orderKey: microsoftTeamsEventOrderKey(input.event),
      attempts: 0,
      createdAt: Timestamp.now(),
    });
    return "queued";
  });
}

export async function recordMicrosoftTeamsInstallationUpdate(input: {
  activity: Record<string, unknown>;
  installed: boolean;
  database?: FirebaseFirestore.Firestore;
}): Promise<"recorded" | "ignored"> {
  const database = input.database || db;
  const conversation = record(input.activity.conversation);
  const from = record(input.activity.from);
  const channelData = record(input.activity.channelData);
  const tenant = record(channelData.tenant);
  const tenantId = String(tenant.id || conversation.tenantId || "").trim();
  const entraObjectId = String(from.aadObjectId || from.id || "").trim();
  const teamsUserId = String(from.id || "").trim();
  if (input.activity.channelId !== "msteams" || conversation.conversationType !== "personal"
    || !tenantId || !entraObjectId || !teamsUserId) return "ignored";
  const linked = await resolveMicrosoftTeamsLinkedIdentity({
    tenantId, entraObjectId, teamsUserId, database,
  });
  const workspace = linked || await resolveMicrosoftTeamsTenant({ tenantId, database });
  if (!workspace) return "ignored";
  const connectionRef = database.doc(`companies/${workspace.companyId}/connections/${workspace.connectionId}`);
  const identityRef = database.doc(microsoftTeamsIdentityPath({
    ...workspace,
    entraObjectId,
  }));
  const globalIdentityRef = database.doc(microsoftTeamsGlobalIdentityPath({
    tenantId, entraObjectId, teamsUserId,
  }));
  const now = Timestamp.now();
  await database.runTransaction(async (transaction) => {
    const identity = await transaction.get(identityRef);
    const globalIdentity = await transaction.get(globalIdentityRef);
    transaction.set(connectionRef, {
      installation: {
        status: input.installed ? "installed" : "member_uninstalled",
        lastEventAt: now,
        lastTeamsUserId: teamsUserId,
        ...(input.installed ? {
          lastConversationId: String(conversation.id || ""),
          lastServiceUrl: String(input.activity.serviceUrl || ""),
        } : {}),
      },
      updatedAt: now,
    }, { merge: true });
    if (identity.exists) transaction.set(identityRef, {
      teamsUserId,
      status: input.installed ? identity.data()?.status || "active" : "installation_revoked",
      installationUpdatedAt: now,
      updatedAt: now,
    }, { merge: true });
    if (globalIdentity.exists) transaction.set(globalIdentityRef, {
      teamsUserId,
      status: input.installed ? globalIdentity.data()?.status || "active" : "installation_revoked",
      installationUpdatedAt: now,
      updatedAt: now,
    }, { merge: true });
  });
  return "recorded";
}

function answerText(
  answer: Awaited<ReturnType<typeof askCompanyFactAgent>>,
  appOrigin: string,
) {
  const sources = answer.citations.filter((citation) => citation.externalUrl || citation.internalRoute)
    .slice(0, 8).map((citation) => {
      const url = citation.externalUrl || `${appOrigin.replace(/\/+$/, "")}/${String(citation.internalRoute || "").replace(/^\/+/, "")}`;
      return `[${citation.citationId}: ${citation.title}](${url})`;
    });
  return [answer.answer, sources.length ? `Sources:\n${sources.join("\n")}` : ""]
    .filter(Boolean).join("\n\n").slice(0, 25_000);
}

function simpleReply(route: SlackTurnRoute, text: string, context: Awaited<ReturnType<typeof loadAuthorizedConversationContext>>) {
  if (route === "social") {
    if (/thank|thanks|díky|děkuji/i.test(text)) return "You’re welcome.";
    if (/bye|goodbye|nashledanou/i.test(text)) return "Goodbye — message me whenever you need company context.";
    return "Hello! Ask me about your company’s calls, contacts, cases, tasks, documents, mail, or recent work.";
  }
  if (route === "capability") return "I can answer permission-aware company questions with sources and prepare task or one-recipient email-draft proposals. Consequential actions still require your explicit approval.";
  if (route === "memory_inspect") return describeConversationMemory(context);
  if (route === "session_reset") return "Started a fresh topic. I won’t automatically use the previous session’s discussion state.";
  if (route === "memory_forget") return "Forgot the conversation context I was carrying. Retained transport and audit records will not be used as memory in future turns.";
  return "I won’t execute or approve an action from an ordinary message. I can prepare a supported proposal for your explicit approval.";
}

type PreparedReply = {
  outcome: "answered" | "link_requested" | "ignored";
  route: SlackTurnRoute | "identity_link" | "ignored";
  replyText: string | null;
  companyId?: string;
  runId?: string;
  card?: unknown;
  approvalTicketId?: string;
};

export type MicrosoftTeamsConversationDependencies = {
  ask?: typeof askCompanyFactAgent;
  persistInbound?: typeof persistCompanyAgentInbound;
  persistReply?: typeof persistCompanyConversationReply;
  prepareTask?: typeof prepareConversationTaskProposal;
  prepareMail?: typeof prepareConversationMailDraftProposal;
  send?: typeof sendMicrosoftTeamsActivity;
  wait?: (milliseconds: number) => Promise<void>;
};

export async function processMicrosoftTeamsMessage(input: {
  event: QueuedMicrosoftTeamsMessage;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  hasPriorTurn?: boolean;
  lateArrival?: boolean;
  database?: FirebaseFirestore.Firestore;
  dependencies?: MicrosoftTeamsConversationDependencies;
}): Promise<PreparedReply> {
  const database = input.database || db;
  const linked = await resolveMicrosoftTeamsLinkedIdentity({
    tenantId: input.event.tenantId,
    entraObjectId: input.event.entraObjectId,
    teamsUserId: input.event.teamsUserId,
    database,
  });
  const tenantWorkspace = linked ? null
    : await resolveMicrosoftTeamsTenant({ tenantId: input.event.tenantId, database });
  const workspace = linked || tenantWorkspace;
  const identity = workspace && !linked ? await database.doc(microsoftTeamsIdentityPath({
    ...workspace, entraObjectId: input.event.entraObjectId,
  })).get() : null;
  const uid = linked?.uid
    || (identity?.data()?.status === "active" ? String(identity.data()?.uid || "") : "");
  const membership = uid && workspace
    ? await database.doc(`companies/${workspace.companyId}/memberships/${uid}`).get() : null;
  if (!uid || !membership?.exists || membership.data()?.status !== "active") {
    const link = await createMicrosoftTeamsLink({
      ...(workspace || {}),
      tenantId: input.event.tenantId,
      teamsUserId: input.event.teamsUserId,
      entraObjectId: input.event.entraObjectId,
      appOrigin: input.appOrigin,
      database,
    });
    return {
      outcome: "link_requested",
      route: "identity_link",
      replyText: `To protect company data, link this Teams identity to your Agent Erik account first:\n\n${link.url}\n\nThe link expires in 15 minutes.`,
      ...(workspace ? { companyId: workspace.companyId } : {}),
    };
  }
  if (!workspace) return { outcome: "ignored", route: "ignored", replyText: null };
  await database.doc(`companies/${workspace.companyId}/connections/${workspace.connectionId}`).set({
    installation: {
      status: "installed",
      lastConversationId: input.event.conversationId,
      lastServiceUrl: input.event.serviceUrl,
      lastActivityAt: Timestamp.now(),
    },
    updatedAt: Timestamp.now(),
  }, { merge: true });
  const threadId = `teams_${sha256Hex(`${input.event.tenantId}:${input.event.conversationId}:${uid}`).slice(0, 40)}`;
  const inboundMessageId = `teams_${sha256Hex(input.event.activityId).slice(0, 40)}`;
  const route = routeSlackTurn(input.event.text, input.hasPriorTurn);
  const control: ConversationSessionControl = route === "memory_forget" ? "forget"
    : route === "session_reset" ? "start_fresh" : "continue";
  const activityAtMs = input.lateArrival ? Date.now() : Date.parse(input.event.timestamp);
  const session = await beginConversationSession({
    companyId: workspace.companyId, actorUid: uid, threadId, activityAtMs, control,
    idempotencyKey: inboundMessageId, database,
  });
  const originMetadata = {
    tenantId: input.event.tenantId,
    entraObjectId: input.event.entraObjectId,
    teamsUserId: input.event.teamsUserId,
    conversationId: input.event.conversationId,
    activityId: input.event.activityId,
    timestamp: input.event.timestamp,
    sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration,
    ...(input.lateArrival ? { lateArrival: true } : {}),
  };
  const persistInbound = input.dependencies?.persistInbound || persistCompanyAgentInbound;
  await persistInbound({
    companyId: workspace.companyId, actorUid: uid, threadId,
    question: input.event.text, messageId: inboundMessageId, createdAtMs: activityAtMs,
    origin: "teams_personal", originMetadata, sessionId: session.sessionId,
    memoryGeneration: session.memoryGeneration, database,
  });
  const context = await loadAuthorizedConversationContext({
    companyId: workspace.companyId, actorUid: uid, threadId, session,
    excludeMessageId: inboundMessageId, database,
  });
  const turnMetadata = {
    route,
    contextVersion: microsoftTeamsConversationContextVersion,
    toolPolicy: ["company_fact", "contextual_followup"].includes(route)
      ? "fresh_company_evidence_required" : "no_company_tools",
    contextUsed: {
      sessionId: context.sessionId, memoryGeneration: context.memoryGeneration,
      stateVersion: context.stateVersion,
      recentMessageIds: context.priorMessages.map((message) => message.id),
      estimatedRecentTokens: context.estimatedTokens,
      selectedMemoryIds: context.selectedMemoryIds,
    },
    replyIdentity: { teamsActivityId: input.event.activityId },
  };
  let replyText = "";
  let runId = "";
  let assistantMessageId = "";
  let citations: Awaited<ReturnType<typeof askCompanyFactAgent>>["citations"] = [];
  let confidence: "high" | "medium" | "low" = "high";
  let limitations: string[] = [];
  let card: unknown;
  let approvalTicketId: string | undefined;
  if (["company_fact", "contextual_followup"].includes(route)) {
    const ask = input.dependencies?.ask || askCompanyFactAgent;
    const answer = await ask({
      companyId: workspace.companyId, actorUid: uid, threadId,
      question: input.event.text, geminiApiKey: input.geminiApiKey,
      origin: "teams_personal", originMetadata, inboundMessageId,
      idempotencyKey: input.event.activityId, turnMetadata, conversationContext: context, database,
    });
    replyText = answerText(answer, input.appOrigin);
    runId = answer.runId;
    assistantMessageId = answer.messageId;
    citations = answer.citations;
    confidence = answer.confidence;
    limitations = answer.limitations;
  } else if (route === "action_request") {
    const isMail = /\b(?:draft|email|mail|e-mail|koncept)\b/iu.test(input.event.text)
      && /\b(?:email|mail|e-mail|message|zpráv|koncept)\b/iu.test(input.event.text);
    const common = {
      companyId: workspace.companyId, actorUid: uid, threadId,
      sessionId: session.sessionId, inboundMessageId, request: input.event.text,
      context, geminiApiKey: input.geminiApiKey, database, surface: "teams_personal" as const,
    };
    const proposed = isMail
      ? await (input.dependencies?.prepareMail || prepareConversationMailDraftProposal)(common)
      : await (input.dependencies?.prepareTask || prepareConversationTaskProposal)(common);
    const effectDigest = String(proposed.approval.effectDigest || "");
    const ticket = await issueMicrosoftTeamsApprovalTicket({
      credentialKey: input.credentialKey, ...workspace,
      tenantId: input.event.tenantId, entraObjectId: input.event.entraObjectId,
      teamsUserId: input.event.teamsUserId, uid, conversationId: input.event.conversationId,
      serviceUrl: input.event.serviceUrl, approvalId: proposed.approvalId, effectDigest,
      actionKind: proposed.action.kind, database,
    });
    const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(proposed.approvalId)}`;
    card = microsoftTeamsProposalCard({ proposed, effectDigest, ticketToken: ticket.token, approvalUrl });
    replyText = proposed.action.kind === "mail.draft.create"
      ? `Proposed email draft to ${proposed.action.to[0]}: ${proposed.action.subject}.`
      : `Proposed task: ${proposed.action.title}.`;
    const persistReply = input.dependencies?.persistReply || persistCompanyConversationReply;
    const persisted = await persistReply({
      companyId: workspace.companyId, actorUid: uid, threadId, inboundMessageId,
      idempotencyKey: input.event.activityId, question: input.event.text, answer: replyText,
      origin: "teams_personal", originMetadata, turnMetadata: { ...turnMetadata,
        proposal: { approvalId: proposed.approvalId, effectDigest, actionKind: proposed.action.kind } },
      sessionId: session.sessionId, memoryGeneration: session.memoryGeneration, database,
    });
    runId = persisted.runId;
    assistantMessageId = persisted.messageId;
    citations = proposed.citations;
    approvalTicketId = ticket.ticketId;
  } else {
    replyText = simpleReply(route, input.event.text, context);
    const persistReply = input.dependencies?.persistReply || persistCompanyConversationReply;
    const persisted = await persistReply({
      companyId: workspace.companyId, actorUid: uid, threadId, inboundMessageId,
      idempotencyKey: input.event.activityId, question: input.event.text, answer: replyText,
      origin: "teams_personal", originMetadata, turnMetadata,
      sessionId: session.sessionId, memoryGeneration: session.memoryGeneration, database,
    });
    runId = persisted.runId;
    assistantMessageId = persisted.messageId;
  }
  const completed = await completeConversationSessionTurn({
    companyId: workspace.companyId, actorUid: uid, threadId, session,
    userMessageId: inboundMessageId, assistantMessageId, question: input.event.text,
    route, citations, confidence, limitations, activityAtMs, database,
  });
  await database.doc(companyDocumentPath(workspace.companyId, "agentRuns", runId)).set({
    contextUsed: { ...turnMetadata.contextUsed, resultingStateVersion: completed.stateVersion },
  }, { merge: true });
  return { outcome: "answered", route,
    replyText: teamsConversationHandoff(replyText, input.appOrigin, threadId),
    companyId: workspace.companyId,
    runId, card, approvalTicketId };
}

async function claim(input: { conversationId: string; database: FirebaseFirestore.Firestore }) {
  const ref = input.database.doc(`microsoftTeamsConversations/${input.conversationId}`);
  const leaseId = randomBytes(16).toString("hex");
  return input.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    if (snapshot.data()?.executionLeaseId
      && (snapshot.data()?.executionLeaseExpiresAt?.toMillis?.() || 0) > Date.now()) return null;
    transaction.set(ref, { executionLeaseId: leaseId,
      executionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + microsoftTeamsConversationLeaseMs),
      updatedAt: Timestamp.now() }, { merge: true });
    return { leaseId };
  });
}

async function finish(input: { conversationId: string; leaseId: string; orderKey?: string; database: FirebaseFirestore.Firestore }) {
  const ref = input.database.doc(`microsoftTeamsConversations/${input.conversationId}`);
  await input.database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.data()?.executionLeaseId !== input.leaseId) return;
    const existing = String(snapshot.data()?.lastCommittedOrderKey || "");
    transaction.set(ref, { executionLeaseId: null, executionLeaseExpiresAt: null,
      lastCommittedOrderKey: input.orderKey && input.orderKey > existing ? input.orderKey : existing,
      updatedAt: Timestamp.now() }, { merge: true });
  });
}

export async function drainMicrosoftTeamsConversation(input: {
  conversationId: string;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: MicrosoftTeamsConversationDependencies;
}) {
  const database = input.database || db;
  const wait = input.dependencies?.wait || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait(microsoftTeamsReorderWindowMs);
  const lease = await claim({ conversationId: input.conversationId, database });
  if (!lease) return { acquired: false, processed: 0 };
  const conversationRef = database.doc(`microsoftTeamsConversations/${input.conversationId}`);
  const before = await conversationRef.get();
  const committedBefore = String(before.data()?.lastCommittedOrderKey || "");
  let processed = 0;
  let lastOrderKey = "";
  try {
    while (processed < 100) {
      const pending = await conversationRef.collection("events").where("pending", "==", true)
        .orderBy("orderKey", "asc").limit(1).get();
      const document = pending.docs[0];
      if (!document) break;
      const event = document.data() as QueuedMicrosoftTeamsMessage & Record<string, unknown>;
      const orderKey = String(event.orderKey || "");
      const lateArrival = Boolean(committedBefore && orderKey <= committedBefore);
      await document.ref.set({ status: "processing", attempts: Number(event.attempts || 0) + 1,
        lastAttemptAt: Timestamp.now(), executionLeaseId: lease.leaseId }, { merge: true });
      let deliveryStarted = false;
      try {
        let prepared: PreparedReply;
        if (typeof event.replyText === "string" && event.replyText) {
          prepared = { outcome: String(event.outcome || "answered") as PreparedReply["outcome"],
            route: String(event.route || "company_fact") as PreparedReply["route"],
            replyText: event.replyText, companyId: String(event.companyId || "") || undefined,
            runId: String(event.runId || "") || undefined, card: event.replyCard,
            approvalTicketId: String(event.approvalTicketId || "") || undefined };
        } else {
          prepared = await processMicrosoftTeamsMessage({
            event, credentialKey: input.credentialKey, geminiApiKey: input.geminiApiKey,
            appOrigin: input.appOrigin, hasPriorTurn: Boolean(lastOrderKey || committedBefore),
            lateArrival, database, dependencies: input.dependencies,
          });
          await document.ref.set({ outcome: prepared.outcome, route: prepared.route,
            replyText: prepared.replyText, companyId: prepared.companyId || null,
            runId: prepared.runId || null, replyCard: prepared.card || null,
            approvalTicketId: prepared.approvalTicketId || null,
            status: prepared.replyText ? "reply_ready" : "processed",
            pending: Boolean(prepared.replyText), preparedAt: Timestamp.now() }, { merge: true });
        }
        if (prepared.replyText) {
          const current = await conversationRef.get();
          if (current.data()?.executionLeaseId !== lease.leaseId) throw new MicrosoftTeamsConversationBusyError();
          deliveryStarted = true;
          const send = input.dependencies?.send || sendMicrosoftTeamsActivity;
          const sent = await send({ clientId: input.clientId, clientSecret: input.clientSecret,
            tenantId: input.tenantId,
            serviceUrl: event.serviceUrl, conversationId: event.conversationId,
            text: prepared.replyText, card: prepared.card });
          if (prepared.approvalTicketId) await bindMicrosoftTeamsApprovalTicket({
            ticketId: prepared.approvalTicketId, activityId: sent.activityId, database,
          });
          await document.ref.set({ status: "processed", pending: false, replyActivityId: sent.activityId,
            processedAt: Timestamp.now(), executionLeaseId: null, lastError: null }, { merge: true });
          if (prepared.companyId && prepared.runId) await database.doc(companyDocumentPath(
            prepared.companyId, "agentRuns", prepared.runId,
          )).set({ replyIdentity: { teamsActivityId: sent.activityId,
            conversationId: event.conversationId, deliveryStatus: "succeeded" },
          deliveredAt: Timestamp.now() }, { merge: true });
        } else {
          await document.ref.set({ status: "processed", pending: false,
            processedAt: Timestamp.now(), executionLeaseId: null }, { merge: true });
        }
        processed += 1;
        lastOrderKey = orderKey;
      } catch (error) {
        if (deliveryStarted) {
          await document.ref.set({ status: "outcome_unknown", pending: false,
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
            failedAt: Timestamp.now(), executionLeaseId: null }, { merge: true });
          processed += 1;
          lastOrderKey = orderKey;
          continue;
        }
        const attempts = Number(event.attempts || 0) + 1;
        await document.ref.set({ status: attempts < 4 ? "failed_safe_to_retry" : "failed",
          pending: attempts < 4, lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
          failedAt: Timestamp.now(), executionLeaseId: null }, { merge: true });
        if (attempts < 4) throw error;
        processed += 1;
        lastOrderKey = orderKey;
      }
    }
    return { acquired: true, processed };
  } finally {
    await finish({ conversationId: input.conversationId, leaseId: lease.leaseId,
      orderKey: lastOrderKey || undefined, database });
  }
}
