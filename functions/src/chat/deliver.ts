import { Timestamp } from "firebase-admin/firestore";
import { randomBytes } from "node:crypto";

import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { authorizedSlackNotify, SlackNotifyGrantMissingError } from "../connectors/slack-oauth.js";
import { enabledSlackDestinations } from "./channels.js";
import { composeApprovalNotification } from "./notification.js";
import {
  classifySlackDeliveryFailure,
  postApprovalNotification,
  type SlackDeliveryResult,
} from "./slack.js";

export type ChatNotificationRecord = {
  companyId: string;
  approvalId: string;
  connectionId: string;
  channelId: string;
  status: "sending" | "succeeded" | "failed_safe_to_retry" | "outcome_unknown";
  messageTs?: string | null;
  permalink?: string | null;
  error?: string | null;
  executionAttemptId?: string | null;
  executionLeaseExpiresAt?: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/**
 * One record per approval per destination. This is the whole idempotency story:
 * `chat.postMessage` has no dedupe key, so the claim below is what stops a
 * re-triggered event from posting the same notice twice.
 */
export function chatNotificationPath(
  companyId: string,
  approvalId: string,
  channelId: string,
): string {
  return companyDocumentPath(
    companyId,
    "chatNotifications",
    `${approvalId}__${channelId}`,
  );
}

export type DeliverApprovalNotificationsResult = {
  delivered: number;
  skipped: "not_notifiable" | "no_destination" | null;
};

export type PublicChatNotificationRecord = Omit<
  ChatNotificationRecord,
  "executionAttemptId" | "executionLeaseExpiresAt" | "createdAt" | "updatedAt"
> & {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
};

function publicChatNotification(
  document: FirebaseFirestore.QueryDocumentSnapshot,
): PublicChatNotificationRecord {
  const {
    executionAttemptId: _secret,
    executionLeaseExpiresAt,
    ...data
  } = document.data() as ChatNotificationRecord;
  const staleSending = data.status === "sending"
    && (executionLeaseExpiresAt?.toMillis?.() || 0) <= Date.now();
  return jsonSafe({
    id: document.id,
    ...data,
    ...(staleSending ? {
      status: "outcome_unknown",
      error: data.error || "The delivery worker ended without recording Slack's outcome.",
    } : {}),
  }) as PublicChatNotificationRecord;
}

export async function listChatNotifications(input: {
  companyId: string;
  limit?: number;
  database?: FirebaseFirestore.Firestore;
}): Promise<PublicChatNotificationRecord[]> {
  const database = input.database || db;
  const snapshot = await database
    .collection(companyCollectionPath(input.companyId, "chatNotifications"))
    .orderBy("updatedAt", "desc")
    .limit(Math.min(input.limit || 100, 200))
    .get();
  return snapshot.docs.map(publicChatNotification);
}

export async function chatNotificationsForApprovals(input: {
  companyId: string;
  approvalIds: string[];
  database?: FirebaseFirestore.Firestore;
}): Promise<Map<string, PublicChatNotificationRecord[]>> {
  const database = input.database || db;
  const result = new Map<string, PublicChatNotificationRecord[]>();
  const approvalIds = [...new Set(input.approvalIds)].filter(Boolean);
  for (let offset = 0; offset < approvalIds.length; offset += 30) {
    const snapshot = await database
      .collection(companyCollectionPath(input.companyId, "chatNotifications"))
      .where("approvalId", "in", approvalIds.slice(offset, offset + 30))
      .get();
    for (const document of snapshot.docs) {
      const notification = publicChatNotification(document);
      result.set(notification.approvalId, [
        ...(result.get(notification.approvalId) || []),
        notification,
      ]);
    }
  }
  return result;
}

export async function retryApprovalNotifications(input: {
  companyId: string;
  approvalId: string;
  appOrigin: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<DeliverApprovalNotificationsResult> {
  const database = input.database || db;
  const approval = await database.doc(companyDocumentPath(
    input.companyId,
    "actionApprovals",
    input.approvalId,
  )).get();
  if (!approval.exists || approval.data()?.objectType !== "action_approval") {
    throw new Error("Approval not found");
  }
  return deliverApprovalNotifications({
    companyId: input.companyId,
    approval: { id: approval.id, ...approval.data() },
    appOrigin: input.appOrigin,
    credentialKey: input.credentialKey,
    database,
  });
}

async function claimChatNotification(input: {
  database: FirebaseFirestore.Firestore;
  reference: FirebaseFirestore.DocumentReference;
  companyId: string;
  approvalId: string;
  connectionId: string;
  channelId: string;
}): Promise<string | null> {
  const executionAttemptId = randomBytes(16).toString("hex");
  return input.database.runTransaction(async (transaction) => {
    const existing = await transaction.get(input.reference);
    const existingData = existing.data() as ChatNotificationRecord | undefined;
    if (existingData && existingData.status !== "failed_safe_to_retry") return null;

    const now = Timestamp.now();
    transaction.set(input.reference, {
      companyId: input.companyId,
      approvalId: input.approvalId,
      connectionId: input.connectionId,
      channelId: input.channelId,
      status: "sending",
      executionAttemptId,
      executionLeaseExpiresAt: Timestamp.fromMillis(now.toMillis() + 2 * 60 * 1_000),
      error: null,
      ...(existing.exists ? {} : { createdAt: now }),
      updatedAt: now,
    } satisfies Partial<ChatNotificationRecord>, { merge: true });
    return executionAttemptId;
  });
}

async function finishChatNotification(input: {
  database: FirebaseFirestore.Firestore;
  reference: FirebaseFirestore.DocumentReference;
  executionAttemptId: string;
  patch: Partial<ChatNotificationRecord>;
}): Promise<boolean> {
  return input.database.runTransaction(async (transaction) => {
    const current = await transaction.get(input.reference);
    const data = current.data() as ChatNotificationRecord | undefined;
    if (!data || data.executionAttemptId !== input.executionAttemptId) return false;
    transaction.set(input.reference, {
      ...input.patch,
      executionAttemptId: null,
      executionLeaseExpiresAt: null,
      updatedAt: Timestamp.now(),
    }, { merge: true });
    return true;
  });
}

/**
 * Deliver one approval's notice to every configured destination.
 *
 * Runs outside the approval transaction, from a Firestore trigger: a transaction
 * retries, and a retried transaction that posts to Slack posts twice. Failure here
 * must also never fail approval creation — the decision exists whether or not
 * anyone was told about it.
 */
export async function deliverApprovalNotifications(input: {
  companyId: string;
  approval: Record<string, unknown>;
  appOrigin: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
  post?: typeof postApprovalNotification;
  authorize?: typeof authorizedSlackNotify;
}): Promise<DeliverApprovalNotificationsResult> {
  const database = input.database || db;
  const post = input.post || postApprovalNotification;
  const authorize = input.authorize || authorizedSlackNotify;

  const notification = composeApprovalNotification(input.approval, {
    appOrigin: input.appOrigin,
  });
  if (!notification) return { delivered: 0, skipped: "not_notifiable" };

  const destinations = await enabledSlackDestinations({
    companyId: input.companyId,
    database,
  });
  if (destinations.length === 0) return { delivered: 0, skipped: "no_destination" };

  let delivered = 0;
  for (const destination of destinations) {
    const ref = database.doc(chatNotificationPath(
      input.companyId,
      notification.approvalId,
      destination.channelId,
    ));
    // The claim and eligibility check must be one transaction. Firestore delivery
    // is at-least-once and duplicate trigger invocations can overlap rather than
    // merely run one after another.
    const executionAttemptId = await claimChatNotification({
      database,
      reference: ref,
      companyId: input.companyId,
      approvalId: notification.approvalId,
      connectionId: destination.connectionId,
      channelId: destination.channelId,
    });
    if (!executionAttemptId) continue;

    try {
      const { botToken } = await authorize({
        companyId: input.companyId,
        connectionId: destination.connectionId,
        credentialKey: input.credentialKey,
        database,
      });
      const result: SlackDeliveryResult = await post({
        token: botToken,
        channelId: destination.channelId,
        notification,
      });
      const recorded = await finishChatNotification({
        database,
        reference: ref,
        executionAttemptId,
        patch: {
          status: "succeeded",
          messageTs: result.messageTs,
          permalink: result.permalink,
          error: null,
        },
      });
      if (recorded) delivered += 1;
    } catch (error) {
      const status = error instanceof SlackNotifyGrantMissingError
        ? "failed_safe_to_retry"
        : classifySlackDeliveryFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      await finishChatNotification({
        database,
        reference: ref,
        executionAttemptId,
        patch: { status, error: message.slice(0, 500) },
      });
      console.error("[chat-notify] delivery failed", {
        companyId: input.companyId,
        approvalId: notification.approvalId,
        channelId: destination.channelId,
        status,
        error: message,
      });
    }
  }
  return { delivered, skipped: null };
}
