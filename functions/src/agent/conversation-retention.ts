import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";

import { db, jsonSafe } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { slackIdentityPath } from "../chat/slack-link.js";
import { microsoftTeamsGlobalIdentityPath } from "../chat/microsoft-teams-link.js";
import { memberThreadDocumentId } from "./threads.js";

export const conversationRetentionPolicyVersion = "conversation-retention-v1";
export const conversationContentRetentionDays = 30;
export const conversationContentRetentionMs = conversationContentRetentionDays * 24 * 60 * 60 * 1_000;

export type ConversationRedactionReason =
  | "retention_expired"
  | "member_forget"
  | "connector_deleted"
  | "installation_revoked";

export type ConversationDataInspection = {
  threadId: string;
  surface: string;
  retentionDays: number;
  retentionPolicyVersion: string;
  memoryGeneration: number;
  activeSessionId: string | null;
  retainedMessages: number;
  redactedMessages: number;
  retainedSessions: number;
  forgottenBefore: string | null;
  contentExpiresAt: string | null;
  contentRedactedAt: string | null;
};

type ConversationContentKind =
  | "event"
  | "message"
  | "session"
  | "run"
  | "thread"
  | "external_conversation";

const redactedMessageFields = ["text", "citations", "limitations", "originMetadata"];
const redactedSessionFields = ["state"];
const redactedRunFields = [
  "question",
  "answer",
  "citations",
  "limitations",
  "toolTrace",
  "originMetadata",
  "contextUsed",
  "proposal",
];
const redactedEventFields = [
  "text",
  "replyText",
  "replyBlocks",
  "replyCard",
  "serviceUrl",
  "lastError",
  "eventId",
  "teamId",
  "slackUserId",
  "channelId",
  "eventTs",
  "activityId",
  "tenantId",
  "entraObjectId",
  "teamsUserId",
  "conversationId",
  "timestamp",
];
const redactedExternalConversationFields = [
  "teamId",
  "slackUserId",
  "channelId",
  "tenantId",
  "entraObjectId",
  "teamsUserId",
  "providerConversationId",
  "serviceUrl",
];

function timestampMillis(value: unknown): number {
  if (value && typeof value === "object"
    && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis(): number }).toMillis();
  }
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function conversationRetentionMetadata(activityAtMs = Date.now()) {
  return {
    retentionPolicyVersion: conversationRetentionPolicyVersion,
    contentExpiresAt: Timestamp.fromMillis(activityAtMs + conversationContentRetentionMs),
    contentRedacted: false,
  };
}

function contentFields(kind: ConversationContentKind): string[] {
  if (kind === "event") return redactedEventFields;
  if (kind === "message") return redactedMessageFields;
  if (kind === "session") return redactedSessionFields;
  if (kind === "run") return redactedRunFields;
  if (kind === "external_conversation") return redactedExternalConversationFields;
  return ["title"];
}

function redactionPatch(
  kind: ConversationContentKind,
  reason: ConversationRedactionReason,
  redactedAt: Timestamp,
): Record<string, unknown> {
  const patch: Record<string, unknown> = Object.fromEntries(
    contentFields(kind).map((field) => [field, FieldValue.delete()]),
  );
  return {
    ...patch,
    contentRedacted: true,
    contentRedactionReason: reason,
    contentRedactedAt: redactedAt,
    retentionPolicyVersion: conversationRetentionPolicyVersion,
    ...(kind === "event" ? { pending: false, executionLeaseId: null } : {}),
    ...(kind === "session" ? {
      stateVersion: 0,
      stateRedacted: true,
    } : {}),
    ...(kind === "thread" ? { title: "Conversation" } : {}),
  };
}

async function commitInChunks(
  database: FirebaseFirestore.Firestore,
  writes: Array<(batch: FirebaseFirestore.WriteBatch) => void>,
): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = database.batch();
    writes.slice(offset, offset + 400).forEach((write) => write(batch));
    await batch.commit();
  }
}

function belongsToForgottenGeneration(
  data: FirebaseFirestore.DocumentData,
  beforeMemoryGeneration?: number,
): boolean {
  if (beforeMemoryGeneration === undefined) return true;
  const generation = Number(data.memoryGeneration || 0);
  return generation === 0 || generation < beforeMemoryGeneration;
}

export async function inspectMemberConversationData(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<ConversationDataInspection> {
  const database = input.database || db;
  const threadRef = database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
  const thread = await threadRef.get();
  if (!thread.exists || thread.data()?.ownerUid !== input.actorUid) {
    throw new Error("Conversation not found.");
  }
  const [messages, sessions] = await Promise.all([
    threadRef.collection("messages").limit(500).get(),
    threadRef.collection("sessions").limit(200).get(),
  ]);
  const threadData = thread.data() || {};
  return jsonSafe({
    threadId: input.threadId,
    surface: String(threadData.boundSurface || threadData.lastOrigin || "web"),
    retentionDays: conversationContentRetentionDays,
    retentionPolicyVersion: conversationRetentionPolicyVersion,
    memoryGeneration: Math.max(1, Number(threadData.memoryGeneration || 1)),
    activeSessionId: String(threadData.activeSessionId || "") || null,
    retainedMessages: messages.docs.filter((document) => !document.data().contentRedacted).length,
    redactedMessages: messages.docs.filter((document) => document.data().contentRedacted).length,
    retainedSessions: sessions.docs.filter((document) => !document.data().contentRedacted).length,
    forgottenBefore: threadData.forgottenBefore || null,
    contentExpiresAt: threadData.contentExpiresAt || null,
    contentRedactedAt: threadData.contentRedactedAt || null,
  }) as ConversationDataInspection;
}

export async function redactMemberConversationData(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  reason: ConversationRedactionReason;
  beforeMemoryGeneration?: number;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ messages: number; sessions: number; runs: number; events: number }> {
  const database = input.database || db;
  const threadRef = database.doc(companyDocumentPath(
    input.companyId,
    "agentThreads",
    memberThreadDocumentId(input.actorUid, input.threadId),
  ));
  const thread = await threadRef.get();
  if (!thread.exists || thread.data()?.ownerUid !== input.actorUid) {
    throw new Error("Conversation not found.");
  }
  const [messages, sessions, runs, events, slackConversations, teamsConversations] = await Promise.all([
    threadRef.collection("messages").limit(500).get(),
    threadRef.collection("sessions").limit(200).get(),
    database.collection(companyCollectionPath(input.companyId, "agentRuns"))
      .where("threadId", "==", input.threadId).limit(500).get(),
    database.collectionGroup("events").where("threadId", "==", input.threadId).limit(500).get(),
    database.collection("slackConversations").limit(500).get(),
    database.collection("microsoftTeamsConversations").limit(500).get(),
  ]);
  const messageDocuments = messages.docs.filter((document) => (
    !document.data().contentRedacted
    && belongsToForgottenGeneration(document.data(), input.beforeMemoryGeneration)
  ));
  const sessionDocuments = sessions.docs.filter((document) => (
    !document.data().contentRedacted
    && belongsToForgottenGeneration(document.data(), input.beforeMemoryGeneration)
  ));
  const runDocuments = runs.docs.filter((document) => (
    document.data().actorUid === input.actorUid
    && !document.data().contentRedacted
    && belongsToForgottenGeneration(document.data(), input.beforeMemoryGeneration)
  ));
  const legacyConversationMatches = [
    ...slackConversations.docs.filter((document) => {
      const data = document.data();
      const derived = data.teamId && data.channelId
        ? `slack_${sha256Hex(`${data.teamId}:${data.channelId}:${input.actorUid}`).slice(0, 40)}`
        : "";
      return data.threadId === input.threadId || derived === input.threadId;
    }),
    ...teamsConversations.docs.filter((document) => {
      const data = document.data();
      const derived = data.tenantId && data.providerConversationId
        ? `teams_${sha256Hex(`${data.tenantId}:${data.providerConversationId}:${input.actorUid}`).slice(0, 40)}`
        : "";
      return data.threadId === input.threadId || derived === input.threadId;
    }),
  ].filter((document) => (
    !document.data().companyId || document.data().companyId === input.companyId
  ));
  const legacyEvents = (await Promise.all(legacyConversationMatches.map((document) => (
    document.ref.collection("events").limit(500).get()
  )))).flatMap((snapshot) => snapshot.docs);
  const eventDocuments = [...new Map([...events.docs, ...legacyEvents].map((document) => (
    [document.ref.path, document] as const
  ))).values()].filter((document) => (
    (!document.data().companyId || document.data().companyId === input.companyId)
    && (!document.data().actorUid || document.data().actorUid === input.actorUid)
    && !document.data().contentRedacted
    && belongsToForgottenGeneration(document.data(), input.beforeMemoryGeneration)
  ));
  const redactedAt = Timestamp.now();
  await commitInChunks(database, [
    ...messageDocuments.map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      document.ref,
      redactionPatch("message", input.reason, redactedAt),
      { merge: true },
    )),
    ...sessionDocuments.map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      document.ref,
      redactionPatch("session", input.reason, redactedAt),
      { merge: true },
    )),
    ...runDocuments.map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      document.ref,
      redactionPatch("run", input.reason, redactedAt),
      { merge: true },
    )),
    ...eventDocuments.map((document) => (batch: FirebaseFirestore.WriteBatch) => batch.set(
      document.ref,
      redactionPatch("event", input.reason, redactedAt),
      { merge: true },
    )),
    (batch) => batch.set(threadRef, {
      ...redactionPatch("thread", input.reason, redactedAt),
      conversationContentRedactedAt: redactedAt,
    }, { merge: true }),
  ]);
  return {
    messages: messageDocuments.length,
    sessions: sessionDocuments.length,
    runs: runDocuments.length,
    events: eventDocuments.length,
  };
}

async function redactExternalConversationSnapshot(input: {
  conversation: FirebaseFirestore.QueryDocumentSnapshot;
  reason: ConversationRedactionReason;
  database: FirebaseFirestore.Firestore;
}): Promise<number> {
  const events = await input.conversation.ref.collection("events").limit(500).get();
  const redactedAt = Timestamp.now();
  await commitInChunks(input.database, [
    ...events.docs.filter((event) => !event.data().contentRedacted).map((event) => (
      batch: FirebaseFirestore.WriteBatch,
    ) => batch.set(event.ref, redactionPatch("event", input.reason, redactedAt), { merge: true })),
    (batch) => batch.set(input.conversation.ref, {
      ...redactionPatch("external_conversation", input.reason, redactedAt),
      bindingStatus: "revoked",
      bindingRevokedAt: redactedAt,
    }, { merge: true }),
  ]);
  return events.size;
}

export async function redactExternalConversationsForConnection(input: {
  companyId: string;
  connectionId: string;
  reason: "connector_deleted";
  database?: FirebaseFirestore.Firestore;
}): Promise<{ conversations: number; events: number }> {
  const database = input.database || db;
  const connectionRef = database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}`,
  );
  const [connection, teamsUsers, ...directSnapshots] = await Promise.all([
    connectionRef.get(),
    connectionRef.collection("teamsUsers").limit(500).get(),
    database.collection("slackConversations").where("connectionId", "==", input.connectionId).limit(500).get(),
    database.collection("microsoftTeamsConversations").where("connectionId", "==", input.connectionId).limit(500).get(),
  ]);
  const connectionData = connection.data() || {};
  const connectorId = String(connectionData.connectorId || "");
  const providerAccountId = String(connectionData.providerAccountId || "");
  const tenantId = String(connectionData.tenantId || providerAccountId);
  const legacySnapshot = connectorId === "slack" && providerAccountId
    ? await database.collection("slackConversations")
      .where("teamId", "==", providerAccountId).limit(500).get()
    : connectorId === "microsoft_teams" && tenantId
      ? await database.collection("microsoftTeamsConversations").limit(500).get()
      : null;
  const linkedTeamsIdentities = new Set(teamsUsers.docs.flatMap((document) => [
    document.id,
    String(document.data().entraObjectId || ""),
    String(document.data().teamsUserId || ""),
  ].filter(Boolean)));
  const candidates = [...new Map([
    ...directSnapshots.flatMap((snapshot) => snapshot.docs),
    ...(legacySnapshot?.docs || []),
  ].map((document) => [document.ref.path, document] as const)).values()];
  const conversations = candidates.filter((document) => {
    const data = document.data();
    if (data.companyId && data.companyId !== input.companyId) return false;
    if (data.connectionId === input.connectionId) return true;
    if (connectorId === "slack") return data.teamId === providerAccountId;
    return connectorId === "microsoft_teams"
      && data.tenantId === tenantId
      && (linkedTeamsIdentities.has(String(data.entraObjectId || ""))
        || linkedTeamsIdentities.has(String(data.teamsUserId || "")));
  });
  const counts = await Promise.all(conversations.map((conversation) => (
    redactExternalConversationSnapshot({ conversation, reason: input.reason, database })
  )));
  return { conversations: conversations.length, events: counts.reduce((sum, count) => sum + count, 0) };
}

export async function redactMicrosoftTeamsConversationAfterUninstall(input: {
  tenantId: string;
  providerConversationId: string;
  entraObjectId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ conversations: number; events: number }> {
  const database = input.database || db;
  const snapshot = await database.collection("microsoftTeamsConversations")
    .where("providerConversationId", "==", input.providerConversationId).limit(10).get();
  const conversations = snapshot.docs.filter((document) => (
    document.data().tenantId === input.tenantId
    && document.data().entraObjectId === input.entraObjectId
  ));
  const counts = await Promise.all(conversations.map((conversation) => (
    redactExternalConversationSnapshot({
      conversation,
      reason: "installation_revoked",
      database,
    })
  )));
  return { conversations: conversations.length, events: counts.reduce((sum, count) => sum + count, 0) };
}

export async function redactExpiredConversationContent(input: {
  nowMs?: number;
  maximumDocuments?: number;
  database?: FirebaseFirestore.Firestore;
} = {}): Promise<{ redacted: number }> {
  const database = input.database || db;
  const now = Timestamp.fromMillis(input.nowMs ?? Date.now());
  const maximum = Math.min(400, Math.max(1, input.maximumDocuments || 400));
  const queries: Array<{ kind: ConversationContentKind; get(): Promise<FirebaseFirestore.QuerySnapshot> }> = [
    { kind: "event", get: () => database.collectionGroup("events").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "message", get: () => database.collectionGroup("messages").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "session", get: () => database.collectionGroup("sessions").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "run", get: () => database.collectionGroup("agentRuns").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "thread", get: () => database.collectionGroup("agentThreads").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "external_conversation", get: () => database.collection("slackConversations").where("contentExpiresAt", "<=", now).limit(maximum).get() },
    { kind: "external_conversation", get: () => database.collection("microsoftTeamsConversations").where("contentExpiresAt", "<=", now).limit(maximum).get() },
  ];
  const snapshots = await Promise.all(queries.map(async (query) => ({
    kind: query.kind,
    snapshot: await query.get(),
  })));
  const redactedAt = Timestamp.fromMillis(input.nowMs ?? Date.now());
  const documents = snapshots.flatMap(({ kind, snapshot }) => snapshot.docs
    .filter((document) => !document.data().contentRedacted)
    .map((document) => ({ kind, document })));
  await commitInChunks(database, documents.map(({ kind, document }) => (
    batch: FirebaseFirestore.WriteBatch,
  ) => batch.set(document.ref, redactionPatch(kind, "retention_expired", redactedAt), { merge: true })));
  return { redacted: documents.length };
}

type LegacyRetentionTarget = {
  id: string;
  kind: ConversationContentKind;
  query(database: FirebaseFirestore.Firestore): FirebaseFirestore.Query;
  activityFields: string[];
  accepts?(path: string): boolean;
};

const legacyRetentionTargets: LegacyRetentionTarget[] = [
  {
    id: "events",
    kind: "event",
    query: (database) => database.collectionGroup("events"),
    activityFields: ["processedAt", "failedAt", "createdAt"],
    accepts: (path) => path.startsWith("slackConversations/")
      || path.startsWith("microsoftTeamsConversations/"),
  },
  {
    id: "messages",
    kind: "message",
    query: (database) => database.collectionGroup("messages"),
    activityFields: ["createdAt"],
    accepts: (path) => path.includes("/agentThreads/"),
  },
  {
    id: "sessions",
    kind: "session",
    query: (database) => database.collectionGroup("sessions"),
    activityFields: ["lastActivityAt", "startedAt", "createdAt"],
    accepts: (path) => path.includes("/agentThreads/"),
  },
  {
    id: "runs",
    kind: "run",
    query: (database) => database.collectionGroup("agentRuns"),
    activityFields: ["createdAt"],
  },
  {
    id: "threads",
    kind: "thread",
    query: (database) => database.collectionGroup("agentThreads"),
    activityFields: ["lastMessageAt", "updatedAt", "createdAt"],
  },
  {
    id: "slack",
    kind: "external_conversation",
    query: (database) => database.collection("slackConversations"),
    activityFields: ["updatedAt", "createdAt"],
  },
  {
    id: "teams",
    kind: "external_conversation",
    query: (database) => database.collection("microsoftTeamsConversations"),
    activityFields: ["updatedAt", "createdAt"],
  },
];

async function legacyExternalBindingMetadata(input: {
  targetId: string;
  data: FirebaseFirestore.DocumentData;
  database: FirebaseFirestore.Firestore;
}): Promise<Record<string, unknown>> {
  if (input.targetId === "slack") {
    const teamId = String(input.data.teamId || "");
    const slackUserId = String(input.data.slackUserId || "");
    const channelId = String(input.data.channelId || "");
    if (!teamId || !slackUserId || !channelId) return {};
    const workspace = await input.database.doc(`slackWorkspaces/${teamId}`).get();
    const companyId = String(workspace.data()?.companyId || "");
    const connectionId = String(workspace.data()?.connectionId || "");
    if (!workspace.exists || workspace.data()?.status !== "active" || !companyId || !connectionId) return {};
    const identity = await input.database.doc(slackIdentityPath({
      companyId,
      connectionId,
      slackUserId,
    })).get();
    const actorUid = identity.data()?.status === "active" ? String(identity.data()?.uid || "") : "";
    if (!actorUid) return {};
    return {
      companyId,
      connectionId,
      actorUid,
      threadId: `slack_${sha256Hex(`${teamId}:${channelId}:${actorUid}`).slice(0, 40)}`,
      bindingStatus: "active",
    };
  }
  if (input.targetId === "teams") {
    const tenantId = String(input.data.tenantId || "");
    const entraObjectId = String(input.data.entraObjectId || "");
    const teamsUserId = String(input.data.teamsUserId || "");
    const providerConversationId = String(input.data.providerConversationId || "");
    if (!tenantId || !entraObjectId || !teamsUserId || !providerConversationId) return {};
    const identity = await input.database.doc(microsoftTeamsGlobalIdentityPath({
      tenantId,
      entraObjectId,
      teamsUserId,
    })).get();
    const data = identity.data() || {};
    if (!identity.exists || data.status !== "active") return {};
    const companyId = String(data.companyId || "");
    const connectionId = String(data.connectionId || "");
    const actorUid = String(data.uid || "");
    if (!companyId || !connectionId || !actorUid) return {};
    return {
      companyId,
      connectionId,
      actorUid,
      threadId: `teams_${sha256Hex(`${tenantId}:${providerConversationId}:${actorUid}`).slice(0, 40)}`,
      bindingStatus: "active",
    };
  }
  return {};
}

/**
 * One-time, resumable adoption path for conversation records created before
 * the retention contract existed. The cursor is version-scoped, so normal
 * hourly cleanup never needs an unbounded scan.
 */
export async function backfillLegacyConversationRetentionMetadata(input: {
  nowMs?: number;
  pageSize?: number;
  database?: FirebaseFirestore.Firestore;
} = {}): Promise<{ examined: number; stamped: number; redacted: number; complete: boolean }> {
  const database = input.database || db;
  const nowMs = input.nowMs ?? Date.now();
  const pageSize = Math.min(400, Math.max(1, input.pageSize || 200));
  const stateRef = database.doc(`maintenance/${conversationRetentionPolicyVersion}`);
  const state = await stateRef.get();
  const cursors = state.data()?.cursors && typeof state.data()?.cursors === "object"
    ? state.data()?.cursors as Record<string, string>
    : {};
  const completed = state.data()?.completed && typeof state.data()?.completed === "object"
    ? state.data()?.completed as Record<string, boolean>
    : {};
  let examined = 0;
  let stamped = 0;
  let redacted = 0;
  const cursorUpdates: Record<string, string> = {};
  const completionUpdates: Record<string, boolean> = {};
  for (const target of legacyRetentionTargets) {
    if (completed[target.id]) continue;
    let query = target.query(database).orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursors[target.id]) query = query.startAfter(database.doc(cursors[target.id]!));
    const snapshot = await query.get();
    examined += snapshot.size;
    const redactedAt = Timestamp.fromMillis(nowMs);
    const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
    for (const document of snapshot.docs) {
      if (target.accepts && !target.accepts(document.ref.path)) continue;
      const data = document.data();
      if (data.retentionPolicyVersion === conversationRetentionPolicyVersion) continue;
      const activityAtMs = target.activityFields
        .map((field) => timestampMillis(data[field]))
        .find((value) => value > 0) || nowMs;
      const bindingMetadata = target.kind === "external_conversation"
        ? await legacyExternalBindingMetadata({
          targetId: target.id,
          data,
          database,
        })
        : {};
      if (activityAtMs + conversationContentRetentionMs <= nowMs) {
        redacted += 1;
        writes.push((batch) => batch.set(
          document.ref,
          redactionPatch(target.kind, "retention_expired", redactedAt),
          { merge: true },
        ));
      } else {
        stamped += 1;
        writes.push((batch) => batch.set(
          document.ref,
          { ...conversationRetentionMetadata(activityAtMs), ...bindingMetadata },
          { merge: true },
        ));
      }
    }
    await commitInChunks(database, writes);
    const last = snapshot.docs.at(-1);
    if (last) cursorUpdates[target.id] = last.ref.path;
    if (snapshot.size < pageSize) completionUpdates[target.id] = true;
  }
  const nextCompleted = { ...completed, ...completionUpdates };
  const complete = legacyRetentionTargets.every((target) => nextCompleted[target.id]);
  await stateRef.set({
    retentionPolicyVersion: conversationRetentionPolicyVersion,
    cursors: { ...cursors, ...cursorUpdates },
    completed: nextCompleted,
    complete,
    updatedAt: Timestamp.fromMillis(nowMs),
  }, { merge: true });
  return { examined, stamped, redacted, complete };
}

export function contentExpiresAtMillis(data: Record<string, unknown>): number | null {
  const milliseconds = timestampMillis(data.contentExpiresAt);
  return milliseconds || null;
}
