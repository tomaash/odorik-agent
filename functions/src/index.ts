import { onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { api } from "./api.js";
import { projectCallContact, shouldProcessCallUpdate } from "./calls.js";
import { synchronizeKnowledgeRecord } from "./sync-qdrant.js";
import {
  connectorCredentialKey,
  geminiApiKey,
  githubAppPrivateKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
  qdrantApiKey,
  qdrantUrl,
} from "./router.js";
import { projectOdorikCallContext } from "./connectors/odorik.js";
import { syncAllGoogleCalendarConnections } from "./connectors/google-calendar.js";
import {
  githubConfigurationFromEnvironment,
  syncAllGitHubConnections,
} from "./connectors/github.js";
import {
  runEnabledWorkflowsForCall,
  workflowRuntimeFlags,
} from "./workflow/runtime.js";
export { googleOAuthCallback } from "./connectors/google-oauth-callback.js";
export { sendPartnerForm } from "./partner-form.js";
export { githubWebhook, processGitHubWebhook } from "./github-webhook.js";

export { api };

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const processCallWorkflows = onDocumentUpdated(
  {
    document: "companies/{companyId}/calls/{callId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!shouldProcessCallUpdate(before, after)) return;

    // The caller reaches the internal CRM whether or not a workflow matches,
    // and always before a workflow evaluates `caller.hasContact`. Running both
    // in one trigger keeps that ordering deterministic.
    await projectCallContact({
      companyId: event.params.companyId,
      callId: event.params.callId,
      call: after,
    });

    const flags = workflowRuntimeFlags();
    if (!flags.enabled) return;
    await runEnabledWorkflowsForCall({
      companyId: event.params.companyId,
      callId: event.params.callId,
    });
  },
);

export const syncKnowledgeIndex = onDocumentWritten(
  {
    document: "companies/{companyId}/{collectionId}/{documentId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 5,
    retry: true,
    serviceAccount: runtimeServiceAccount,
    secrets: [geminiApiKey, qdrantApiKey, qdrantUrl],
  },
  async (event) => {
    await synchronizeKnowledgeRecord({
      collection: event.params.collectionId,
      recordId: event.params.documentId,
      companyId: event.params.companyId,
      geminiApiKey: geminiApiKey.value(),
    });
  },
);

export const projectCallContext = onDocumentWritten(
  {
    document: "companies/{companyId}/calls/{callId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 5,
    retry: true,
    serviceAccount: runtimeServiceAccount,
  },
  async (event) => {
    await projectOdorikCallContext(
      event.params.companyId,
      event.params.callId,
      event.data?.after.data(),
    );
  },
);

export const syncCalendarSources = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      googleConnectorClientId,
      googleConnectorClientSecret,
    ],
  },
  async () => {
    const results = await syncAllGoogleCalendarConnections({
      clientId: googleConnectorClientId.value(),
      clientSecret: googleConnectorClientSecret.value(),
      credentialKey: connectorCredentialKey.value(),
    });
    const failures = results.filter((result) => !result.ok);
    if (failures.length) {
      console.error("One or more Google Calendar connections failed to synchronize", failures);
      throw new Error(`${failures.length} Google Calendar connection(s) failed`);
    }
  },
);

export const syncGitHubSources = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [githubAppPrivateKey],
  },
  async () => {
    const results = await syncAllGitHubConnections({
      configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
    });
    const failures = results.filter((result) => !result.ok);
    if (failures.length) {
      console.error("One or more GitHub connections failed to reconcile", failures);
      throw new Error(`${failures.length} GitHub connection(s) failed`);
    }
  },
);
