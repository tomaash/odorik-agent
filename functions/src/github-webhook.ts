import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { db } from "./firestore.js";
import {
  GitHubWebhookDeferredError,
  GitHubWebhookRequestError,
  processGitHubWebhookDelivery,
  queueGitHubWebhookDelivery,
  recordGitHubWebhookFailure,
  type QueuedGitHubWebhookPayload,
} from "./connectors/github-webhook.js";
import { githubConfigurationFromEnvironment } from "./connectors/github.js";
import { githubAppPrivateKey } from "./router.js";
import { requestLabeledCodingImplementationApproval } from "./coding/proposal.js";

export const githubWebhookSecret = defineSecret("GITHUB_WEBHOOK_SECRET");

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const githubWebhook = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
    serviceAccount: runtimeServiceAccount,
    secrets: [githubWebhookSecret],
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      const result = await queueGitHubWebhookDelivery({
        body: request.rawBody,
        signature: header(request.headers["x-hub-signature-256"]),
        event: header(request.headers["x-github-event"]),
        deliveryId: header(request.headers["x-github-delivery"]),
        secret: githubWebhookSecret.value(),
      });
      response.status(result.status === "queued" ? 202 : 200).json(result);
    } catch (error) {
      if (error instanceof GitHubWebhookRequestError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("GitHub webhook enqueue failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ error: "webhook_enqueue_failed" });
    }
  },
);

export const processGitHubWebhook = onDocumentCreated(
  {
    document: "githubWebhookDeliveries/{deliveryDocumentId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 5,
    retry: true,
    serviceAccount: runtimeServiceAccount,
    secrets: [githubAppPrivateKey],
  },
  async (event) => {
    const deliveryRef = event.data?.ref;
    if (!deliveryRef) return;
    const current = await deliveryRef.get();
    const delivery = current.data();
    if (!current.exists || delivery?.status === "processed") return;

    await deliveryRef.set({
      attempts: FieldValue.increment(1),
      lastAttemptAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    try {
      const configuration = githubConfigurationFromEnvironment(githubAppPrivateKey.value());
      const result = await processGitHubWebhookDelivery({
        deliveryId: String(delivery?.deliveryId || ""),
        event: delivery?.event,
        action: String(delivery?.action || "unknown"),
        companyId: String(delivery?.companyId || ""),
        connectionId: String(delivery?.connectionId || ""),
        installationId: Number(delivery?.installationId),
        payload: delivery?.payload as QueuedGitHubWebhookPayload,
        configuration,
      });
      if (result.issueContextItemId) {
        await requestLabeledCodingImplementationApproval({
          companyId: String(delivery?.companyId || ""),
          actorUid: "workflow:coding.issue.label",
          issueContextItemId: result.issueContextItemId,
          configuration,
        });
      }
      await deliveryRef.set({
        status: "processed",
        outcome: result.outcome,
        processedAt: FieldValue.serverTimestamp(),
        lastError: null,
      }, { merge: true });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      if (error instanceof GitHubWebhookDeferredError) {
        await deliveryRef.set({
          status: "pending",
          lastError: null,
          deferredAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        throw error;
      }
      await Promise.all([
        deliveryRef.set({
          status: "failed",
          lastError: message,
          failedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        recordGitHubWebhookFailure({
          companyId: String(delivery?.companyId || ""),
          connectionId: String(delivery?.connectionId || ""),
          deliveryId: String(delivery?.deliveryId || ""),
          event: String(delivery?.event || "unknown"),
          action: String(delivery?.action || "unknown"),
          error,
        }).catch((recordError) => {
          console.error("Unable to record GitHub webhook failure", {
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }),
      ]);
      throw error;
    }
  },
);
