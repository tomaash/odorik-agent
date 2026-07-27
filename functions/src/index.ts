import { onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { api } from "./api.js";
import { processCompletedCall, shouldProcessCallUpdate } from "./crm/process.js";
import { synchronizeKnowledgeRecord } from "./sync-qdrant.js";
import {
  connectorCredentialKey,
  geminiApiKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
  qdrantApiKey,
  qdrantUrl,
} from "./router.js";
import { projectOdorikCallContext } from "./connectors/odorik.js";
import { syncAllGoogleCalendarConnections } from "./connectors/google-calendar.js";
import { db } from "./firestore.js";
import { explorersCompanyId } from "./tenancy.js";
export { googleOAuthCallback } from "./connectors/google-oauth-callback.js";
export { sendPartnerForm } from "./partner-form.js";

export { api };

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const processCallCrm = onDocumentUpdated(
  {
    document: "companies/{companyId}/calls/{callId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [geminiApiKey],
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!shouldProcessCallUpdate(before, after)) return;
    await processCompletedCall({
      companyId: event.params.companyId,
      callId: event.params.callId,
      apiKey: geminiApiKey.value(),
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

// Temporary cutover bridge: the currently deployed ingest/processor pair
// writes legacy top-level call documents. Keeping this bridge during the
// container rollout prevents a recording arriving between deployments from
// being stranded outside the Explorers tenant.
export const bridgeLegacyCallToExplorers = onDocumentWritten(
  {
    document: "calls/{callId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    retry: true,
    serviceAccount: runtimeServiceAccount,
  },
  async (event) => {
    const target = db.doc(
      `companies/${explorersCompanyId}/calls/${event.params.callId}`,
    );
    if (!event.data?.after.exists) {
      await target.delete();
      return;
    }
    await target.set({
      ...event.data.after.data(),
      companyId: explorersCompanyId,
      migratedFromLegacyAt: FieldValue.serverTimestamp(),
    }, { merge: true });
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
