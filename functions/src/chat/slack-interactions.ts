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
import { authorizedSlackDirect } from "../connectors/slack-oauth.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { slackIdentityPath } from "./slack-link.js";
import { openSlackModal, postSlackText, updateSlackMessage } from "./slack.js";

export const slackTaskApproveActionId = "erik_proposal_approve_v1";
export const slackLegacyTaskApproveActionId = "erik_task_approve_v1";
export const slackProposalRejectActionId = "erik_proposal_reject_v1";
export const slackProposalRequestChangesActionId = "erik_proposal_request_changes_v1";
export const slackProposalDecisionModalCallbackId = "erik_proposal_decision_v1";
export const slackApprovalTicketLifetimeMs = 24 * 60 * 60 * 1_000;

type SlackDecision = "approve" | "reject" | "request_changes";
type ConversationActionKind = "task.create" | "mail.draft.create";

type SlackInteractionPayload = {
  type?: string;
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  actions?: Array<{ action_id?: string; value?: string; action_ts?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string }>> };
  };
};

type DecisionRequest = {
  decision: SlackDecision;
  token: string;
  teamId: string;
  slackUserId: string;
  channelId: string;
  messageTs: string;
  actionTs: string;
  note: string | null;
  triggerId: string;
};

export class SlackInteractionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SlackInteractionError";
  }
}

function ticketSecret(input: {
  credentialKey: string;
  companyId: string;
  connectionId: string;
  approvalId: string;
  effectDigest: string;
  teamId: string;
  slackUserId: string;
  uid: string;
  channelId: string;
}): string {
  return createHmac("sha256", input.credentialKey)
    .update([
      "slack-approval-v2",
      input.companyId,
      input.connectionId,
      input.approvalId,
      input.effectDigest,
      input.teamId,
      input.slackUserId,
      input.uid,
      input.channelId,
    ].join(":"))
    .digest("base64url");
}

function ticketPath(token: string): string {
  return `slackApprovalTickets/${sha256Hex(token)}`;
}

function actionIdForDecision(decision: SlackDecision): string {
  if (decision === "approve") return slackTaskApproveActionId;
  if (decision === "reject") return slackProposalRejectActionId;
  return slackProposalRequestChangesActionId;
}

function decisionForActionId(actionId: string): SlackDecision | null {
  if (actionId === slackTaskApproveActionId || actionId === slackLegacyTaskApproveActionId) return "approve";
  if (actionId === slackProposalRejectActionId) return "reject";
  if (actionId === slackProposalRequestChangesActionId) return "request_changes";
  return null;
}

function noteFromView(payload: SlackInteractionPayload): string | null {
  const value = payload.view?.state?.values?.decision_note?.decision_note_input?.value;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : null;
}

function decisionRequest(payload: SlackInteractionPayload): DecisionRequest {
  const teamId = String(payload.team?.id || "");
  const slackUserId = String(payload.user?.id || "");
  if (payload.type === "block_actions") {
    if (payload.actions?.length !== 1) throw new SlackInteractionError("Unsupported Slack interaction");
    const action = payload.actions[0];
    const decision = decisionForActionId(String(action?.action_id || ""));
    if (!decision) throw new SlackInteractionError("Unsupported Slack interaction");
    return {
      decision,
      token: String(action?.value || ""),
      teamId,
      slackUserId,
      channelId: String(payload.channel?.id || payload.container?.channel_id || ""),
      messageTs: String(payload.container?.message_ts || ""),
      actionTs: String(action?.action_ts || ""),
      note: null,
      triggerId: String(payload.trigger_id || ""),
    };
  }
  if (payload.type === "view_submission"
    && payload.view?.callback_id === slackProposalDecisionModalCallbackId) {
    let metadata: { token?: string; decision?: SlackDecision };
    try {
      metadata = JSON.parse(String(payload.view.private_metadata || ""));
    } catch {
      throw new SlackInteractionError("Invalid Slack decision metadata");
    }
    if (!metadata.token || !["reject", "request_changes"].includes(String(metadata.decision))) {
      throw new SlackInteractionError("Invalid Slack decision metadata");
    }
    return {
      decision: metadata.decision!,
      token: metadata.token,
      teamId,
      slackUserId,
      channelId: "",
      messageTs: "",
      actionTs: "",
      note: noteFromView(payload),
      triggerId: "",
    };
  }
  throw new SlackInteractionError("Unsupported Slack interaction");
}

export function parseSlackInteraction(value: unknown): SlackInteractionPayload {
  const raw = typeof value === "string" ? value : "";
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    throw new SlackInteractionError("Invalid Slack interaction payload");
  }
  decisionRequest(payload);
  return payload;
}

export function slackInteractionNeedsModal(payload: SlackInteractionPayload): boolean {
  const request = decisionRequest(payload);
  return payload.type === "block_actions" && request.decision !== "approve";
}

export async function issueSlackApprovalTicket(input: {
  credentialKey: string;
  companyId: string;
  connectionId: string;
  teamId: string;
  slackUserId: string;
  uid: string;
  channelId: string;
  approvalId: string;
  effectDigest: string;
  actionKind?: ConversationActionKind;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ token: string; ticketId: string }> {
  const database = input.database || db;
  const actionKind = input.actionKind || "task.create";
  const policy = conversationApprovalPolicy(actionKind);
  const token = ticketSecret(input);
  const ref = database.doc(ticketPath(token));
  const now = Timestamp.now();
  await database.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.companyId !== input.companyId
        || data.connectionId !== input.connectionId
        || data.approvalId !== input.approvalId
        || data.effectDigest !== input.effectDigest
        || data.teamId !== input.teamId
        || data.slackUserId !== input.slackUserId
        || data.uid !== input.uid
        || data.channelId !== input.channelId
        || String(data.actionKind || "task.create") !== actionKind) {
        throw new SlackInteractionError("Approval ticket identity collision", 409);
      }
      return;
    }
    transaction.create(ref, {
      ticketVersion: 3,
      status: "pending",
      companyId: input.companyId,
      connectionId: input.connectionId,
      teamId: input.teamId,
      slackUserId: input.slackUserId,
      uid: input.uid,
      channelId: input.channelId,
      messageTs: null,
      approvalId: input.approvalId,
      effectDigest: input.effectDigest,
      actionKind,
      policy,
      expiresAt: Timestamp.fromMillis(now.toMillis() + slackApprovalTicketLifetimeMs),
      createdAt: now,
      updatedAt: now,
    });
  });
  return { token, ticketId: ref.id };
}

export async function bindSlackApprovalTicketMessage(input: {
  ticketId: string;
  channelId: string;
  messageTs: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<void> {
  const database = input.database || db;
  const ref = database.doc(`slackApprovalTickets/${input.ticketId}`);
  await database.runTransaction(async (transaction) => {
    const ticket = await transaction.get(ref);
    if (!ticket.exists || ticket.data()?.channelId !== input.channelId) {
      throw new SlackInteractionError("Slack approval ticket is unavailable", 404);
    }
    const existing = String(ticket.data()?.messageTs || "");
    if (existing && existing !== input.messageTs) {
      throw new SlackInteractionError("Slack approval ticket is already bound", 409);
    }
    transaction.set(ref, { messageTs: input.messageTs, updatedAt: Timestamp.now() }, { merge: true });
  });
}

function decisionElements(input: {
  approvalId: string;
  ticketToken: string;
  approveLabel: string;
}) {
  return [{
    type: "button",
    action_id: slackTaskApproveActionId,
    text: { type: "plain_text", text: input.approveLabel, emoji: true },
    style: "primary",
    value: input.ticketToken,
    confirm: {
      title: { type: "plain_text", text: "Approve this exact proposal?" },
      text: { type: "mrkdwn", text: "This authorizes only the version and effect shown in this card." },
      confirm: { type: "plain_text", text: "Approve" },
      deny: { type: "plain_text", text: "Cancel" },
    },
  }, {
    type: "button",
    action_id: slackProposalRequestChangesActionId,
    text: { type: "plain_text", text: "Request changes", emoji: true },
    value: input.ticketToken,
  }, {
    type: "button",
    action_id: slackProposalRejectActionId,
    text: { type: "plain_text", text: "Reject", emoji: true },
    value: input.ticketToken,
  }];
}

function slackMrkdwnText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function proposalContext(input: {
  approvalUrl: string;
  effectDigest: string;
  version?: number;
  boundary: string;
}) {
  return `${input.boundary} · Version ${input.version || 1} · <${input.approvalUrl}|Review in Erik> · Effect ${input.effectDigest.slice(0, 12)}`;
}

export function taskProposalBlocks(input: {
  approvalId: string;
  title: string;
  assigneeName: string;
  instructions: string | null;
  dueAt: string | null;
  evidenceTitles: string[];
  assumptions: string[];
  effectDigest: string;
  approvalUrl: string;
  ticketToken: string;
  version?: number;
}): unknown[] {
  const facts = [
    `*Assignee:* ${slackMrkdwnText(input.assigneeName)}`,
    `*Due:* ${input.dueAt ? new Date(input.dueAt).toLocaleString("en-GB", { timeZone: "Europe/Prague" }) : "No due date"}`,
    input.instructions ? `*Instructions:* ${slackMrkdwnText(input.instructions)}` : "",
    input.evidenceTitles.length ? `*Evidence:* ${input.evidenceTitles.map(slackMrkdwnText).join(", ")}` : "",
    input.assumptions.length ? `*Assumptions:* ${input.assumptions.map(slackMrkdwnText).join(" · ")}` : "",
  ].filter(Boolean).join("\n");
  const policy = conversationApprovalPolicy("task.create");
  return [
    { type: "header", text: { type: "plain_text", text: "Proposed task", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${slackMrkdwnText(input.title)}*\n${facts}`.slice(0, 3_000) } },
    { type: "context", elements: [{ type: "mrkdwn", text: proposalContext({
      approvalUrl: input.approvalUrl,
      effectDigest: input.effectDigest,
      version: input.version,
      boundary: policy.effectBoundary,
    }) }] },
    { type: "actions", block_id: `approval_${input.approvalId}`.slice(0, 255), elements: decisionElements({
      approvalId: input.approvalId,
      ticketToken: input.ticketToken,
      approveLabel: "Approve and create task",
    }) },
  ];
}

export function mailDraftProposalBlocks(input: {
  approvalId: string;
  mailboxAddress: string;
  to: string;
  subject: string;
  body: string;
  evidenceTitles: string[];
  assumptions: string[];
  effectDigest: string;
  approvalUrl: string;
  ticketToken: string;
  version?: number;
}): unknown[] {
  const facts = [
    `*From:* ${slackMrkdwnText(input.mailboxAddress)}`,
    `*To:* ${slackMrkdwnText(input.to)}`,
    `*Subject:* ${slackMrkdwnText(input.subject)}`,
    `*Body:*\n${slackMrkdwnText(input.body)}`,
    input.evidenceTitles.length ? `*Evidence:* ${input.evidenceTitles.map(slackMrkdwnText).join(", ")}` : "",
    input.assumptions.length ? `*Assumptions:* ${input.assumptions.map(slackMrkdwnText).join(" · ")}` : "",
  ].filter(Boolean).join("\n");
  const policy = conversationApprovalPolicy("mail.draft.create");
  return [
    { type: "header", text: { type: "plain_text", text: "Proposed email draft", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: facts.slice(0, 3_000) } },
    { type: "context", elements: [{ type: "mrkdwn", text: proposalContext({
      approvalUrl: input.approvalUrl,
      effectDigest: input.effectDigest,
      version: input.version,
      boundary: policy.effectBoundary,
    }) }] },
    { type: "actions", block_id: `approval_${input.approvalId}`.slice(0, 255), elements: decisionElements({
      approvalId: input.approvalId,
      ticketToken: input.ticketToken,
      approveLabel: "Approve and create draft",
    }) },
  ];
}

async function verifiedSurface(input: {
  request: DecisionRequest;
  database: FirebaseFirestore.Firestore;
}) {
  const ticketRef = input.database.doc(ticketPath(input.request.token));
  const ticket = await ticketRef.get();
  if (!ticket.exists) throw new SlackInteractionError("Approval control is invalid or expired", 403);
  const data = ticket.data() || {};
  const expiresAt = data.expiresAt?.toMillis?.() || 0;
  const channelId = input.request.channelId || String(data.channelId || "");
  const messageTs = input.request.messageTs || String(data.messageTs || "");
  if (data.teamId !== input.request.teamId
    || data.slackUserId !== input.request.slackUserId
    || data.channelId !== channelId
    || (data.messageTs && data.messageTs !== messageTs)
    || expiresAt < Date.now()) {
    throw new SlackInteractionError("Approval control is invalid or expired", 403);
  }
  const [workspace, identity, membership, connection, capability, approval] = await Promise.all([
    input.database.doc(`slackWorkspaces/${input.request.teamId}`).get(),
    input.database.doc(slackIdentityPath({
      companyId: String(data.companyId),
      connectionId: String(data.connectionId),
      slackUserId: input.request.slackUserId,
    })).get(),
    input.database.doc(`companies/${String(data.companyId)}/memberships/${String(data.uid)}`).get(),
    input.database.doc(`companies/${String(data.companyId)}/connections/${String(data.connectionId)}`).get(),
    input.database.doc(`companies/${String(data.companyId)}/connections/${String(data.connectionId)}/capabilities/chat_direct`).get(),
    input.database.doc(companyDocumentPath(String(data.companyId), "actionApprovals", String(data.approvalId))).get(),
  ]);
  const approvalData = approval.data() || {};
  const actionKind = String(approvalData.action?.kind || "");
  if (!workspace.exists || workspace.data()?.status !== "active"
    || workspace.data()?.companyId !== data.companyId
    || workspace.data()?.connectionId !== data.connectionId
    || !identity.exists || identity.data()?.status !== "active" || identity.data()?.uid !== data.uid
    || !membership.exists || membership.data()?.status !== "active"
    || !connection.exists || !["active", "attention"].includes(String(connection.data()?.status))
    || !capability.exists || capability.data()?.status !== "active"
    || !approval.exists || approvalData.objectType !== "action_approval"
    || approvalData.approverUid !== data.uid
    || approvalData.effectDigest !== data.effectDigest
    || actionKind !== String(data.actionKind || "task.create")
    || JSON.stringify(approvalData.policy || null) !== JSON.stringify(data.policy || null)
    || !["task.create", "mail.draft.create"].includes(actionKind)) {
    throw new SlackInteractionError("This proposal is no longer approvable", 409);
  }
  const allowed = Array.isArray(data.policy?.allowedDecisions)
    ? data.policy.allowedDecisions.map(String)
    : conversationApprovalPolicy(actionKind).allowedDecisions;
  if (!allowed.includes(input.request.decision)) {
    throw new SlackInteractionError("This decision is not allowed for the proposal", 403);
  }
  return { ticketRef, ticket: data, approval: approvalData, actionKind: actionKind as ConversationActionKind };
}

export async function openSlackDecisionModal(input: {
  payload: SlackInteractionPayload;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: {
    authorize?: typeof authorizedSlackDirect;
    open?: typeof openSlackModal;
  };
}): Promise<{ status: "opened" | "resolved"; companyId: string; approvalId: string }> {
  const database = input.database || db;
  const request = decisionRequest(input.payload);
  if (request.decision === "approve" || !request.triggerId) {
    throw new SlackInteractionError("This decision does not open a modal");
  }
  const surface = await verifiedSurface({ request, database });
  const result = {
    companyId: String(surface.ticket.companyId),
    approvalId: String(surface.ticket.approvalId),
  };
  if (surface.approval.decisionStatus !== "pending") return { status: "resolved", ...result };
  const authorize = input.dependencies?.authorize || authorizedSlackDirect;
  const authorization = await authorize({
    companyId: String(surface.ticket.companyId),
    connectionId: String(surface.ticket.connectionId),
    credentialKey: input.credentialKey,
    database,
  });
  const open = input.dependencies?.open || openSlackModal;
  const requestingChanges = request.decision === "request_changes";
  await open({
    token: authorization.botToken,
    triggerId: request.triggerId,
    view: {
      type: "modal",
      callback_id: slackProposalDecisionModalCallbackId,
      private_metadata: JSON.stringify({ token: request.token, decision: request.decision }),
      title: { type: "plain_text", text: requestingChanges ? "Request changes" : "Reject proposal" },
      submit: { type: "plain_text", text: requestingChanges ? "Request changes" : "Reject" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [{
        type: "input",
        block_id: "decision_note",
        optional: !requestingChanges,
        label: { type: "plain_text", text: requestingChanges ? "What should change?" : "Reason (optional)" },
        element: {
          type: "plain_text_input",
          action_id: "decision_note_input",
          multiline: true,
          max_length: 2000,
        },
      }],
    },
  });
  return { status: "opened", ...result };
}

export async function queueSlackApprovalInteraction(input: {
  payload: SlackInteractionPayload;
  database?: FirebaseFirestore.Firestore;
}): Promise<{
  status: "queued" | "duplicate" | "resolved";
  interactionId: string;
  companyId: string;
  approvalId: string;
}> {
  const database = input.database || db;
  const request = decisionRequest(input.payload);
  if (request.decision === "request_changes" && !request.note) {
    throw new SlackInteractionError("Describe the requested changes", 400);
  }
  const surface = await verifiedSurface({ request, database });
  const interactionRef = database.doc(`slackApprovalInteractions/${surface.ticketRef.id}`);
  const workspaceRef = database.doc(`slackWorkspaces/${request.teamId}`);
  const identityRef = database.doc(slackIdentityPath({
    companyId: String(surface.ticket.companyId),
    connectionId: String(surface.ticket.connectionId),
    slackUserId: request.slackUserId,
  }));
  const membershipRef = database.doc(`companies/${String(surface.ticket.companyId)}/memberships/${String(surface.ticket.uid)}`);
  const connectionRef = database.doc(`companies/${String(surface.ticket.companyId)}/connections/${String(surface.ticket.connectionId)}`);
  const capabilityRef = database.doc(`companies/${String(surface.ticket.companyId)}/connections/${String(surface.ticket.connectionId)}/capabilities/chat_direct`);
  const approvalRef = database.doc(companyDocumentPath(
    String(surface.ticket.companyId), "actionApprovals", String(surface.ticket.approvalId),
  ));
  return database.runTransaction(async (transaction) => {
    const [ticket, approval, existing, workspace, identity, membership, connection, capability] = await Promise.all([
      transaction.get(surface.ticketRef),
      transaction.get(approvalRef),
      transaction.get(interactionRef),
      transaction.get(workspaceRef),
      transaction.get(identityRef),
      transaction.get(membershipRef),
      transaction.get(connectionRef),
      transaction.get(capabilityRef),
    ]);
    const data = ticket.data() || {};
    const approvalData = approval.data() || {};
    const channelId = request.channelId || String(data.channelId || "");
    const messageTs = request.messageTs || String(data.messageTs || "");
    const actionKind = String(data.actionKind || "task.create");
    const allowed = Array.isArray(data.policy?.allowedDecisions)
      ? data.policy.allowedDecisions.map(String)
      : conversationApprovalPolicy(actionKind).allowedDecisions;
    if (!ticket.exists
      || data.companyId !== surface.ticket.companyId
      || data.connectionId !== surface.ticket.connectionId
      || data.uid !== surface.ticket.uid
      || data.teamId !== request.teamId
      || data.slackUserId !== request.slackUserId
      || data.channelId !== channelId
      || (data.messageTs && data.messageTs !== messageTs)
      || (data.expiresAt?.toMillis?.() || 0) < Date.now()
      || !workspace.exists || workspace.data()?.status !== "active"
      || workspace.data()?.companyId !== data.companyId
      || workspace.data()?.connectionId !== data.connectionId
      || !identity.exists || identity.data()?.status !== "active" || identity.data()?.uid !== data.uid
      || !membership.exists || membership.data()?.status !== "active"
      || !connection.exists || !["active", "attention"].includes(String(connection.data()?.status))
      || !capability.exists || capability.data()?.status !== "active"
      || !approval.exists || approvalData.objectType !== "action_approval"
      || approvalData.effectDigest !== data.effectDigest
      || approvalData.approverUid !== data.uid
      || approvalData.action?.kind !== actionKind
      || JSON.stringify(approvalData.policy || null) !== JSON.stringify(data.policy || null)
      || !["task.create", "mail.draft.create"].includes(actionKind)) {
      throw new SlackInteractionError("This proposal is no longer approvable", 409);
    }
    if (!allowed.includes(request.decision)) {
      throw new SlackInteractionError("This decision is not allowed for the proposal", 403);
    }
    if (approvalData.decisionStatus !== "pending") {
      transaction.set(surface.ticketRef, {
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
    if (existing.exists || data.status !== "pending") {
      return {
        status: "duplicate" as const,
        interactionId: interactionRef.id,
        companyId: String(data.companyId),
        approvalId: String(data.approvalId),
      };
    }
    const now = Timestamp.now();
    transaction.set(surface.ticketRef, {
      status: "queued",
      consumedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.create(interactionRef, {
      status: "queued",
      decision: request.decision,
      note: request.note,
      ticketId: surface.ticketRef.id,
      companyId: data.companyId,
      connectionId: data.connectionId,
      teamId: request.teamId,
      slackUserId: request.slackUserId,
      uid: data.uid,
      channelId: data.channelId,
      messageTs: data.messageTs,
      approvalId: data.approvalId,
      effectDigest: data.effectDigest,
      actionKind: data.actionKind || "task.create",
      actionId: actionIdForDecision(request.decision),
      actionTs: request.actionTs,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: "queued" as const,
      interactionId: interactionRef.id,
      companyId: String(data.companyId),
      approvalId: String(data.approvalId),
    };
  });
}

function receiptBlocks(input: {
  approvalId: string;
  approval: FirebaseFirestore.DocumentData;
  appOrigin: string;
}): { text: string; blocks: unknown[]; surfaceStatus: string } | null {
  const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(input.approvalId)}`;
  const actionKind = String(input.approval.action?.kind || "action");
  const result = input.approval.executionStatus;
  if (input.approval.decisionStatus === "approved" && result === "succeeded") {
    const title = actionKind === "mail.draft.create" ? "Email draft created" : "Task created";
    return {
      text: `${title}.`,
      surfaceStatus: "succeeded",
      blocks: [
        { type: "header", text: { type: "plain_text", text: title, emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `Approved by the named approver and executed exactly once. <${approvalUrl}|View audit and result>` } },
      ],
    };
  }
  if (input.approval.decisionStatus === "approved") {
    return {
      text: "Proposal approved; execution needs attention.",
      surfaceStatus: String(result || "executing"),
      blocks: [
        { type: "header", text: { type: "plain_text", text: result === "executing" ? "Approval accepted" : "Execution needs attention", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: `<${approvalUrl}|Open Erik> for the current execution state and audit.` } },
      ],
    };
  }
  if (input.approval.decisionStatus === "rejected") {
    const changes = input.approval.resolutionKind === "changes_requested";
    const successor = input.approval.supersededByApprovalId
      ? `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(String(input.approval.supersededByApprovalId))}`
      : null;
    return {
      text: changes ? "Changes requested." : "Proposal rejected.",
      surfaceStatus: changes ? "changes_requested" : "rejected",
      blocks: [
        { type: "header", text: { type: "plain_text", text: changes ? "Changes requested" : "Proposal rejected", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: [
          input.approval.rejectionNote ? `*Reason:* ${slackMrkdwnText(input.approval.rejectionNote).slice(0, 2_000)}` : "",
          successor ? `<${successor}|Review replacement proposal>` : `<${approvalUrl}|View decision in Erik>`,
        ].filter(Boolean).join("\n") } },
      ],
    };
  }
  return null;
}

export async function syncSlackApprovalOutcome(input: {
  companyId: string;
  approvalId: string;
  credentialKey: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: {
    authorize?: typeof authorizedSlackDirect;
    update?: typeof updateSlackMessage;
  };
}): Promise<{ updated: number }> {
  const database = input.database || db;
  const approval = await database.doc(companyDocumentPath(
    input.companyId, "actionApprovals", input.approvalId,
  )).get();
  if (!approval.exists) return { updated: 0 };
  const rendered = receiptBlocks({
    approvalId: input.approvalId,
    approval: approval.data() || {},
    appOrigin: input.appOrigin,
  });
  if (!rendered) return { updated: 0 };
  const tickets = await database.collection("slackApprovalTickets")
    .where("approvalId", "==", input.approvalId)
    .get();
  let updated = 0;
  for (const ticket of tickets.docs) {
    const data = ticket.data() || {};
    if (data.companyId !== input.companyId) continue;
    if (!data.channelId || !data.messageTs) continue;
    try {
      const authorize = input.dependencies?.authorize || authorizedSlackDirect;
      const authorization = await authorize({
        companyId: input.companyId,
        connectionId: String(data.connectionId),
        credentialKey: input.credentialKey,
        database,
      });
      const update = input.dependencies?.update || updateSlackMessage;
      await update({
        token: authorization.botToken,
        channelId: String(data.channelId),
        messageTs: String(data.messageTs),
        text: rendered.text,
        blocks: rendered.blocks,
      });
      await ticket.ref.set({
        status: "resolved",
        surfaceStatus: rendered.surfaceStatus,
        surfaceUpdatedAt: Timestamp.now(),
        surfaceError: null,
        updatedAt: Timestamp.now(),
      }, { merge: true });
      updated += 1;
    } catch (error) {
      await ticket.ref.set({
        surfaceStatus: "failed",
        surfaceError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        updatedAt: Timestamp.now(),
      }, { merge: true });
    }
  }
  return { updated };
}

export type SlackApprovalInteractionDependencies = {
  approve?: (input: { companyId: string; actorUid: string; approvalId: string }) => Promise<unknown>;
  reject?: (input: { companyId: string; actorUid: string; approvalId: string; note?: string }) => Promise<unknown>;
  requestChanges?: (input: { companyId: string; actorUid: string; approvalId: string; note: string }) => Promise<unknown>;
  linkSuperseding?: typeof linkSupersedingApproval;
  prepareTask?: typeof prepareConversationTaskProposal;
  prepareMail?: typeof prepareConversationMailDraftProposal;
  authorize?: typeof authorizedSlackDirect;
  update?: typeof updateSlackMessage;
  post?: typeof postSlackText;
  bind?: typeof bindSlackApprovalTicketMessage;
};

function blocksForProposal(input: {
  proposed: Awaited<ReturnType<typeof prepareConversationTaskProposal>> | Awaited<ReturnType<typeof prepareConversationMailDraftProposal>>;
  approvalUrl: string;
  ticketToken: string;
  version: number;
}) {
  const effectDigest = String(input.proposed.approval.effectDigest || "");
  if (input.proposed.action.kind === "mail.draft.create") {
    return mailDraftProposalBlocks({
      approvalId: input.proposed.approvalId,
      mailboxAddress: input.proposed.action.mailboxAddress,
      to: input.proposed.action.to[0],
      subject: input.proposed.action.subject,
      body: input.proposed.action.body,
      evidenceTitles: input.proposed.citations.map((citation) => citation.title),
      assumptions: input.proposed.assumptions,
      effectDigest,
      approvalUrl: input.approvalUrl,
      ticketToken: input.ticketToken,
      version: input.version,
    });
  }
  return taskProposalBlocks({
    approvalId: input.proposed.approvalId,
    title: input.proposed.action.title,
    assigneeName: input.proposed.action.assigneeName,
    instructions: input.proposed.action.instructions,
    dueAt: input.proposed.action.dueAt,
    evidenceTitles: input.proposed.citations.map((citation) => citation.title),
    assumptions: input.proposed.assumptions,
    effectDigest,
    approvalUrl: input.approvalUrl,
    ticketToken: input.ticketToken,
    version: input.version,
  });
}

export async function processSlackApprovalInteraction(input: {
  interactionId: string;
  credentialKey: string;
  geminiApiKey?: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
  dependencies?: SlackApprovalInteractionDependencies;
}): Promise<"processed" | "duplicate"> {
  const database = input.database || db;
  const ref = database.doc(`slackApprovalInteractions/${input.interactionId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new SlackInteractionError("Approval interaction not found", 404);
  const data = snapshot.data() || {};
  if (data.status === "succeeded") return "duplicate";
  const latestRef = database.doc(companyDocumentPath(
    String(data.companyId), "actionApprovals", String(data.approvalId),
  ));
  const latest = await latestRef.get();
  if (!latest.exists
    || latest.data()?.objectType !== "action_approval"
    || latest.data()?.effectDigest !== data.effectDigest
    || latest.data()?.approverUid !== data.uid) {
    await ref.set({ status: "failed", error: "The approval changed after the Slack decision was queued.", completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
    throw new SlackInteractionError("This proposal is no longer approvable", 409);
  }
  await ref.set({ status: "processing", attempts: Number(data.attempts || 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  try {
    const decision = String(data.decision || "approve") as SlackDecision;
    let result: unknown;
    if (decision === "approve") {
      const approve = input.dependencies?.approve || ((value) => approveAction(value, { database }));
      result = await approve({
        companyId: String(data.companyId), actorUid: String(data.uid), approvalId: String(data.approvalId),
      });
    } else if (decision === "reject") {
      const reject = input.dependencies?.reject || ((value) => rejectAction(value, { database }));
      result = await reject({
        companyId: String(data.companyId), actorUid: String(data.uid), approvalId: String(data.approvalId),
        note: typeof data.note === "string" ? data.note : undefined,
      });
    } else {
      const note = String(data.note || "").trim();
      const requestChanges = input.dependencies?.requestChanges
        || ((value) => requestActionChanges(value, { database }));
      await requestChanges({
        companyId: String(data.companyId), actorUid: String(data.uid), approvalId: String(data.approvalId), note,
      });
      const approvalData = latest.data() || {};
      const source = approvalData.source || {};
      if (source.kind !== "conversation" || source.surface !== "slack_dm" || !input.geminiApiKey) {
        throw new SlackInteractionError("This proposal cannot be revised from Slack", 409);
      }
      const threadDocumentId = memberThreadDocumentId(String(data.uid), String(source.threadId));
      const original = await database.doc(companyDocumentPath(
        String(data.companyId), "agentThreads", threadDocumentId,
      )).collection("messages").doc(String(source.messageId)).get();
      const originalRequest = String(original.data()?.text || "").trim();
      if (!original.exists || !originalRequest) {
        throw new SlackInteractionError("The original proposal request is no longer available", 409);
      }
      const context = await loadAuthorizedConversationContextForSession({
        companyId: String(data.companyId), actorUid: String(data.uid), threadId: String(source.threadId),
        sessionId: String(source.sessionId), database,
      });
      const lineage = approvalData.proposalLineage || {};
      const version = Math.max(2, Number(lineage.version || source.proposalVersion || 1) + 1);
      const rootApprovalId = String(lineage.rootApprovalId || source.proposalRootId || data.approvalId);
      const request = `${originalRequest}\n\nThe named approver requested this revision:\n${note}`;
      const common = {
        companyId: String(data.companyId), actorUid: String(data.uid), threadId: String(source.threadId),
        sessionId: String(source.sessionId), inboundMessageId: String(source.messageId), request, context,
        geminiApiKey: input.geminiApiKey, database,
        lineage: { rootApprovalId, version, supersedesApprovalId: String(data.approvalId), revisionNote: note },
      };
      const proposed = String(data.actionKind) === "mail.draft.create"
        ? await (input.dependencies?.prepareMail || prepareConversationMailDraftProposal)(common)
        : await (input.dependencies?.prepareTask || prepareConversationTaskProposal)(common);
      const link = input.dependencies?.linkSuperseding || linkSupersedingApproval;
      await link({
        companyId: String(data.companyId), actorUid: String(data.uid),
        previousApprovalId: String(data.approvalId), nextApprovalId: proposed.approvalId,
      }, database);
      const effectDigest = String(proposed.approval.effectDigest || "");
      const ticket = await issueSlackApprovalTicket({
        credentialKey: input.credentialKey,
        companyId: String(data.companyId), connectionId: String(data.connectionId), teamId: String(data.teamId),
        slackUserId: String(data.slackUserId), uid: String(data.uid), channelId: String(data.channelId),
        approvalId: proposed.approvalId, effectDigest,
        actionKind: proposed.action.kind,
        database,
      });
      const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(proposed.approvalId)}`;
      const blocks = blocksForProposal({ proposed, approvalUrl, ticketToken: ticket.token, version });
      const authorize = input.dependencies?.authorize || authorizedSlackDirect;
      const authorization = await authorize({
        companyId: String(data.companyId), connectionId: String(data.connectionId),
        credentialKey: input.credentialKey, database,
      });
      const post = input.dependencies?.post || postSlackText;
      const posted = await post({
        token: authorization.botToken, channelId: String(data.channelId),
        text: `Revised proposal version ${version} is ready for review.`,
        clientMessageId: `revision_${proposed.approvalId}`,
        blocks,
      });
      const bind = input.dependencies?.bind || bindSlackApprovalTicketMessage;
      await bind({ ticketId: ticket.ticketId, channelId: posted.channelId, messageTs: posted.messageTs, database });
      result = { status: "changes_requested", nextApprovalId: proposed.approvalId, version };
    }
    await ref.set({ status: "succeeded", result, completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
    await database.doc(`slackApprovalTickets/${String(data.ticketId)}`).set({ status: "resolved", updatedAt: Timestamp.now() }, { merge: true });
    await syncSlackApprovalOutcome({
      companyId: String(data.companyId), approvalId: String(data.approvalId),
      credentialKey: input.credentialKey, appOrigin: input.appOrigin, database,
      dependencies: { authorize: input.dependencies?.authorize, update: input.dependencies?.update },
    });
    return "processed";
  } catch (error) {
    await ref.set({
      status: "failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      completedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    await database.doc(`slackApprovalTickets/${String(data.ticketId)}`).set({ status: "failed", updatedAt: Timestamp.now() }, { merge: true });
    throw error;
  }
}
