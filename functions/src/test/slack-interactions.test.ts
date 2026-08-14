import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { memberThreadDocumentId } from "../agent/threads.js";
import { conversationApprovalPolicy } from "../actions/conversation-policy.js";

import {
  bindSlackApprovalTicketMessage,
  issueSlackApprovalTicket,
  mailDraftProposalBlocks,
  openSlackDecisionModal,
  parseSlackInteraction,
  processSlackApprovalInteraction,
  queueSlackApprovalInteraction,
  slackProposalDecisionModalCallbackId,
  slackProposalRejectActionId,
  slackProposalRequestChangesActionId,
  slackTaskApproveActionId,
  syncSlackApprovalOutcome,
  taskProposalBlocks,
} from "../chat/slack-interactions.js";
import { MemoryFirestore } from "./firestore-harness.js";

function seedApprovalSurface(memory: MemoryFirestore) {
  memory.seed("slackWorkspaces/T1", {
    status: "active", companyId: "acme", connectionId: "slack-1",
  });
  memory.seed("companies/acme/connections/slack-1", {
    connectorId: "slack", status: "active", credentialCiphertext: "ciphertext",
  });
  memory.seed("companies/acme/connections/slack-1/capabilities/chat_direct", {
    capabilityId: "context.chat.direct", status: "active",
  });
  memory.seed("companies/acme/connections/slack-1/slackUsers/U1", {
    uid: "member-1", status: "active",
  });
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  memory.seed("companies/acme/actionApprovals/approval-1", {
    objectType: "action_approval",
    status: "pending",
    decisionStatus: "pending",
    executionStatus: "not_started",
    approverUid: "member-1",
    effectDigest: "digest-1",
    action: { kind: "task.create" },
    policy: conversationApprovalPolicy("task.create"),
  });
}

async function issued(memory: MemoryFirestore) {
  const ticket = await issueSlackApprovalTicket({
    credentialKey: "credential-key",
    companyId: "acme",
    connectionId: "slack-1",
    teamId: "T1",
    slackUserId: "U1",
    uid: "member-1",
    channelId: "D1",
    approvalId: "approval-1",
    effectDigest: "digest-1",
    database: memory.asFirestore(),
  });
  await bindSlackApprovalTicketMessage({
    ticketId: ticket.ticketId,
    channelId: "D1",
    messageTs: "10.01",
    database: memory.asFirestore(),
  });
  return ticket;
}

function interaction(token: string, patch: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "D1" },
    container: { channel_id: "D1", message_ts: "10.01" },
    actions: [{ action_id: slackTaskApproveActionId, value: token, action_ts: "10.02" }],
    ...patch,
  };
}

test("Slack proposal cards disclose the exact effect and all three structured decisions", () => {
  const blocks = taskProposalBlocks({
    approvalId: "approval-1",
    title: "Call Acme back",
    assigneeName: "Tom",
    instructions: "Discuss the revised offer.",
    dueAt: null,
    evidenceTitles: ["Acme call"],
    assumptions: ["No due date was stated"],
    effectDigest: "0123456789abcdef",
    approvalUrl: "https://example.test/approvals/approval-1",
    ticketToken: "opaque-ticket",
  }) as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 4);
  assert.match(JSON.stringify(blocks), /Call Acme back/);
  assert.match(JSON.stringify(blocks), /Acme call/);
  const actions = blocks[3]?.elements as Array<Record<string, unknown>>;
  assert.equal(actions[0]?.action_id, slackTaskApproveActionId);
  assert.equal(actions[0]?.value, "opaque-ticket");
  assert.notEqual(actions[0]?.value, "approval-1");
  assert.ok(actions[0]?.confirm);
  assert.equal(actions[1]?.action_id, slackProposalRequestChangesActionId);
  assert.equal(actions[2]?.action_id, slackProposalRejectActionId);

  const mail = mailDraftProposalBlocks({
    approvalId: "mail-1",
    mailboxAddress: "tom@example.com",
    to: "buyer@example.test",
    subject: "Revised offer",
    body: "Hello,\n\nHere is the revised offer.",
    evidenceTitles: ["Buyer call"],
    assumptions: [],
    effectDigest: "fedcba9876543210",
    approvalUrl: "https://example.test/approvals/mail-1",
    ticketToken: "mail-ticket",
  });
  assert.match(JSON.stringify(mail), /never sends email/);
  assert.match(JSON.stringify(mail), /Approve and create draft/);
});

test("Slack interaction payload parsing accepts only one Block Kit action", () => {
  assert.deepEqual(parseSlackInteraction(JSON.stringify(interaction("token"))).type, "block_actions");
  assert.throws(() => parseSlackInteraction("not-json"), /Invalid/);
  assert.throws(() => parseSlackInteraction(JSON.stringify({ type: "view_submission" })), /Unsupported/);
});

test("an exact Slack approval ticket queues once and rejects identity or message tampering", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  const first = await queueSlackApprovalInteraction({
    payload: interaction(ticket.token), database: memory.asFirestore(),
  });
  assert.equal(first.status, "queued");
  const duplicate = await queueSlackApprovalInteraction({
    payload: interaction(ticket.token), database: memory.asFirestore(),
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(memory.list("slackApprovalInteractions").length, 1);

  const wrongUser = new MemoryFirestore();
  seedApprovalSurface(wrongUser);
  const wrongUserTicket = await issued(wrongUser);
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: interaction(wrongUserTicket.token, { user: { id: "U2" } }),
    database: wrongUser.asFirestore(),
  }), /invalid or expired/);

  const wrongMessage = new MemoryFirestore();
  seedApprovalSurface(wrongMessage);
  const wrongMessageTicket = await issued(wrongMessage);
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: interaction(wrongMessageTicket.token, {
      container: { channel_id: "D1", message_ts: "other" },
    }),
    database: wrongMessage.asFirestore(),
  }), /invalid or expired/);
});

test("Slack reject and request-changes buttons open typed modals", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  const opened: Array<Record<string, unknown>> = [];
  const status = await openSlackDecisionModal({
    payload: interaction(ticket.token, {
      trigger_id: "trigger-1",
      actions: [{ action_id: slackProposalRequestChangesActionId, value: ticket.token, action_ts: "10.02" }],
    }),
    credentialKey: "credential-key",
    database: memory.asFirestore(),
    dependencies: {
      authorize: async () => ({ botToken: "bot-token", teamId: "T1", botUserId: "B1" }),
      open: async (value) => { opened.push(value as unknown as Record<string, unknown>); },
    },
  });
  assert.equal(status.status, "opened");
  assert.equal(status.approvalId, "approval-1");
  const view = opened[0]?.view as { callback_id?: string; blocks?: Array<{ optional?: boolean }> };
  assert.equal(view.callback_id, slackProposalDecisionModalCallbackId);
  assert.equal(view.blocks?.[0]?.optional, false);

  const missingNote = parseSlackInteraction(JSON.stringify({
    type: "view_submission",
    team: { id: "T1" },
    user: { id: "U1" },
    view: {
      callback_id: slackProposalDecisionModalCallbackId,
      private_metadata: JSON.stringify({ token: ticket.token, decision: "request_changes" }),
      state: { values: {} },
    },
  }));
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: missingNote,
    database: memory.asFirestore(),
  }), /Describe the requested changes/);
});

test("an already-resolved exact proposal is an idempotent receipt and converges the Slack card", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  memory.patch("companies/acme/actionApprovals/approval-1", {
    status: "approved",
    decisionStatus: "approved",
    executionStatus: "succeeded",
    approvedBy: "member-1",
  });
  const result = await queueSlackApprovalInteraction({
    payload: interaction(ticket.token), database: memory.asFirestore(),
  });
  assert.equal(result.status, "resolved");
  assert.equal(memory.list("slackApprovalInteractions").length, 0);

  const updates: Array<Record<string, unknown>> = [];
  assert.deepEqual(await syncSlackApprovalOutcome({
    companyId: "acme",
    approvalId: "approval-1",
    credentialKey: "credential-key",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies: {
      authorize: async () => ({ botToken: "bot-token", teamId: "T1", botUserId: "B1" }),
      update: async (value) => { updates.push(value as unknown as Record<string, unknown>); },
    },
  }), { updated: 1 });
  assert.match(JSON.stringify(updates[0]), /executed exactly once/);
  assert.doesNotMatch(JSON.stringify(updates[0]), /<@member-1>/);
  assert.equal(memory.read(`slackApprovalTickets/${ticket.ticketId}`)?.surfaceStatus, "succeeded");
});

test("revoked identity and stale proposal digest fail before a decision is queued", async () => {
  const revoked = new MemoryFirestore();
  seedApprovalSurface(revoked);
  const revokedTicket = await issued(revoked);
  revoked.seed("companies/acme/connections/slack-1/slackUsers/U1", {
    uid: "member-1", status: "revoked",
  });
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: interaction(revokedTicket.token), database: revoked.asFirestore(),
  }), /no longer approvable/);

  const stale = new MemoryFirestore();
  seedApprovalSurface(stale);
  const staleTicket = await issued(stale);
  stale.seed("companies/acme/actionApprovals/approval-1", {
    objectType: "action_approval",
    status: "pending",
    decisionStatus: "pending",
    approverUid: "member-1",
    effectDigest: "changed",
    action: { kind: "task.create" },
  });
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: interaction(staleTicket.token), database: stale.asFirestore(),
  }), /no longer approvable/);
});

test("queued Slack approval invokes the canonical approval once and records message-update failure separately", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  const queued = await queueSlackApprovalInteraction({
    payload: interaction(ticket.token), database: memory.asFirestore(),
  });
  let approvals = 0;
  const dependencies = {
    approve: async () => {
      approvals += 1;
      memory.patch("companies/acme/actionApprovals/approval-1", {
        status: "approved", decisionStatus: "approved", executionStatus: "succeeded",
      });
      return { id: "approval-1", status: "approved", resultId: "task-1" } as never;
    },
    authorize: async () => ({ botToken: "token", teamId: "T1", botUserId: "B1" }),
    update: async () => { throw new Error("Slack unavailable"); },
  };
  assert.equal(await processSlackApprovalInteraction({
    interactionId: queued.interactionId,
    credentialKey: "credential-key",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies,
  }), "processed");
  assert.equal(await processSlackApprovalInteraction({
    interactionId: queued.interactionId,
    credentialKey: "credential-key",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies,
  }), "duplicate");
  assert.equal(approvals, 1);
  assert.equal(memory.read(`slackApprovalInteractions/${queued.interactionId}`)?.status, "succeeded");
  assert.equal(memory.read(`slackApprovalTickets/${ticket.ticketId}`)?.surfaceStatus, "failed");
  assert.match(String(memory.read(`slackApprovalTickets/${ticket.ticketId}`)?.surfaceError), /Slack unavailable/);
});

test("queued Slack rejection uses the canonical decision and replaces the card with a receipt", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  const payload = interaction(ticket.token, {
    type: "view_submission",
    channel: undefined,
    container: undefined,
    actions: undefined,
    view: {
      callback_id: slackProposalDecisionModalCallbackId,
      private_metadata: JSON.stringify({ token: ticket.token, decision: "reject" }),
      state: { values: { decision_note: { decision_note_input: { value: "Not needed" } } } },
    },
  });
  const queued = await queueSlackApprovalInteraction({ payload, database: memory.asFirestore() });
  let rejections = 0;
  const updates: Array<Record<string, unknown>> = [];
  assert.equal(await processSlackApprovalInteraction({
    interactionId: queued.interactionId,
    credentialKey: "credential-key",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies: {
      reject: async () => {
        rejections += 1;
        memory.patch("companies/acme/actionApprovals/approval-1", {
          status: "rejected", decisionStatus: "rejected", resolutionKind: "rejected", rejectionNote: "Not needed",
        });
        return { status: "rejected" };
      },
      authorize: async () => ({ botToken: "bot-token", teamId: "T1", botUserId: "B1" }),
      update: async (value) => { updates.push(value as unknown as Record<string, unknown>); },
    },
  }), "processed");
  assert.equal(rejections, 1);
  assert.match(JSON.stringify(updates[0]), /Proposal rejected/);
  assert.equal(memory.read(`slackApprovalTickets/${ticket.ticketId}`)?.surfaceStatus, "rejected");
});

test("request changes prepares and posts a fresh immutable proposal version", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  memory.patch("companies/acme/actionApprovals/approval-1", {
    source: {
      kind: "conversation",
      surface: "slack_dm",
      threadId: "slack-T1-U1",
      sessionId: "session-1",
      messageId: "message-1",
      proposalRootId: "approval-1",
      proposalVersion: 1,
    },
    proposalLineage: { rootApprovalId: "approval-1", version: 1, supersedesApprovalId: null },
  });
  const threadDocumentId = memberThreadDocumentId("member-1", "slack-T1-U1");
  const threadPath = `companies/acme/agentThreads/${threadDocumentId}`;
  memory.seed(`${threadPath}/sessions/session-1`, {
    ownerUid: "member-1",
    status: "active",
    memoryGeneration: 1,
    stateVersion: 0,
    state: { summary: "Nothing retained." },
  });
  memory.seed(`${threadPath}/messages/message-1`, {
    role: "user",
    text: "Create a task to call Acme back",
    sessionId: "session-1",
    memoryGeneration: 1,
    createdAt: Timestamp.now(),
  });
  const ticket = await issued(memory);
  const payload = interaction(ticket.token, {
    type: "view_submission",
    channel: undefined,
    container: undefined,
    actions: undefined,
    view: {
      callback_id: slackProposalDecisionModalCallbackId,
      private_metadata: JSON.stringify({ token: ticket.token, decision: "request_changes" }),
      state: { values: { decision_note: { decision_note_input: { value: "Assign it to Friday." } } } },
    },
  });
  const queued = await queueSlackApprovalInteraction({ payload, database: memory.asFirestore() });
  const revisionInputs: Array<Record<string, unknown>> = [];
  const posts: Array<Record<string, unknown>> = [];
  assert.equal(await processSlackApprovalInteraction({
    interactionId: queued.interactionId,
    credentialKey: "credential-key",
    geminiApiKey: "gemini-key",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies: {
      requestChanges: async () => {
        memory.patch("companies/acme/actionApprovals/approval-1", {
          status: "rejected",
          decisionStatus: "rejected",
          resolutionKind: "changes_requested",
          rejectionNote: "Assign it to Friday.",
        });
        return { status: "rejected" };
      },
      prepareTask: async (value) => {
        revisionInputs.push(value as unknown as Record<string, unknown>);
        return {
          approvalId: "approval-2",
          approval: { effectDigest: "digest-2" },
          action: {
            kind: "task.create",
            taskId: "task-2",
            title: "Call Acme back Friday",
            instructions: null,
            assigneeUid: "member-1",
            assigneeName: "Tom",
            dueAt: "2026-08-21T12:00:00.000Z",
            contactId: null,
            caseId: null,
            caseTitle: null,
            callId: "call-1",
            subject: { kind: "internal" },
            context: { callerName: "Acme", callerPhone: null, callSummary: null, transcriptExcerpt: null },
          },
          citations: [],
          assumptions: [],
          run: { usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 }, toolTrace: [] },
        } as never;
      },
      linkSuperseding: async () => undefined,
      authorize: async () => ({ botToken: "bot-token", teamId: "T1", botUserId: "B1" }),
      post: async (value) => {
        posts.push(value as unknown as Record<string, unknown>);
        return { channelId: "D1", messageTs: "20.01" };
      },
      bind: async () => undefined,
      update: async () => undefined,
    },
  }), "processed");
  assert.equal((revisionInputs[0]?.lineage as { version?: number }).version, 2);
  assert.equal((revisionInputs[0]?.lineage as { supersedesApprovalId?: string }).supersedesApprovalId, "approval-1");
  assert.match(String(revisionInputs[0]?.request), /Assign it to Friday/);
  assert.match(JSON.stringify(posts[0]), /Revised proposal version 2/);
  assert.match(JSON.stringify(posts[0]), /Version 2/);
  assert.equal(memory.read(`slackApprovalInteractions/${queued.interactionId}`)?.status, "succeeded");
});

test("expired tickets fail closed", async () => {
  const memory = new MemoryFirestore();
  seedApprovalSurface(memory);
  const ticket = await issued(memory);
  const ticketPath = `slackApprovalTickets/${ticket.ticketId}`;
  memory.seed(ticketPath, {
    ...memory.read(ticketPath),
    expiresAt: Timestamp.fromMillis(Date.now() - 1),
  });
  await assert.rejects(() => queueSlackApprovalInteraction({
    payload: interaction(ticket.token), database: memory.asFirestore(),
  }), /invalid or expired/);
});
