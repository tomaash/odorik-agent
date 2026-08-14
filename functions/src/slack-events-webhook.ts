import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

import {
  drainSlackConversation,
  parseSlackDmEvent,
  queueSlackDmEvent,
  SlackEventRequestError,
  SlackConversationBusyError,
  verifySlackRequestSignature,
} from "./chat/slack-events.js";
import {
  parseSlackInteraction,
  processSlackApprovalInteraction,
  queueSlackApprovalInteraction,
  SlackInteractionError,
} from "./chat/slack-interactions.js";
import { productionAppOrigin } from "./connectors/google-oauth-return.js";
import { connectorCredentialKey, geminiApiKey, qdrantApiKey, qdrantUrl } from "./router.js";

export const slackSigningSecret = defineSecret("SLACK_SIGNING_SECRET");
const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const slackEventsWebhook = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
    serviceAccount: runtimeServiceAccount,
    secrets: [slackSigningSecret],
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      verifySlackRequestSignature({
        rawBody: request.rawBody,
        timestamp: header(request.headers["x-slack-request-timestamp"]),
        signature: header(request.headers["x-slack-signature"]),
        signingSecret: slackSigningSecret.value(),
      });
      const body = request.body as Record<string, unknown> | undefined;
      if (body?.type === "url_verification" && typeof body.challenge === "string") {
        response.status(200).json({ challenge: body.challenge });
        return;
      }
      const event = parseSlackDmEvent(body);
      if (!event) {
        response.status(200).json({ ok: true, ignored: true });
        return;
      }
      const status = await queueSlackDmEvent({ event });
      response.status(status === "queued" ? 202 : 200).json({ ok: true, status });
    } catch (error) {
      if (error instanceof SlackEventRequestError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("Slack webhook enqueue failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ error: "webhook_enqueue_failed" });
    }
  },
);

/**
 * Slack sends Block Kit actions as form-encoded `payload`. The endpoint does
 * only signature/identity/staleness validation and a durable queue claim before
 * acknowledging; execution happens on the Firestore trigger below.
 */
export const slackInteractionsWebhook = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 10,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
    serviceAccount: runtimeServiceAccount,
    secrets: [slackSigningSecret],
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      verifySlackRequestSignature({
        rawBody: request.rawBody,
        timestamp: header(request.headers["x-slack-request-timestamp"]),
        signature: header(request.headers["x-slack-signature"]),
        signingSecret: slackSigningSecret.value(),
      });
      const payload = parseSlackInteraction(request.body?.payload);
      const result = await queueSlackApprovalInteraction({ payload });
      response.status(200).json({
        response_type: "ephemeral",
        text: result.status === "queued"
          ? "Approval accepted. Erik is creating the task."
          : "This decision was already received.",
      });
    } catch (error) {
      const statusCode = error instanceof SlackEventRequestError
        ? error.statusCode
        : error instanceof SlackInteractionError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : "interaction_failed";
      response.status(statusCode).json({ error: message });
    }
  },
);

export const processSlackDm = onDocumentCreated(
  {
    document: "slackConversations/{conversationId}/events/{deliveryId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 3,
    retry: true,
    serviceAccount: runtimeServiceAccount,
    secrets: [connectorCredentialKey, geminiApiKey, qdrantApiKey, qdrantUrl],
  },
  async (event) => {
    const result = await drainSlackConversation({
      conversationId: event.params.conversationId,
      credentialKey: connectorCredentialKey.value(),
      geminiApiKey: geminiApiKey.value(),
      appOrigin: productionAppOrigin,
    });
    // Firestore retries this trigger. Contention must be retried rather than
    // acknowledged, otherwise an event arriving at the lease boundary can be
    // left queued with no future wake-up.
    if (!result.acquired) throw new SlackConversationBusyError();
  },
);

export const processSlackApproval = onDocumentCreated(
  {
    document: "slackApprovalInteractions/{interactionId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "256MiB",
    maxInstances: 5,
    retry: false,
    serviceAccount: runtimeServiceAccount,
    secrets: [connectorCredentialKey],
  },
  async (event) => {
    try {
      await processSlackApprovalInteraction({
        interactionId: event.params.interactionId,
        credentialKey: connectorCredentialKey.value(),
        appOrigin: productionAppOrigin,
      });
    } catch (error) {
      // The interaction record is the durable operator-visible failure. Blind
      // trigger retry could turn uncertain execution into a duplicate effect.
      console.error("Slack approval interaction failed", {
        interactionId: event.params.interactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
