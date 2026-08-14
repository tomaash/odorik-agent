import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import {
  bindSlackApprovalTicketMessage,
  issueSlackApprovalTicket,
  parseSlackInteraction,
  processSlackApprovalInteraction,
  queueSlackApprovalInteraction,
  slackTaskApproveActionId,
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

test("Slack proposal cards disclose the exact task and use one structured decision", () => {
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
  assert.equal(memory.read(`slackApprovalInteractions/${queued.interactionId}`)?.messageUpdateStatus, "failed");
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
