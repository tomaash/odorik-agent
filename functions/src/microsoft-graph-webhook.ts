import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

import {
  processMicrosoftGraphNotification,
  queueMicrosoftGraphNotifications,
  type MicrosoftGraphNotification,
} from "./connectors/microsoft-outlook-subscriptions.js";
import {
  connectorCredentialKey,
  microsoftConnectorClientId,
  microsoftConnectorClientSecret,
} from "./router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const microsoftGraphWebhook = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 10,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
    serviceAccount: runtimeServiceAccount,
    cors: false,
  },
  async (request, response) => {
    const validationToken = typeof request.query.validationToken === "string"
      ? request.query.validationToken
      : null;
    if (validationToken) {
      response.type("text/plain").status(200).send(validationToken);
      return;
    }
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    const notifications = Array.isArray(request.body?.value)
      ? request.body.value as MicrosoftGraphNotification[]
      : [];
    const result = await queueMicrosoftGraphNotifications({ notifications });
    response.status(202).json({ ok: true, ...result });
  },
);

export const processMicrosoftGraphWebhook = onDocumentCreated(
  {
    document: "microsoftGraphNotifications/{notificationId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 3,
    retry: true,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      microsoftConnectorClientId,
      microsoftConnectorClientSecret,
    ],
  },
  async (event) => processMicrosoftGraphNotification({
    notificationId: event.params.notificationId,
    companyId: "",
    connectionId: "",
    clientId: microsoftConnectorClientId.value(),
    clientSecret: microsoftConnectorClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  }),
);
