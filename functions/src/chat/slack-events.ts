import { createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { askCompanyFactAgent } from "../agent/service.js";
import { authorizedSlackDirect } from "../connectors/slack-oauth.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { createSlackLink, slackIdentityPath } from "./slack-link.js";
import { postSlackText } from "./slack.js";

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
  if (!eventId || !teamId || !slackUserId || !channelId || !text || !eventTs) return null;
  return { eventId, teamId, slackUserId, channelId, text: text.slice(0, 3000), eventTs };
}

export async function queueSlackDmEvent(input: {
  event: QueuedSlackDmEvent;
  database?: FirebaseFirestore.Firestore;
}): Promise<"queued" | "duplicate"> {
  const database = input.database || db;
  const ref = database.doc(`slackEventDeliveries/${sha256Hex(input.event.eventId)}`);
  return database.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) return "duplicate";
    transaction.create(ref, {
      ...input.event,
      status: "queued",
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

function slackAnswerText(answer: Awaited<ReturnType<typeof askCompanyFactAgent>>): string {
  const citations = answer.citations
    .filter((citation) => citation.externalUrl || citation.internalRoute)
    .slice(0, 8)
    .map((citation) => {
      const url = citation.externalUrl || citation.internalRoute;
      return `<${url}|${citation.citationId}: ${citation.title}>`;
    });
  return [answer.answer, citations.length ? `\nSources:\n${citations.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 39_000);
}

export async function processSlackDmEvent(input: {
  event: QueuedSlackDmEvent;
  credentialKey: string;
  geminiApiKey: string;
  appOrigin: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<"answered" | "link_requested" | "ignored"> {
  const database = input.database || db;
  const workspace = await resolveSlackWorkspace(input.event.teamId, database);
  if (!workspace) return "ignored";
  const authorization = await authorizedSlackDirect({
    ...workspace,
    credentialKey: input.credentialKey,
    database,
  });
  if (authorization.botUserId && authorization.botUserId === input.event.slackUserId) return "ignored";
  const identity = await database.doc(slackIdentityPath({
    ...workspace,
    slackUserId: input.event.slackUserId,
  })).get();
  const uid = identity.data()?.status === "active" ? String(identity.data()?.uid || "") : "";
  const membership = uid
    ? await database.doc(`companies/${workspace.companyId}/memberships/${uid}`).get()
    : null;
  if (!uid || !membership?.exists || membership.data()?.status !== "active") {
    const link = await createSlackLink({
      ...workspace,
      teamId: input.event.teamId,
      slackUserId: input.event.slackUserId,
      appOrigin: input.appOrigin,
      database,
    });
    await postSlackText({
      token: authorization.botToken,
      channelId: input.event.channelId,
      text: `To protect company data, link this Slack account to your Agent Erik account first:\n${link.url}\n\nThe link expires in 15 minutes.`,
      clientMessageId: input.event.eventId,
    });
    return "link_requested";
  }
  const threadId = `slack_${sha256Hex(`${input.event.teamId}:${input.event.channelId}:${uid}`).slice(0, 40)}`;
  const answer = await askCompanyFactAgent({
    companyId: workspace.companyId,
    actorUid: uid,
    threadId,
    question: input.event.text,
    geminiApiKey: input.geminiApiKey,
    origin: "slack_dm",
    originMetadata: {
      teamId: input.event.teamId,
      slackUserId: input.event.slackUserId,
      channelId: input.event.channelId,
      eventId: input.event.eventId,
      eventTs: input.event.eventTs,
    },
    database,
  });
  await postSlackText({
    token: authorization.botToken,
    channelId: input.event.channelId,
    text: slackAnswerText(answer),
    clientMessageId: input.event.eventId,
  });
  return "answered";
}

export async function markSlackEventAttempt(
  ref: FirebaseFirestore.DocumentReference,
): Promise<void> {
  await ref.set({
    attempts: FieldValue.increment(1),
    lastAttemptAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}
