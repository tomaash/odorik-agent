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
