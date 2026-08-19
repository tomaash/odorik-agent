import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

import { createMicrosoftTeamsInboundRuntime } from "./chat/microsoft-teams-bot.js";
import {
  drainMicrosoftTeamsConversation,
  MicrosoftTeamsConversationBusyError,
  parseMicrosoftTeamsPersonalMessage,
  queueMicrosoftTeamsMessage,
  recordMicrosoftTeamsInstallationUpdate,
} from "./chat/microsoft-teams-events.js";
import {
  processMicrosoftTeamsDecision,
  queueMicrosoftTeamsDecision,
  syncMicrosoftTeamsApprovalOutcome,
} from "./chat/microsoft-teams-interactions.js";
import { productionAppOrigin } from "./connectors/google-oauth-return.js";
import {
  connectorCredentialKey,
  geminiApiKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
  microsoftConnectorClientId,
  microsoftConnectorClientSecret,
  qdrantApiKey,
  qdrantUrl,
} from "./router.js";
import { sha256Hex } from "./hash.js";

export const microsoftTeamsBotClientId = defineSecret("MICROSOFT_TEAMS_BOT_CLIENT_ID");
export const microsoftTeamsBotClientSecret = defineSecret("MICROSOFT_TEAMS_BOT_CLIENT_SECRET");
export const microsoftTeamsBotTenantId = defineSecret("MICROSOFT_TEAMS_BOT_TENANT_ID");
const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

let cachedRuntime: Awaited<ReturnType<typeof createMicrosoftTeamsInboundRuntime>> | null = null;
let cachedCredentialIdentity = "";

async function inboundRuntime() {
  const clientId = microsoftTeamsBotClientId.value();
  const clientSecret = microsoftTeamsBotClientSecret.value();
  const tenantId = microsoftTeamsBotTenantId.value();
  const identity = sha256Hex(`${clientId}:${clientSecret}:${tenantId}`);
  if (!cachedRuntime || cachedCredentialIdentity !== identity) {
    cachedRuntime = await createMicrosoftTeamsInboundRuntime({
      clientId,
      clientSecret,
      tenantId,
      onMessage: async (activity) => {
        const event = parseMicrosoftTeamsPersonalMessage(activity);
        if (event) await queueMicrosoftTeamsMessage({ event });
      },
      onCardAction: async (activity) => {
        const result = await queueMicrosoftTeamsDecision({ activity });
        if (result.status === "resolved") {
          await syncMicrosoftTeamsApprovalOutcome({
            companyId: result.companyId,
            approvalId: result.approvalId,
            appOrigin: productionAppOrigin,
            clientId,
            clientSecret,
            tenantId,
          });
        }
        return result.status;
      },
      onInstallationUpdate: (activity, installed) => recordMicrosoftTeamsInstallationUpdate({
        activity,
        installed,
      }).then(() => undefined),
    });
    cachedCredentialIdentity = identity;
  }
  return cachedRuntime;
}

export const microsoftTeamsWebhook = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
    serviceAccount: runtimeServiceAccount,
    secrets: [microsoftTeamsBotClientId, microsoftTeamsBotClientSecret, microsoftTeamsBotTenantId],
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      const runtime = await inboundRuntime();
      const result = await runtime.handle({
        body: request.body,
        headers: Object.fromEntries(Object.entries(request.headers)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, value as string | string[]])),
      });
      if (result.body === undefined) response.sendStatus(result.status);
      else response.status(result.status).json(result.body);
    } catch (error) {
      console.error("Teams webhook failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ error: "teams_webhook_failed" });
    }
  },
);

export const processMicrosoftTeamsDm = onDocumentCreated(
  {
    document: "microsoftTeamsConversations/{conversationId}/events/{eventId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 3,
    retry: true,
    serviceAccount: runtimeServiceAccount,
    secrets: [microsoftTeamsBotClientId, microsoftTeamsBotClientSecret, microsoftTeamsBotTenantId,
      connectorCredentialKey, geminiApiKey, qdrantApiKey, qdrantUrl],
  },
  async (event) => {
    const result = await drainMicrosoftTeamsConversation({
      conversationId: event.params.conversationId,
      credentialKey: connectorCredentialKey.value(),
      geminiApiKey: geminiApiKey.value(),
      appOrigin: productionAppOrigin,
      clientId: microsoftTeamsBotClientId.value(),
      clientSecret: microsoftTeamsBotClientSecret.value(),
      tenantId: microsoftTeamsBotTenantId.value(),
    });
    if (!result.acquired) throw new MicrosoftTeamsConversationBusyError();
  },
);

export const processMicrosoftTeamsApproval = onDocumentCreated(
  {
    document: "microsoftTeamsApprovalInteractions/{interactionId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "256MiB",
    maxInstances: 5,
    retry: false,
    serviceAccount: runtimeServiceAccount,
    secrets: [microsoftTeamsBotClientId, microsoftTeamsBotClientSecret, microsoftTeamsBotTenantId,
      connectorCredentialKey, geminiApiKey, qdrantApiKey, qdrantUrl,
      googleConnectorClientId, googleConnectorClientSecret,
      microsoftConnectorClientId, microsoftConnectorClientSecret],
  },
  async (event) => {
    try {
      await processMicrosoftTeamsDecision({
        interactionId: event.params.interactionId,
        credentialKey: connectorCredentialKey.value(),
        geminiApiKey: geminiApiKey.value(),
        appOrigin: productionAppOrigin,
        clientId: microsoftTeamsBotClientId.value(),
        clientSecret: microsoftTeamsBotClientSecret.value(),
        tenantId: microsoftTeamsBotTenantId.value(),
      });
    } catch (error) {
      console.error("Teams approval interaction failed", {
        interactionId: event.params.interactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export const syncMicrosoftTeamsApprovalDecision = onDocumentUpdated(
  {
    document: "companies/{companyId}/actionApprovals/{approvalId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 5,
    retry: false,
    serviceAccount: runtimeServiceAccount,
    secrets: [microsoftTeamsBotClientId, microsoftTeamsBotClientSecret, microsoftTeamsBotTenantId],
  },
  async (event) => {
    const before = event.data?.before.data() || {};
    const after = event.data?.after.data() || {};
    const beforeState = `${String(before.decisionStatus || "pending")}:${String(before.executionStatus || "not_started")}:${String(before.supersededByApprovalId || "")}`;
    const afterState = `${String(after.decisionStatus || "pending")}:${String(after.executionStatus || "not_started")}:${String(after.supersededByApprovalId || "")}`;
    if (beforeState === afterState || after.decisionStatus === "pending") return;
    await syncMicrosoftTeamsApprovalOutcome({
      companyId: event.params.companyId,
      approvalId: event.params.approvalId,
      appOrigin: productionAppOrigin,
      clientId: microsoftTeamsBotClientId.value(),
      clientSecret: microsoftTeamsBotClientSecret.value(),
      tenantId: microsoftTeamsBotTenantId.value(),
    });
  },
);
