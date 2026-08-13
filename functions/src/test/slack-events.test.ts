import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  drainSlackConversation,
  parseSlackDmEvent,
  queueSlackDmEvent,
  routeSlackTurn,
  slackConversationEventPath,
  slackConversationId,
  SlackEventRequestError,
  verifySlackRequestSignature,
} from "../chat/slack-events.js";
import { consumeSlackLink, createSlackLink, inspectSlackLink } from "../chat/slack-link.js";
import { sha256Hex } from "../hash.js";
import { MemoryFirestore } from "./firestore-harness.js";

test("Slack signatures bind the timestamp and exact raw request body", () => {
  const rawBody = Buffer.from('{"type":"url_verification","challenge":"hello"}');
  const timestamp = "1770000000";
  const secret = "signing-secret";
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody.toString("utf8")}`)
    .digest("hex")}`;
  assert.doesNotThrow(() => verifySlackRequestSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret: secret,
    nowMs: Number(timestamp) * 1000,
  }));
  assert.throws(() => verifySlackRequestSignature({
    rawBody: Buffer.from(`${rawBody.toString("utf8")} `),
    timestamp,
    signature,
    signingSecret: secret,
    nowMs: Number(timestamp) * 1000,
  }), SlackEventRequestError);
  assert.throws(() => verifySlackRequestSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret: secret,
    nowMs: Number(timestamp) * 1000 + 301_000,
  }), /Stale Slack request/);
});

test("only human direct messages enter the Slack assistant queue", () => {
  const direct = parseSlackDmEvent({
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      text: "  What changed?  ",
      ts: "1.001",
    },
  });
  assert.deepEqual(direct, {
    eventId: "Ev1",
    teamId: "T1",
    slackUserId: "U1",
    channelId: "D1",
    text: "What changed?",
    eventTs: "1.001",
  });
  assert.equal(parseSlackDmEvent({
    type: "event_callback",
    event_id: "Ev2",
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "channel",
      channel: "C1",
      user: "U1",
      text: "not a DM",
      ts: "1.002",
    },
  }), null);
  assert.equal(parseSlackDmEvent({
    type: "event_callback",
    event_id: "Ev3",
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      text: "bot echo",
      ts: "1.003",
      bot_id: "B1",
    },
  }), null);
});

test("Slack event IDs are queued exactly once", async () => {
  const memory = new MemoryFirestore();
  const event = {
    eventId: "Ev-dedupe",
    teamId: "T1",
    slackUserId: "U1",
    channelId: "D1",
    text: "hello",
    eventTs: "1.001",
  };
  assert.equal(await queueSlackDmEvent({ event, database: memory.asFirestore() }), "queued");
  assert.equal(await queueSlackDmEvent({ event, database: memory.asFirestore() }), "duplicate");
  assert.equal(memory.read(slackConversationEventPath(event))?.status, "queued");
});

test("the turn router keeps social and capability messages out of factual retrieval", () => {
  assert.equal(routeSlackTurn("hello", true), "social");
  assert.equal(routeSlackTurn("Thanks!", true), "social");
  assert.equal(routeSlackTurn("What can you do?", true), "capability");
  assert.equal(routeSlackTurn("Could you create a task for me?", true), "action_request");
  assert.equal(routeSlackTurn("Hello, could you send an email?", true), "action_request");
  assert.equal(routeSlackTurn("Update me on open tasks", true), "company_fact");
  assert.equal(routeSlackTurn("Make sense of the latest call", true), "company_fact");
  assert.equal(routeSlackTurn("Summarize Acme", false), "company_fact");
  assert.equal(routeSlackTurn("What about its open cases?", true), "contextual_followup");
});

function seedLinkedSlackMember(memory: MemoryFirestore) {
  memory.seed("slackWorkspaces/T1", {
    teamId: "T1",
    companyId: "acme",
    connectionId: "slack-1",
    status: "active",
  });
  memory.seed("companies/acme/connections/slack-1/slackUsers/U1", {
    uid: "member-1",
    status: "active",
  });
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
}

test("one conversation drains rapid out-of-order messages causally without company tools", async () => {
  const memory = new MemoryFirestore();
  seedLinkedSlackMember(memory);
  const later = {
    eventId: "Ev-later", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "Thanks", eventTs: "2.002",
  };
  const earlier = {
    eventId: "Ev-earlier", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "hello", eventTs: "2.001",
  };
  await queueSlackDmEvent({ event: later, database: memory.asFirestore() });
  await queueSlackDmEvent({ event: earlier, database: memory.asFirestore() });
  const posted: string[] = [];
  let factualCalls = 0;
  const result = await drainSlackConversation({
    conversationId: slackConversationId(earlier),
    credentialKey: "unused",
    geminiApiKey: "unused",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies: {
      wait: async () => undefined,
      authorize: async () => ({ botToken: "token", teamId: "T1", botUserId: "B1" }),
      ask: async () => {
        factualCalls += 1;
        throw new Error("social turns must not call the factual agent");
      },
      persistInbound: async () => undefined,
      persistReply: async (input) => ({ runId: `run-${input.idempotencyKey}`, messageId: "m" }),
      post: async (input) => {
        posted.push(input.text);
        return { channelId: input.channelId, messageTs: String(posted.length) };
      },
    },
  });
  assert.deepEqual(result, { acquired: true, processed: 2 });
  assert.equal(factualCalls, 0);
  assert.match(posted[0] || "", /^Hello!/);
  assert.equal(posted[1], "You’re welcome.");
  assert.equal(memory.read(slackConversationEventPath(earlier))?.status, "processed");
  assert.equal(memory.read(slackConversationEventPath(later))?.status, "processed");
});

test("a factual answer followed by hello retrieves once and never repeats the answer", async () => {
  const memory = new MemoryFirestore();
  seedLinkedSlackMember(memory);
  const fact = {
    eventId: "Ev-fact", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "Summarize Acme", eventTs: "4.001",
  };
  const hello = {
    eventId: "Ev-hello", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "hello", eventTs: "4.002",
  };
  await queueSlackDmEvent({ event: fact, database: memory.asFirestore() });
  await queueSlackDmEvent({ event: hello, database: memory.asFirestore() });
  const posted: string[] = [];
  let factualCalls = 0;
  await drainSlackConversation({
    conversationId: slackConversationId(fact),
    credentialKey: "unused",
    geminiApiKey: "unused",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies: {
      wait: async () => undefined,
      authorize: async () => ({ botToken: "token", teamId: "T1", botUserId: "B1" }),
      persistInbound: async () => undefined,
      persistReply: async () => ({ runId: "social-run", messageId: "social-message" }),
      ask: async () => {
        factualCalls += 1;
        return {
          answer: "Acme summary [C1]",
          citations: [{
            citationId: "C1", kind: "context_item", recordId: "r1", title: "Acme",
            sourcePath: "companies/acme/contextItems/r1", excerpt: "Acme summary",
            occurredAt: null,
          }],
          confidence: "high" as const,
          limitations: [],
          toolTrace: [{ name: "search_company_data", args: {}, citationIds: ["C1"] }],
          usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0, totalTokens: 2 },
          runId: "fact-run",
          messageId: "fact-message",
        };
      },
      post: async (input) => {
        posted.push(input.text);
        return { channelId: input.channelId, messageTs: String(posted.length) };
      },
    },
  });
  assert.equal(factualCalls, 1);
  assert.match(posted[0] || "", /Acme summary/);
  assert.match(posted[1] || "", /^Hello!/);
  assert.doesNotMatch(posted[1] || "", /Acme summary/);
});

test("a late event is retained and flagged without moving the committed cursor backward", async () => {
  const memory = new MemoryFirestore();
  seedLinkedSlackMember(memory);
  const current = {
    eventId: "Ev-current", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "hello", eventTs: "6.002",
  };
  await queueSlackDmEvent({ event: current, database: memory.asFirestore() });
  const dependencies = {
    wait: async () => undefined,
    authorize: async () => ({ botToken: "token", teamId: "T1", botUserId: "B1" }),
    persistInbound: async () => undefined,
    persistReply: async () => ({ runId: "run", messageId: "message" }),
    post: async (input: { channelId: string }) => ({ channelId: input.channelId, messageTs: "1" }),
  };
  await drainSlackConversation({
    conversationId: slackConversationId(current), credentialKey: "unused",
    geminiApiKey: "unused", appOrigin: "https://example.test",
    database: memory.asFirestore(), dependencies,
  });
  const conversationPath = `slackConversations/${slackConversationId(current)}`;
  const committed = String(memory.read(conversationPath)?.lastCommittedOrderKey || "");
  const late = { ...current, eventId: "Ev-late", text: "thanks", eventTs: "6.001" };
  await queueSlackDmEvent({ event: late, database: memory.asFirestore() });
  await drainSlackConversation({
    conversationId: slackConversationId(late), credentialKey: "unused",
    geminiApiKey: "unused", appOrigin: "https://example.test",
    database: memory.asFirestore(), dependencies,
  });
  assert.equal(memory.read(slackConversationEventPath(late))?.lateArrival, true);
  assert.equal(memory.read(conversationPath)?.lastCommittedOrderKey, committed);
});

test("a safe Slack retry reuses the persisted reply and never regenerates it", async () => {
  const memory = new MemoryFirestore();
  seedLinkedSlackMember(memory);
  const event = {
    eventId: "Ev-retry", teamId: "T1", slackUserId: "U1", channelId: "D1",
    text: "hello", eventTs: "3.001",
  };
  await queueSlackDmEvent({ event, database: memory.asFirestore() });
  let persistCalls = 0;
  let postCalls = 0;
  const dependencies = {
    wait: async () => undefined,
    authorize: async () => ({ botToken: "token", teamId: "T1", botUserId: "B1" }),
    persistInbound: async () => undefined,
    persistReply: async () => {
      persistCalls += 1;
      return { runId: "run-1", messageId: "m-1" };
    },
    post: async (input: { channelId: string }) => {
      postCalls += 1;
      if (postCalls === 1) {
        const { SlackApiError } = await import("../chat/slack.js");
        throw new SlackApiError({ label: "post", status: 500, slackError: "server_error" });
      }
      return { channelId: input.channelId, messageTs: "3.100" };
    },
  };
  await assert.rejects(() => drainSlackConversation({
    conversationId: slackConversationId(event),
    credentialKey: "unused",
    geminiApiKey: "unused",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies,
  }), /server_error/);
  assert.equal(memory.read(slackConversationEventPath(event))?.status, "failed_safe_to_retry");
  const retry = await drainSlackConversation({
    conversationId: slackConversationId(event),
    credentialKey: "unused",
    geminiApiKey: "unused",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
    dependencies,
  });
  assert.deepEqual(retry, { acquired: true, processed: 1 });
  assert.equal(persistCalls, 1, "the reply is persisted once before delivery");
  assert.equal(postCalls, 2);
  assert.equal(memory.read(slackConversationEventPath(event))?.status, "processed");
});

test("a short-lived Slack bearer link binds one Slack identity to an active member", async () => {
  const memory = new MemoryFirestore();
  memory.seed("companies/acme/memberships/member-1", { status: "active" });
  const link = await createSlackLink({
    companyId: "acme",
    connectionId: "slack-1",
    teamId: "T1",
    slackUserId: "U1",
    appOrigin: "https://example.test",
    database: memory.asFirestore(),
  });
  assert.equal(new URL(link.url).pathname, "/slack/link");
  assert.equal(new URL(link.url).searchParams.get("token"), link.token);
  const preview = await inspectSlackLink({
    token: link.token,
    companyId: "acme",
    database: memory.asFirestore(),
  });
  assert.equal(preview.slackUserId, "U1");
  assert.deepEqual(await consumeSlackLink({
    token: link.token,
    companyId: "acme",
    uid: "member-1",
    database: memory.asFirestore(),
  }), { connectionId: "slack-1", slackUserId: "U1" });
  assert.equal(
    memory.read("companies/acme/connections/slack-1/slackUsers/U1")?.uid,
    "member-1",
  );
  await assert.rejects(() => consumeSlackLink({
    token: link.token,
    companyId: "acme",
    uid: "member-1",
    database: memory.asFirestore(),
  }), /invalid or expired/);
});
