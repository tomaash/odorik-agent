import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import {
  drainMicrosoftTeamsConversation,
  microsoftTeamsConversationId,
  microsoftTeamsEventPath,
  parseMicrosoftTeamsPersonalMessage,
  queueMicrosoftTeamsMessage,
  recordMicrosoftTeamsInstallationUpdate,
} from "../chat/microsoft-teams-events.js";
import { assertMicrosoftTeamsServiceUrl } from "../chat/microsoft-teams-bot.js";
import {
  bindMicrosoftTeamsApprovalTicket,
  issueMicrosoftTeamsApprovalTicket,
  microsoftTeamsProposalCard,
  queueMicrosoftTeamsDecision,
} from "../chat/microsoft-teams-interactions.js";
import {
  consumeMicrosoftTeamsLink,
  createMicrosoftTeamsLink,
  inspectMicrosoftTeamsLink,
  microsoftTeamsGlobalIdentityPath,
} from "../chat/microsoft-teams-link.js";
import {
  enableMicrosoftTeamsInstallation,
  microsoftTeamsConnectionId,
  microsoftTeamsTenantPath,
} from "../connectors/microsoft-teams.js";
import { MemoryFirestore } from "./firestore-harness.js";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channelId: "msteams",
    id: "activity-1",
    timestamp: "2026-08-18T12:00:00.000Z",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    text: "  Hello <at>Agent Erik</at>  ",
    from: { id: "teams-user-1", aadObjectId: "entra-user-1" },
    conversation: { id: "conversation-1", conversationType: "personal", tenantId: "tenant-1" },
    channelData: { tenant: { id: "tenant-1" } },
    ...overrides,
  };
}

test("Teams ingress accepts only complete personal messages and trusted service URLs", () => {
  assert.deepEqual(parseMicrosoftTeamsPersonalMessage(activity()), {
    activityId: "activity-1",
    tenantId: "tenant-1",
    entraObjectId: "entra-user-1",
    teamsUserId: "teams-user-1",
    conversationId: "conversation-1",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    text: "Hello",
    timestamp: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(parseMicrosoftTeamsPersonalMessage(activity({
    conversation: { id: "channel", conversationType: "channel", tenantId: "tenant-1" },
  })), null);
  assert.throws(() => parseMicrosoftTeamsPersonalMessage(activity({
    serviceUrl: "https://attacker.example/steal",
  })), /Untrusted Teams service URL/);
  assert.doesNotThrow(() => assertMicrosoftTeamsServiceUrl("https://smba.trafficmanager.net/amer/"));
  assert.throws(() => assertMicrosoftTeamsServiceUrl("http://smba.trafficmanager.net/amer/"));
  assert.equal(parseMicrosoftTeamsPersonalMessage(activity({
    from: { id: "consumer-user-1" },
  }))?.entraObjectId, "consumer-user-1");
});

test("Teams activity IDs are journaled exactly once per personal conversation", async () => {
  const memory = new MemoryFirestore();
  const event = parseMicrosoftTeamsPersonalMessage(activity())!;
  assert.equal(await queueMicrosoftTeamsMessage({ event, database: memory.asFirestore() }), "queued");
  assert.equal(await queueMicrosoftTeamsMessage({ event, database: memory.asFirestore() }), "duplicate");
  assert.equal(memory.read(microsoftTeamsEventPath(event))?.status, "queued");
  assert.equal(microsoftTeamsConversationId(event).length, 48);
});

test("Teams personal messages drain in provider timestamp order", async () => {
  const memory = new MemoryFirestore();
  memory.seed("microsoftTeamsTenants/0a96abb33b07ff0e8f48bcc4893e0e7346bff899dd316979517fa06509a49aff", {
    companyId: "acme", connectionId: "teams-1", status: "active",
  });
  memory.seed("companies/acme/connections/teams-1", { connectorId: "microsoft_teams", status: "active" });
  memory.seed("companies/acme/connections/teams-1/capabilities/chat_direct", { status: "active" });
  memory.seed("companies/acme/connections/teams-1/teamsUsers/entra-user-1", {
    uid: "member-1", status: "active",
  });
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  const later = parseMicrosoftTeamsPersonalMessage(activity({
    id: "later", text: "Thanks", timestamp: "2026-08-18T12:00:02.000Z",
  }))!;
  const earlier = parseMicrosoftTeamsPersonalMessage(activity({
    id: "earlier", text: "hello", timestamp: "2026-08-18T12:00:01.000Z",
  }))!;
  await queueMicrosoftTeamsMessage({ event: later, database: memory.asFirestore() });
  await queueMicrosoftTeamsMessage({ event: earlier, database: memory.asFirestore() });
  const delivered: string[] = [];
  const result = await drainMicrosoftTeamsConversation({
    conversationId: microsoftTeamsConversationId(earlier), credentialKey: "unused",
    geminiApiKey: "unused", appOrigin: "https://erik.example",
    clientId: "bot", clientSecret: "secret", tenantId: "tenant-1",
    database: memory.asFirestore(),
    dependencies: {
      wait: async () => undefined,
      persistInbound: async () => undefined,
      persistReply: async (input) => ({ runId: `run-${input.idempotencyKey}`, messageId: `reply-${input.idempotencyKey}` }),
      send: async (input) => { delivered.push(input.text); return { activityId: `sent-${delivered.length}` }; },
    },
  });
  assert.deepEqual(result, { acquired: true, processed: 2 });
  assert.match(delivered[0] || "", /^Hello!/);
  assert.match(delivered[1] || "", /^You’re welcome\./);
  assert.match(delivered[1] || "", /\[Continue this conversation in Agent Erik\]\(https:\/\/erik\.example\/ask\?thread=teams_/);
});

test("one verified tenant owns one separate Teams installation", async () => {
  const memory = new MemoryFirestore();
  memory.seed("companies/acme/connections/ms-1", {
    connectorId: "microsoft_365", status: "active", tenantId: "tenant-1", accountLabel: "owner@acme.test",
  });
  const enabled = await enableMicrosoftTeamsInstallation({
    companyId: "acme", microsoftConnectionId: "ms-1", actorUid: "admin",
    appId: "app-1", database: memory.asFirestore(),
  });
  assert.match(enabled.connectionId, /^teams_/);
  assert.equal(enabled.installUrl, "https://teams.microsoft.com/l/app/app-1");
  assert.equal(memory.read(`companies/acme/connections/${enabled.connectionId}`)?.connectorId, "microsoft_teams");
  memory.seed("companies/other/connections/ms-2", {
    connectorId: "microsoft_365", status: "active", tenantId: "tenant-1", accountLabel: "other@test",
  });
  await assert.rejects(enableMicrosoftTeamsInstallation({
    companyId: "other", microsoftConnectionId: "ms-2", actorUid: "admin",
    database: memory.asFirestore(),
  }), /already connected/);
  memory.seed("companies/consumer/connections/ms-personal", {
    connectorId: "microsoft_365", status: "active",
    tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad", accountLabel: "personal@example.test",
  });
  const consumer = await enableMicrosoftTeamsInstallation({
    companyId: "consumer", microsoftConnectionId: "ms-personal", actorUid: "admin",
    database: memory.asFirestore(),
  });
  assert.equal(consumer.tenantId, "9188040d-6c67-4c5b-b112-36a304b66dad");
  const consumerConnection = memory.read(
    `companies/consumer/connections/${consumer.connectionId}`,
  ) as { installation?: { routingMode?: string } } | undefined;
  assert.equal(consumerConnection?.installation?.routingMode, "linked_identity");
});

test("Teams identity links are short lived and single use", async () => {
  const memory = new MemoryFirestore();
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  memory.seed("companies/acme/connections/teams-1", {
    connectorId: "microsoft_teams", status: "active", tenantId: "tenant-1",
  });
  memory.seed("companies/acme/connections/teams-1/capabilities/chat_direct", { status: "active" });
  const link = await createMicrosoftTeamsLink({
    companyId: "acme", connectionId: "teams-1", tenantId: "tenant-1",
    teamsUserId: "teams-user-1", entraObjectId: "entra-user-1",
    appOrigin: "https://erik.example", database: memory.asFirestore(),
  });
  assert.equal(new URL(link.url).pathname, "/teams/link");
  assert.equal((await inspectMicrosoftTeamsLink({ token: link.token, companyId: "acme",
    database: memory.asFirestore() })).entraObjectId, "entra-user-1");
  assert.deepEqual(await consumeMicrosoftTeamsLink({ token: link.token, companyId: "acme",
    uid: "member-1", database: memory.asFirestore() }), {
    connectionId: "teams-1", entraObjectId: "entra-user-1",
  });
  assert.equal(memory.read(microsoftTeamsGlobalIdentityPath({
    tenantId: "tenant-1", entraObjectId: "entra-user-1", teamsUserId: "teams-user-1",
  }))?.uid, "member-1");
  await assert.rejects(inspectMicrosoftTeamsLink({ token: link.token, companyId: "acme",
    database: memory.asFirestore() }), /invalid or expired/);
});

test("a consumer Teams identity links without claiming Microsoft's shared tenant", async () => {
  const memory = new MemoryFirestore();
  const tenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const connectionId = microsoftTeamsConnectionId(tenantId);
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  memory.seed(`companies/acme/connections/${connectionId}`, {
    connectorId: "microsoft_teams", status: "active", tenantId,
  });
  memory.seed(`companies/acme/connections/${connectionId}/capabilities/chat_direct`, { status: "active" });
  const link = await createMicrosoftTeamsLink({
    tenantId, teamsUserId: "consumer-user-1", entraObjectId: "consumer-user-1",
    appOrigin: "https://erik.example", database: memory.asFirestore(),
  });
  assert.equal((await inspectMicrosoftTeamsLink({
    token: link.token, companyId: "acme", database: memory.asFirestore(),
  })).entraObjectId, "consumer-user-1");
  assert.deepEqual(await consumeMicrosoftTeamsLink({
    token: link.token, companyId: "acme", uid: "member-1", database: memory.asFirestore(),
  }), { connectionId, entraObjectId: "consumer-user-1" });
  assert.equal(memory.read(microsoftTeamsTenantPath(tenantId)), undefined);
});

test("a verified personal uninstall revokes that linked Teams identity", async () => {
  const memory = new MemoryFirestore();
  memory.seed("microsoftTeamsTenants/0a96abb33b07ff0e8f48bcc4893e0e7346bff899dd316979517fa06509a49aff", {
    companyId: "acme", connectionId: "teams-1", status: "active",
  });
  memory.seed("companies/acme/connections/teams-1", {
    connectorId: "microsoft_teams", status: "active",
  });
  memory.seed("companies/acme/connections/teams-1/capabilities/chat_direct", { status: "active" });
  memory.seed("companies/acme/connections/teams-1/teamsUsers/entra-user-1", {
    uid: "member-1", status: "active",
  });
  assert.equal(await recordMicrosoftTeamsInstallationUpdate({
    activity: activity({ type: "installationUpdate", action: "remove" }),
    installed: false,
    database: memory.asFirestore(),
  }), "recorded");
  assert.equal(memory.read("companies/acme/connections/teams-1/teamsUsers/entra-user-1")?.status,
    "installation_revoked");
});

test("Adaptive Card decisions bind tenant, Entra identity, conversation, activity, and approval", async () => {
  const memory = new MemoryFirestore();
  const policy = {
    version: "conversation-action-policy-v1", riskTier: "internal_write",
    approvalMode: "named_person_each_version", surface: "teams_personal",
    allowedDecisions: ["approve", "reject", "request_changes"],
    effectBoundary: "Creates exactly one internal task and performs no external communication.",
  };
  memory.seed("companies/acme/connections/teams-1", { connectorId: "microsoft_teams", status: "active" });
  memory.seed("companies/acme/connections/teams-1/capabilities/chat_direct", { status: "active" });
  memory.seed("companies/acme/connections/teams-1/teamsUsers/entra-user-1", { uid: "member-1", status: "active" });
  memory.seed(microsoftTeamsGlobalIdentityPath({
    tenantId: "tenant-1", entraObjectId: "entra-user-1", teamsUserId: "teams-user-1",
  }), {
    companyId: "acme", connectionId: "teams-1", tenantId: "tenant-1",
    entraObjectId: "entra-user-1", teamsUserId: "teams-user-1", uid: "member-1", status: "active",
  });
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  memory.seed("companies/acme/actionApprovals/approval-1", {
    objectType: "action_approval", decisionStatus: "pending", executionStatus: "not_started",
    effectDigest: "digest-1", approverUid: "member-1", action: { kind: "task.create" }, policy,
  });
  const ticket = await issueMicrosoftTeamsApprovalTicket({
    credentialKey: "credential-key", companyId: "acme", connectionId: "teams-1",
    tenantId: "tenant-1", entraObjectId: "entra-user-1", teamsUserId: "teams-user-1",
    uid: "member-1", conversationId: "conversation-1",
    serviceUrl: "https://smba.trafficmanager.net/emea/", approvalId: "approval-1",
    effectDigest: "digest-1", actionKind: "task.create", database: memory.asFirestore(),
  });
  await bindMicrosoftTeamsApprovalTicket({ ticketId: ticket.ticketId,
    activityId: "proposal-activity-1", database: memory.asFirestore() });
  const invoke = {
    ...activity({ type: "invoke", name: "adaptiveCard/action", replyToId: "proposal-activity-1" }),
    value: { action: { verb: "erik_proposal_approve_v1", data: {
      action: "erik_proposal_approve_v1", token: ticket.token,
    } } },
  };
  assert.equal((await queueMicrosoftTeamsDecision({ activity: invoke, database: memory.asFirestore() })).status, "queued");
  assert.equal((await queueMicrosoftTeamsDecision({ activity: invoke, database: memory.asFirestore() })).status, "duplicate");
  memory.seed("companies/acme/actionApprovals/approval-1", {
    objectType: "action_approval", decisionStatus: "pending", executionStatus: "not_started",
    effectDigest: "tampered-digest", approverUid: "member-1", action: { kind: "task.create" }, policy,
  });
  await assert.rejects(queueMicrosoftTeamsDecision({
    activity: invoke, database: memory.asFirestore(),
  }), /no longer approvable/);
  memory.seed("companies/acme/actionApprovals/approval-1", {
    objectType: "action_approval", decisionStatus: "rejected", executionStatus: "not_started",
    effectDigest: "digest-1", approverUid: "member-1", action: { kind: "task.create" }, policy,
  });
  assert.equal((await queueMicrosoftTeamsDecision({
    activity: invoke, database: memory.asFirestore(),
  })).status, "resolved");

  memory.seed("companies/acme/actionApprovals/approval-2", {
    objectType: "action_approval", decisionStatus: "pending", executionStatus: "not_started",
    effectDigest: "digest-2", approverUid: "member-1", action: { kind: "task.create" }, policy,
  });
  const second = await issueMicrosoftTeamsApprovalTicket({
    credentialKey: "credential-key", companyId: "acme", connectionId: "teams-1",
    tenantId: "tenant-1", entraObjectId: "entra-user-1", teamsUserId: "teams-user-1",
    uid: "member-1", conversationId: "conversation-1",
    serviceUrl: "https://smba.trafficmanager.net/emea/", approvalId: "approval-2",
    effectDigest: "digest-2", actionKind: "task.create", database: memory.asFirestore(),
  });
  await bindMicrosoftTeamsApprovalTicket({ ticketId: second.ticketId,
    activityId: "proposal-activity-2", database: memory.asFirestore() });
  memory.seed("companies/acme/connections/teams-1/teamsUsers/entra-user-1", {
    uid: "member-1", status: "revoked",
  });
  memory.seed(microsoftTeamsGlobalIdentityPath({
    tenantId: "tenant-1", entraObjectId: "entra-user-1", teamsUserId: "teams-user-1",
  }), {
    companyId: "acme", connectionId: "teams-1", tenantId: "tenant-1",
    entraObjectId: "entra-user-1", teamsUserId: "teams-user-1", uid: "member-1", status: "revoked",
  });
  await assert.rejects(queueMicrosoftTeamsDecision({ activity: {
    ...invoke,
    replyToId: "proposal-activity-2",
    value: { action: { verb: "erik_proposal_approve_v1", data: {
      action: "erik_proposal_approve_v1", token: second.token,
    } } },
  }, database: memory.asFirestore() }), /no longer approvable/);
  assert.ok(second.token);
  assert.ok(microsoftTeamsProposalCard({
    proposed: { approvalId: "approval-2", action: { kind: "task.create", title: "Follow up" }, citations: [], assumptions: [] },
    effectDigest: "digest-2", ticketToken: second.token,
    approvalUrl: "https://erik.example/approvals/approval-2",
  }).actions.every((action) => action.type === "Action.Execute"));
  assert.ok(Timestamp.now());
});
