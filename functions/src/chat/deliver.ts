import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { companyDocumentPath } from "../tenancy.js";
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
    const existing = await ref.get();
    const existingData = existing.data() as ChatNotificationRecord | undefined;
    // Anything other than a clean retryable failure is left alone: a succeeded
    // delivery is done, a `sending` claim belongs to another attempt, and an unknown
    // outcome must not be retried blindly into a duplicate notice.
    if (existingData && existingData.status !== "failed_safe_to_retry") continue;

    const now = Timestamp.now();
    await ref.set({
      companyId: input.companyId,
      approvalId: notification.approvalId,
      connectionId: destination.connectionId,
      channelId: destination.channelId,
      status: "sending",
      error: null,
      ...(existing.exists ? {} : { createdAt: now }),
      updatedAt: now,
    } satisfies Partial<ChatNotificationRecord>, { merge: true });

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
      await ref.set({
        status: "succeeded",
        messageTs: result.messageTs,
        permalink: result.permalink,
        error: null,
        updatedAt: Timestamp.now(),
      }, { merge: true });
      delivered += 1;
    } catch (error) {
      const status = error instanceof SlackNotifyGrantMissingError
        ? "failed_safe_to_retry"
        : classifySlackDeliveryFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      await ref.set({
        status,
        error: message.slice(0, 500),
        updatedAt: Timestamp.now(),
      }, { merge: true });
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
