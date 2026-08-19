import { createHmac } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import { conversationApprovalPolicy } from "../actions/conversation-policy.js";
import {
  approveAction,
  linkSupersedingApproval,
  rejectAction,
  requestActionChanges,
} from "../approvals/repository.js";
import { prepareConversationMailDraftProposal } from "../agent/mail-draft-proposal.js";
import { prepareConversationTaskProposal } from "../agent/task-proposal.js";
import { loadAuthorizedConversationContextForSession } from "../agent/conversation-memory.js";
import { memberThreadDocumentId } from "../agent/threads.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { microsoftTeamsTenantPath } from "../connectors/microsoft-teams.js";
import {
  microsoftTeamsGlobalIdentityPath,
  microsoftTeamsIdentityPath,
} from "./microsoft-teams-link.js";
import { sendMicrosoftTeamsActivity } from "./microsoft-teams-bot.js";

export const teamsApproveAction = "erik_proposal_approve_v1";
export const teamsRejectAction = "erik_proposal_reject_v1";
export const teamsRequestChangesAction = "erik_proposal_request_changes_v1";
export const microsoftTeamsApprovalTicketLifetimeMs = 24 * 60 * 60 * 1_000;

export type MicrosoftTeamsDecision = "approve" | "reject" | "request_changes";
type ConversationActionKind = "task.create" | "mail.draft.create";

export class MicrosoftTeamsInteractionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MicrosoftTeamsInteractionError";
  }
}

function tokenFor(input: {
  credentialKey: string;
  companyId: string;
  connectionId: string;
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
  conversationId: string;
  approvalId: string;
  effectDigest: string;
}) {
  return createHmac("sha256", input.credentialKey).update([
    "teams-approval-v1", input.companyId, input.connectionId, input.tenantId,
    input.entraObjectId, input.teamsUserId, input.conversationId,
    input.approvalId, input.effectDigest,
  ].join(":"), "utf8").digest("base64url");
}

export async function issueMicrosoftTeamsApprovalTicket(input: {
  credentialKey: string;
  companyId: string;
  connectionId: string;
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
  uid: string;
  conversationId: string;
  serviceUrl: string;
  approvalId: string;
  effectDigest: string;
  actionKind: ConversationActionKind;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const token = tokenFor(input);
  const ref = database.doc(`microsoftTeamsApprovalTickets/${sha256Hex(token)}`);
  const now = Timestamp.now();
  const policy = conversationApprovalPolicy(input.actionKind, "teams_personal");
  await database.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.approvalId !== input.approvalId || data.effectDigest !== input.effectDigest
        || data.entraObjectId !== input.entraObjectId || data.conversationId !== input.conversationId) {
        throw new MicrosoftTeamsInteractionError("Approval ticket identity collision", 409);
      }
      return;
    }
    transaction.create(ref, {
      ticketVersion: 1,
      status: "pending",
      companyId: input.companyId,
      connectionId: input.connectionId,
      tenantId: input.tenantId,
      entraObjectId: input.entraObjectId,
      teamsUserId: input.teamsUserId,
      uid: input.uid,
      conversationId: input.conversationId,
      serviceUrl: input.serviceUrl,
      activityId: null,
      approvalId: input.approvalId,
      effectDigest: input.effectDigest,
      actionKind: input.actionKind,
      policy,
      expiresAt: Timestamp.fromMillis(now.toMillis() + microsoftTeamsApprovalTicketLifetimeMs),
      createdAt: now,
      updatedAt: now,
    });
  });
  return { token, ticketId: ref.id };
}

export async function bindMicrosoftTeamsApprovalTicket(input: {
  ticketId: string;
  activityId: string;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const ref = database.doc(`microsoftTeamsApprovalTickets/${input.ticketId}`);
  await database.runTransaction(async (transaction) => {
    const ticket = await transaction.get(ref);
    if (!ticket.exists) throw new MicrosoftTeamsInteractionError("Teams approval ticket is unavailable", 404);
    const existing = String(ticket.data()?.activityId || "");
    if (existing && existing !== input.activityId) {
      throw new MicrosoftTeamsInteractionError("Teams approval ticket is already bound", 409);
    }
    transaction.set(ref, { activityId: input.activityId, updatedAt: Timestamp.now() }, { merge: true });
  });
}

function actions(token: string) {
  return [
    { type: "Action.Execute", title: "Approve", style: "positive", verb: teamsApproveAction,
      data: { action: teamsApproveAction, token } },
    { type: "Action.Execute", title: "Reject", verb: teamsRejectAction,
      data: { action: teamsRejectAction, token } },
    { type: "Action.Execute", title: "Request changes", verb: teamsRequestChangesAction,
      data: { action: teamsRequestChangesAction, token } },
  ];
}

function facts(values: Array<[string, string | null | undefined]>) {
  return values.filter(([, value]) => value).map(([title, value]) => ({ title, value }));
}

export function microsoftTeamsProposalCard(input: {
  proposed: {
    approvalId: string;
    action: Record<string, unknown> & { kind: ConversationActionKind };
    citations: Array<{ title: string }>;
    assumptions: string[];
  };
  effectDigest: string;
  ticketToken: string;
  approvalUrl: string;
  version?: number;
}) {
  const action = input.proposed.action;
  const mail = action.kind === "mail.draft.create";
  const body: unknown[] = [
    { type: "TextBlock", text: `${mail ? "Email draft" : "Task"} proposal · version ${input.version || 1}`,
      weight: "Bolder", size: "Medium", wrap: true },
    { type: "FactSet", facts: mail
      ? facts([["Mailbox", String(action.mailboxAddress || "")], ["To", String((action.to as string[] | undefined)?.[0] || "")], ["Subject", String(action.subject || "")]])
      : facts([["Title", String(action.title || "")], ["Assignee", String(action.assigneeName || "")], ["Due", action.dueAt ? String(action.dueAt) : "Not set"]]) },
    { type: "TextBlock", text: mail ? String(action.body || "") : String(action.instructions || "No additional instructions."),
      wrap: true, maxLines: 12 },
    { type: "TextBlock", text: `Evidence: ${input.proposed.citations.map((item) => item.title).join("; ") || "none"}`,
      wrap: true, isSubtle: true },
    ...(input.proposed.assumptions.length ? [{ type: "TextBlock",
      text: `Assumptions: ${input.proposed.assumptions.join("; ")}`, wrap: true, color: "Attention" }] : []),
    { type: "Input.Text", id: "decisionNote", label: "Reason or requested changes",
      isMultiline: true, maxLength: 2000, isRequired: false },
    { type: "TextBlock", text: `[Open the exact approval record](${input.approvalUrl}) · digest ${input.effectDigest.slice(0, 12)}…`,
      wrap: true, isSubtle: true, size: "Small" },
  ];
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body,
    actions: actions(input.ticketToken),
  };
}

export function parseMicrosoftTeamsDecision(activity: Record<string, unknown>): {
  decision: MicrosoftTeamsDecision;
  token: string;
  note: string | null;
  tenantId: string;
  entraObjectId: string;
  teamsUserId: string;
  conversationId: string;
  replyToId: string;
} {
  const value = (activity.value || {}) as Record<string, unknown>;
  const action = (value.action || {}) as Record<string, unknown>;
  const data = (action.data || {}) as Record<string, unknown>;
  const actionName = String(action.verb || data.action || "");
  const decision: MicrosoftTeamsDecision | null = actionName === teamsApproveAction ? "approve"
    : actionName === teamsRejectAction ? "reject"
      : actionName === teamsRequestChangesAction ? "request_changes" : null;
  if (!decision) throw new MicrosoftTeamsInteractionError("Unsupported Teams card action");
  const token = String(data.token || "");
  const noteValue = value.decisionNote ?? data.decisionNote;
  const note = typeof noteValue === "string" && noteValue.trim() ? noteValue.trim().slice(0, 2_000) : null;
  if (decision === "request_changes" && !note) {
    throw new MicrosoftTeamsInteractionError("Describe the requested changes");
  }
  const from = (activity.from || {}) as Record<string, unknown>;
  const conversation = (activity.conversation || {}) as Record<string, unknown>;
  const channelData = (activity.channelData || {}) as Record<string, unknown>;
  const tenant = (channelData.tenant || {}) as Record<string, unknown>;
  const result = {
    decision,
    token,
    note,
    tenantId: String(tenant.id || conversation.tenantId || ""),
    entraObjectId: String(from.aadObjectId || from.id || ""),
    teamsUserId: String(from.id || ""),
    conversationId: String(conversation.id || ""),
    replyToId: String(activity.replyToId || ""),
  };
  if (Object.values(result).some((entry) => entry === "")) {
    throw new MicrosoftTeamsInteractionError("Incomplete Teams card identity");
  }
  return result;
}

export async function queueMicrosoftTeamsDecision(input: {
  activity: Record<string, unknown>;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const request = parseMicrosoftTeamsDecision(input.activity);
  const ticketRef = database.doc(`microsoftTeamsApprovalTickets/${sha256Hex(request.token)}`);
  return database.runTransaction(async (transaction) => {
    const ticket = await transaction.get(ticketRef);
    const data = ticket.data() || {};
    const approvalRef = database.doc(companyDocumentPath(
      String(data.companyId || ""), "actionApprovals", String(data.approvalId || ""),
    ));
    const tenantRef = database.doc(microsoftTeamsTenantPath(request.tenantId));
    const identityRef = database.doc(microsoftTeamsIdentityPath({
      companyId: String(data.companyId || ""),
      connectionId: String(data.connectionId || ""),
      entraObjectId: request.entraObjectId,
    }));
    const globalIdentityRef = database.doc(microsoftTeamsGlobalIdentityPath(request));
    const connectionRef = database.doc(`companies/${String(data.companyId || "")}/connections/${String(data.connectionId || "")}`);
    const capabilityRef = connectionRef.collection("capabilities").doc("chat_direct");
    const membershipRef = database.doc(`companies/${String(data.companyId || "")}/memberships/${String(data.uid || "")}`);
    const interactionRef = database.doc(`microsoftTeamsApprovalInteractions/${ticketRef.id}`);
    const [approval, tenant, identity, globalIdentity, connection, capability, membership, existing] = await Promise.all([
      transaction.get(approvalRef), transaction.get(tenantRef), transaction.get(identityRef),
      transaction.get(globalIdentityRef),
      transaction.get(connectionRef), transaction.get(capabilityRef), transaction.get(membershipRef),
      transaction.get(interactionRef),
    ]);
    const approvalData = approval.data() || {};
    const allowed = Array.isArray(data.policy?.allowedDecisions) ? data.policy.allowedDecisions.map(String) : [];
    const tenantScopedIdentity = tenant.exists && tenant.data()?.status === "active"
      && tenant.data()?.companyId === data.companyId && tenant.data()?.connectionId === data.connectionId
      && identity.exists && identity.data()?.status === "active" && identity.data()?.uid === data.uid;
    const linkedIdentity = globalIdentity.exists && globalIdentity.data()?.status === "active"
      && globalIdentity.data()?.companyId === data.companyId
      && globalIdentity.data()?.connectionId === data.connectionId
      && globalIdentity.data()?.uid === data.uid
      && globalIdentity.data()?.tenantId === request.tenantId
      && globalIdentity.data()?.entraObjectId === request.entraObjectId
      && globalIdentity.data()?.teamsUserId === request.teamsUserId;
    if (!ticket.exists || !["pending", "queued", "resolved"].includes(String(data.status)) || !request.token
      || data.tenantId !== request.tenantId || data.entraObjectId !== request.entraObjectId
      || data.teamsUserId !== request.teamsUserId || data.conversationId !== request.conversationId
      || (data.activityId && data.activityId !== request.replyToId)
      || (data.expiresAt?.toMillis?.() || 0) < Date.now()
      || (!tenantScopedIdentity && !linkedIdentity)
      || !connection.exists || connection.data()?.status !== "active"
      || !capability.exists || capability.data()?.status !== "active"
      || !membership.exists || membership.data()?.status !== "active"
      || !approval.exists || approvalData.objectType !== "action_approval"
      || approvalData.effectDigest !== data.effectDigest || approvalData.approverUid !== data.uid
      || approvalData.action?.kind !== data.actionKind
      || JSON.stringify(approvalData.policy || null) !== JSON.stringify(data.policy || null)
      || !allowed.includes(request.decision)) {
      throw new MicrosoftTeamsInteractionError("This proposal is no longer approvable", 409);
    }
    if (approvalData.decisionStatus !== "pending") {
      transaction.set(ticketRef, {
        status: "resolved",
        resolvedDecisionStatus: approvalData.decisionStatus || null,
        updatedAt: Timestamp.now(),
      }, { merge: true });
      return {
        status: "resolved" as const,
        interactionId: interactionRef.id,
        companyId: String(data.companyId),
        approvalId: String(data.approvalId),
      };
    }
    if (existing.exists) return { status: "duplicate" as const, interactionId: interactionRef.id };
    if (data.status !== "pending") {
      throw new MicrosoftTeamsInteractionError("This proposal decision is already in progress", 409);
    }
    const now = Timestamp.now();
    transaction.set(ticketRef, { status: "queued", consumedAt: now, updatedAt: now }, { merge: true });
    transaction.create(interactionRef, {
      status: "queued",
      ticketId: ticketRef.id,
      decision: request.decision,
      note: request.note,
      companyId: data.companyId,
      connectionId: data.connectionId,
      uid: data.uid,
      approvalId: data.approvalId,
      effectDigest: data.effectDigest,
      actionKind: data.actionKind,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { status: "queued" as const, interactionId: interactionRef.id,
      companyId: String(data.companyId), approvalId: String(data.approvalId) };
  });
}

export async function processMicrosoftTeamsDecision(input: {
  interactionId: string;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  database?: FirebaseFirestore.Firestore;
}) {
  const database = input.database || db;
  const ref = database.doc(`microsoftTeamsApprovalInteractions/${input.interactionId}`);
  const snapshot = await ref.get();
  const data = snapshot.data() || {};
  if (!snapshot.exists) throw new MicrosoftTeamsInteractionError("Teams decision not found", 404);
  if (data.status === "succeeded") return "duplicate" as const;
  await ref.set({ status: "processing", attempts: Number(data.attempts || 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  try {
    const common = { companyId: String(data.companyId), actorUid: String(data.uid), approvalId: String(data.approvalId) };
    const decision = String(data.decision) as MicrosoftTeamsDecision;
    let result: unknown;
    if (decision === "approve") {
      result = await approveAction(common, { database });
    } else if (decision === "reject") {
      result = await rejectAction({ ...common, note: String(data.note || "") || undefined }, { database });
    } else {
      const note = String(data.note || "").trim();
      const approvalRef = database.doc(companyDocumentPath(
        String(data.companyId), "actionApprovals", String(data.approvalId),
      ));
      const approval = await approvalRef.get();
      const approvalData = approval.data() || {};
      const source = approvalData.source || {};
      if (!approval.exists || source.kind !== "conversation" || source.surface !== "teams_personal") {
        throw new MicrosoftTeamsInteractionError("This proposal cannot be revised from Teams", 409);
      }
      await requestActionChanges({ ...common, note }, { database });
      const original = await database.doc(companyDocumentPath(
        String(data.companyId), "agentThreads",
        memberThreadDocumentId(String(data.uid), String(source.threadId)),
      )).collection("messages").doc(String(source.messageId)).get();
      const originalRequest = String(original.data()?.text || "").trim();
      if (!original.exists || !originalRequest) {
        throw new MicrosoftTeamsInteractionError("The original proposal request is no longer available", 409);
      }
      const context = await loadAuthorizedConversationContextForSession({
        companyId: String(data.companyId), actorUid: String(data.uid),
        threadId: String(source.threadId), sessionId: String(source.sessionId), database,
      });
      const lineage = approvalData.proposalLineage || {};
      const version = Math.max(2, Number(lineage.version || source.proposalVersion || 1) + 1);
      const rootApprovalId = String(lineage.rootApprovalId || source.proposalRootId || data.approvalId);
      const proposalInput = {
        companyId: String(data.companyId), actorUid: String(data.uid),
        threadId: String(source.threadId), sessionId: String(source.sessionId),
        inboundMessageId: String(source.messageId),
        request: `${originalRequest}\n\nThe named approver requested this revision:\n${note}`,
        context, geminiApiKey: input.geminiApiKey, database, surface: "teams_personal" as const,
        lineage: { rootApprovalId, version, supersedesApprovalId: String(data.approvalId), revisionNote: note },
      };
      const proposed = String(data.actionKind) === "mail.draft.create"
        ? await prepareConversationMailDraftProposal(proposalInput)
        : await prepareConversationTaskProposal(proposalInput);
      await linkSupersedingApproval({
        companyId: String(data.companyId), actorUid: String(data.uid),
        previousApprovalId: String(data.approvalId), nextApprovalId: proposed.approvalId,
      }, database);
      const currentTicket = await database.doc(
        `microsoftTeamsApprovalTickets/${String(data.ticketId)}`,
      ).get();
      if (!currentTicket.exists) throw new MicrosoftTeamsInteractionError("Teams ticket is unavailable", 409);
      const ticketData = currentTicket.data() || {};
      const effectDigest = String(proposed.approval.effectDigest || "");
      const ticket = await issueMicrosoftTeamsApprovalTicket({
        credentialKey: input.credentialKey,
        companyId: String(data.companyId), connectionId: String(data.connectionId),
        tenantId: String(ticketData.tenantId), entraObjectId: String(ticketData.entraObjectId),
        teamsUserId: String(ticketData.teamsUserId), uid: String(data.uid),
        conversationId: String(ticketData.conversationId), serviceUrl: String(ticketData.serviceUrl),
        approvalId: proposed.approvalId, effectDigest, actionKind: proposed.action.kind, database,
      });
      const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(proposed.approvalId)}`;
      const card = microsoftTeamsProposalCard({ proposed, effectDigest,
        ticketToken: ticket.token, approvalUrl, version });
      const sent = await sendMicrosoftTeamsActivity({
        clientId: input.clientId, clientSecret: input.clientSecret,
        tenantId: input.tenantId,
        serviceUrl: String(ticketData.serviceUrl), conversationId: String(ticketData.conversationId),
        text: `Revised proposal version ${version} is ready for review.`, card,
      });
      await bindMicrosoftTeamsApprovalTicket({
        ticketId: ticket.ticketId, activityId: sent.activityId, database,
      });
      result = { status: "changes_requested", nextApprovalId: proposed.approvalId, version };
    }
    const now = Timestamp.now();
    await ref.set({ status: "succeeded", result, completedAt: now, updatedAt: now }, { merge: true });
    await database.doc(`microsoftTeamsApprovalTickets/${String(data.ticketId)}`).set({
      status: "resolved", updatedAt: now,
    }, { merge: true });
    return "processed" as const;
  } catch (error) {
    await ref.set({ status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
    throw error;
  }
}

export function microsoftTeamsReceiptCard(input: {
  approvalId: string;
  approval: Record<string, unknown>;
  appOrigin: string;
}) {
  const decision = String(input.approval.decisionStatus || "pending");
  const execution = String(input.approval.executionStatus || "not_started");
  if (decision === "pending") return null;
  const changes = input.approval.resolutionKind === "changes_requested";
  const title = decision === "approved"
    ? execution === "succeeded" ? "Approved and completed" : "Approved — execution needs attention"
    : changes ? "Changes requested" : "Proposal rejected";
  const note = String(input.approval.rejectionNote || "").trim();
  const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(input.approvalId)}`;
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
      ...(note ? [{ type: "TextBlock", text: note, wrap: true }] : []),
      { type: "TextBlock", text: `[View the authoritative approval record](${approvalUrl})`, wrap: true },
    ],
  };
}

export async function syncMicrosoftTeamsApprovalOutcome(input: {
  companyId: string;
  approvalId: string;
  appOrigin: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: { send?: typeof sendMicrosoftTeamsActivity };
}) {
  const database = input.database || db;
  const approval = await database.doc(companyDocumentPath(
    input.companyId, "actionApprovals", input.approvalId,
  )).get();
  if (!approval.exists) return { updated: 0 };
  const card = microsoftTeamsReceiptCard({
    approvalId: input.approvalId,
    approval: approval.data() || {},
    appOrigin: input.appOrigin,
  });
  if (!card) return { updated: 0 };
  const tickets = await database.collection("microsoftTeamsApprovalTickets")
    .where("approvalId", "==", input.approvalId).get();
  let updated = 0;
  for (const ticket of tickets.docs) {
    const data = ticket.data() || {};
    if (data.companyId !== input.companyId || !data.activityId) continue;
    try {
      const send = input.dependencies?.send || sendMicrosoftTeamsActivity;
      await send({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        tenantId: input.tenantId,
        serviceUrl: String(data.serviceUrl),
        conversationId: String(data.conversationId),
        activityId: String(data.activityId),
        text: String((card.body?.[0] as Record<string, unknown> | undefined)?.text || "Proposal resolved."),
        card,
      });
      await ticket.ref.set({ surfaceStatus: "resolved", surfaceError: null,
        surfaceUpdatedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
      updated += 1;
    } catch (error) {
      await ticket.ref.set({ surfaceStatus: "failed",
        surfaceError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        updatedAt: Timestamp.now() }, { merge: true });
    }
  }
  return { updated };
}
