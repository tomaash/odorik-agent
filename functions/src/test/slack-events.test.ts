import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  parseSlackDmEvent,
  queueSlackDmEvent,
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
  assert.equal(memory.read(`slackEventDeliveries/${sha256Hex(event.eventId)}`)?.status, "queued");
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
