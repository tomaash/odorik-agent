import { createHmac } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";

import { approveAction } from "../approvals/repository.js";
import { authorizedSlackDirect } from "../connectors/slack-oauth.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyDocumentPath } from "../tenancy.js";
import { slackIdentityPath } from "./slack-link.js";
import { updateSlackMessage } from "./slack.js";

export const slackTaskApproveActionId = "erik_task_approve_v1";
export const slackApprovalTicketLifetimeMs = 24 * 60 * 60 * 1_000;

type SlackInteractionPayload = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  actions?: Array<{ action_id?: string; value?: string; action_ts?: string }>;
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
  approvalId: string;
  teamId: string;
  slackUserId: string;
}): string {
  return createHmac("sha256", input.credentialKey)
    .update([
      "slack-approval-v1",
      input.companyId,
      input.approvalId,
      input.teamId,
      input.slackUserId,
    ].join(":"))
    .digest("base64url");
}

function ticketPath(token: string): string {
  return `slackApprovalTickets/${sha256Hex(token)}`;
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
  database?: FirebaseFirestore.Firestore;
}): Promise<{ token: string; ticketId: string }> {
  const database = input.database || db;
  const token = ticketSecret(input);
  const ref = database.doc(ticketPath(token));
  const now = Timestamp.now();
  await database.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() || {};
      if (
        data.companyId !== input.companyId
        || data.approvalId !== input.approvalId
        || data.effectDigest !== input.effectDigest
      ) throw new SlackInteractionError("Approval ticket identity collision", 409);
      return;
    }
    transaction.create(ref, {
      ticketVersion: 1,
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
      actionId: slackTaskApproveActionId,
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
}): unknown[] {
  const facts = [
    `*Assignee:* ${input.assigneeName}`,
    `*Due:* ${input.dueAt ? new Date(input.dueAt).toLocaleString("en-GB", { timeZone: "Europe/Prague" }) : "No due date"}`,
    input.instructions ? `*Instructions:* ${input.instructions}` : "",
    input.evidenceTitles.length ? `*Evidence:* ${input.evidenceTitles.join(", ")}` : "",
    input.assumptions.length ? `*Assumptions:* ${input.assumptions.join(" · ")}` : "",
  ].filter(Boolean).join("\n");
  return [
    { type: "header", text: { type: "plain_text", text: "Proposed task", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${input.title}*\n${facts}`.slice(0, 3_000) } },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Creates exactly one internal task after approval · <${input.approvalUrl}|Review in Erik> · Effect ${input.effectDigest.slice(0, 12)}`,
      }],
    },
    {
      type: "actions",
      block_id: `approval_${input.approvalId}`.slice(0, 255),
      elements: [{
        type: "button",
        action_id: slackTaskApproveActionId,
        text: { type: "plain_text", text: "Approve and create task", emoji: true },
        style: "primary",
        value: input.ticketToken,
        confirm: {
          title: { type: "plain_text", text: "Create this task?" },
          text: { type: "mrkdwn", text: "This approves the exact proposal shown and creates one internal task." },
          confirm: { type: "plain_text", text: "Approve" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      }],
    },
  ];
}

export function parseSlackInteraction(value: unknown): SlackInteractionPayload {
  const raw = typeof value === "string" ? value : "";
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    throw new SlackInteractionError("Invalid Slack interaction payload");
  }
  if (payload.type !== "block_actions" || payload.actions?.length !== 1) {
    throw new SlackInteractionError("Unsupported Slack interaction");
  }
  return payload;
}

export async function queueSlackApprovalInteraction(input: {
  payload: SlackInteractionPayload;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ status: "queued" | "duplicate"; interactionId: string }> {
  const database = input.database || db;
  const action = input.payload.actions?.[0];
  const token = String(action?.value || "");
  const ticketRef = database.doc(ticketPath(token));
  const interactionRef = database.doc(`slackApprovalInteractions/${ticketRef.id}`);
  return database.runTransaction(async (transaction) => {
    const ticket = await transaction.get(ticketRef);
    if (!ticket.exists) throw new SlackInteractionError("Approval control is invalid or expired", 403);
    const data = ticket.data() || {};
    const now = Timestamp.now();
    const expiresAt = data.expiresAt?.toMillis?.() || 0;
    const teamId = String(input.payload.team?.id || "");
    const slackUserId = String(input.payload.user?.id || "");
    const channelId = String(input.payload.channel?.id || input.payload.container?.channel_id || "");
    const messageTs = String(input.payload.container?.message_ts || "");
    if (
      action?.action_id !== slackTaskApproveActionId
      || data.actionId !== slackTaskApproveActionId
      || data.teamId !== teamId
      || data.slackUserId !== slackUserId
      || data.channelId !== channelId
      || (data.messageTs && data.messageTs !== messageTs)
      || expiresAt < now.toMillis()
    ) throw new SlackInteractionError("Approval control is invalid or expired", 403);
    const existing = await transaction.get(interactionRef);
    if (existing.exists || data.status !== "pending") {
      return { status: "duplicate" as const, interactionId: interactionRef.id };
    }
    const workspace = await transaction.get(database.doc(`slackWorkspaces/${teamId}`));
    const identity = await transaction.get(database.doc(slackIdentityPath({
      companyId: String(data.companyId),
      connectionId: String(data.connectionId),
      slackUserId,
    })));
    const membership = await transaction.get(database.doc(
      `companies/${String(data.companyId)}/memberships/${String(data.uid)}`,
    ));
    const connection = await transaction.get(database.doc(
      `companies/${String(data.companyId)}/connections/${String(data.connectionId)}`,
    ));
    const capability = await transaction.get(database.doc(
      `companies/${String(data.companyId)}/connections/${String(data.connectionId)}/capabilities/chat_direct`,
    ));
    const approval = await transaction.get(database.doc(companyDocumentPath(
      String(data.companyId), "actionApprovals", String(data.approvalId),
    )));
    const approvalData = approval.data() || {};
    if (
      !workspace.exists || workspace.data()?.status !== "active"
      || workspace.data()?.companyId !== data.companyId
      || workspace.data()?.connectionId !== data.connectionId
      || !identity.exists || identity.data()?.status !== "active" || identity.data()?.uid !== data.uid
      || !membership.exists || membership.data()?.status !== "active"
      || !connection.exists || !["active", "attention"].includes(String(connection.data()?.status))
      || !capability.exists || capability.data()?.status !== "active"
      || !approval.exists || approvalData.objectType !== "action_approval"
      || approvalData.decisionStatus !== "pending"
      || approvalData.approverUid !== data.uid
      || approvalData.effectDigest !== data.effectDigest
      || approvalData.action?.kind !== "task.create"
    ) throw new SlackInteractionError("This proposal is no longer approvable", 409);
    transaction.set(ticketRef, {
      status: "queued",
      messageTs: data.messageTs || messageTs,
      consumedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.create(interactionRef, {
      status: "queued",
      ticketId: ticketRef.id,
      companyId: data.companyId,
      connectionId: data.connectionId,
      teamId,
      slackUserId,
      uid: data.uid,
      channelId,
      messageTs: data.messageTs || messageTs,
      approvalId: data.approvalId,
      effectDigest: data.effectDigest,
      actionId: action.action_id,
      actionTs: String(action.action_ts || ""),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { status: "queued" as const, interactionId: interactionRef.id };
  });
}

export type SlackApprovalInteractionDependencies = {
  approve?: typeof approveAction;
  authorize?: typeof authorizedSlackDirect;
  update?: typeof updateSlackMessage;
};

export async function processSlackApprovalInteraction(input: {
  interactionId: string;
  credentialKey: string;
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
  const latest = await database.doc(companyDocumentPath(
    String(data.companyId), "actionApprovals", String(data.approvalId),
  )).get();
  if (
    !latest.exists
    || latest.data()?.objectType !== "action_approval"
    || latest.data()?.effectDigest !== data.effectDigest
    || latest.data()?.approverUid !== data.uid
  ) {
    await ref.set({
      status: "failed",
      error: "The approval changed after the Slack decision was queued.",
      completedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    throw new SlackInteractionError("This proposal is no longer approvable", 409);
  }
  await ref.set({
    status: "processing",
    attempts: Number(data.attempts || 0) + 1,
    updatedAt: Timestamp.now(),
  }, { merge: true });
  try {
    const approve = input.dependencies?.approve || approveAction;
    const result = await approve({
      companyId: String(data.companyId),
      actorUid: String(data.uid),
      approvalId: String(data.approvalId),
    });
    await ref.set({ status: "succeeded", result, completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
    await database.doc(`slackApprovalTickets/${String(data.ticketId)}`).set({
      status: "succeeded", updatedAt: Timestamp.now(),
    }, { merge: true });
    try {
      const authorize = input.dependencies?.authorize || authorizedSlackDirect;
      const authorization = await authorize({
        companyId: String(data.companyId),
        connectionId: String(data.connectionId),
        credentialKey: input.credentialKey,
        database,
      });
      const update = input.dependencies?.update || updateSlackMessage;
      const approvalUrl = `${input.appOrigin.replace(/\/+$/, "")}/approvals/${encodeURIComponent(String(data.approvalId))}`;
      await update({
        token: authorization.botToken,
        channelId: String(data.channelId),
        messageTs: String(data.messageTs),
        text: "Task approved and created.",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Task created", emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: `Approved by <@${String(data.slackUserId)}> and executed exactly once. <${approvalUrl}|View audit and task>` } },
        ],
      });
      await ref.set({ messageUpdateStatus: "succeeded", updatedAt: Timestamp.now() }, { merge: true });
    } catch (error) {
      await ref.set({
        messageUpdateStatus: "failed",
        messageUpdateError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        updatedAt: Timestamp.now(),
      }, { merge: true });
    }
    return "processed";
  } catch (error) {
    await ref.set({
      status: "failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      completedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    await database.doc(`slackApprovalTickets/${String(data.ticketId)}`).set({
      status: "failed", updatedAt: Timestamp.now(),
    }, { merge: true });
    throw error;
  }
}
