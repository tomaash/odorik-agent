import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { api } from "./api.js";
import { db } from "./firestore.js";
import { projectCallContact, shouldProcessCallUpdate } from "./calls.js";
import { createKnowledgeIndexDependencies } from "./sync-qdrant.js";
import {
  enqueueKnowledgeIndexDelivery,
  executeKnowledgeIndexDelivery,
  recoverDueKnowledgeIndexDeliveries,
} from "./knowledge-index-runtime.js";
import {
  connectorCredentialKey,
  geminiApiKey,
  githubAppPrivateKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
  microsoftConnectorClientId,
  microsoftConnectorClientSecret,
  qdrantApiKey,
  qdrantUrl,
} from "./router.js";
import { projectOdorikCallContext } from "./connectors/odorik.js";
import { deliverApprovalNotifications } from "./chat/deliver.js";
import { productionAppOrigin } from "./connectors/google-oauth-return.js";
import {
  retryDueGoogleCalendarSyncRuns,
  syncAllGoogleCalendarConnections,
} from "./connectors/google-calendar.js";
import {
  retryDueGoogleDriveSyncRuns,
  syncAllGoogleDriveConnections,
} from "./connectors/google-drive.js";
import {
  retryDueGoogleGmailSyncRuns,
  syncAllGoogleGmailConnections,
} from "./connectors/google-gmail.js";
import {
  retryDueMicrosoftOutlookSyncRuns,
  syncAllMicrosoftOutlookConnections,
} from "./connectors/microsoft-outlook.js";
import {
  retryDueMicrosoftOutlookCalendarSyncRuns,
  syncAllMicrosoftOutlookCalendarConnections,
} from "./connectors/microsoft-outlook-calendar.js";
import { ensureAllMicrosoftOutlookSubscriptions } from "./connectors/microsoft-outlook-subscriptions.js";
import {
  githubConfigurationFromEnvironment,
  retryDueGitHubSyncRuns,
  syncAllGitHubConnections,
} from "./connectors/github.js";
import {
  runEnabledWorkflowsForCall,
  workflowRuntimeFlags,
} from "./workflow/runtime.js";
import { GoogleCodingArtifactStore } from "./coding/artifacts.js";
import {
  createCloudRunExecutionInspector,
  reconcileCodingRuns,
} from "./coding/reconcile.js";
import { queueCodingPublisher } from "./coding/service.js";
import {
  backfillLegacyConversationRetentionMetadata,
  redactExpiredConversationContent,
} from "./agent/conversation-retention.js";
export { googleOAuthCallback } from "./connectors/google-oauth-callback.js";
export { microsoftOAuthCallback } from "./connectors/microsoft-oauth-callback.js";
export {
  microsoftGraphWebhook,
  processMicrosoftGraphWebhook,
} from "./microsoft-graph-webhook.js";
export { slackOAuthCallback } from "./connectors/slack-oauth-callback.js";
export {
  slackEventsWebhook,
  slackInteractionsWebhook,
  processSlackDm,
  processSlackApproval,
  syncSlackApprovalDecision,
} from "./slack-events-webhook.js";
export {
  microsoftTeamsWebhook,
  processMicrosoftTeamsDm,
  processMicrosoftTeamsApproval,
  syncMicrosoftTeamsApprovalDecision,
} from "./microsoft-teams-webhook.js";
export { sendPartnerForm } from "./partner-form.js";
export { githubWebhook, processGitHubWebhook } from "./github-webhook.js";
export { grokAuthCallback } from "./grok-auth-callback.js";
export { codingCallback } from "./coding-callback.js";
export { codingAuthCallback } from "./coding-auth-callback.js";

export { api };

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

function knowledgeIndexDependencies() {
  return createKnowledgeIndexDependencies({
    database: db,
    geminiApiKey: geminiApiKey.value(),
  });
}

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
    const after = event.data?.after;
    const before = event.data?.before;
    const queued = await enqueueKnowledgeIndexDelivery({
      collection: event.params.collectionId,
      recordId: event.params.documentId,
      companyId: event.params.companyId,
      eventId: event.id,
      sourceCommittedAt: event.time,
      sourceExists: Boolean(after?.exists),
      sourceData: after?.data() || before?.data(),
    }, knowledgeIndexDependencies());
    if (queued.deliveryId) {
      await executeKnowledgeIndexDelivery({
        companyId: event.params.companyId,
        deliveryId: queued.deliveryId,
      }, knowledgeIndexDependencies());
    }
  },
);

/**
 * Tell the named approver that a decision is waiting.
 *
 * A trigger rather than a call inside `requestWorkflowActionApproval`: that runs in
 * a Firestore transaction, transactions retry, and a retried transaction that posts
 * to Slack posts twice. Running here also means a failing Slack can never fail
 * approval creation — the decision stands whether or not anyone was told.
 *
 * `retry: false` deliberately. Delivery already records its own outcome per
 * destination, and an automatic re-run of an `outcome_unknown` delivery is exactly
 * the blind retry the epic forbids.
 */
export const notifyApprovalRequested = onDocumentCreated(
  {
    document: "companies/{companyId}/actionApprovals/{approvalId}",
    database: "odorik",
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5,
    retry: false,
    serviceAccount: runtimeServiceAccount,
    secrets: [connectorCredentialKey],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    try {
      await deliverApprovalNotifications({
        companyId: event.params.companyId,
        approval: { id: event.params.approvalId, ...data },
        appOrigin: productionAppOrigin,
        credentialKey: connectorCredentialKey.value(),
      });
    } catch (error) {
      // Never let notification trouble surface as approval trouble.
      console.error("[chat-notify] approval notification failed", {
        companyId: event.params.companyId,
        approvalId: event.params.approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

type ScheduledTask = { name: string; run: () => Promise<void> };

async function runScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async ({ name, run }) => {
    await run();
    console.info("Scheduled task completed", { name });
  }));
  const failures = results.flatMap((result, index) => (
    result.status === "rejected"
      ? [{
        name: tasks[index]?.name || `task-${index}`,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }]
      : []
  ));
  if (failures.length) {
    console.error("Scheduled task batch completed with failures", { failures });
    throw new Error(`${failures.length} scheduled task(s) failed`);
  }
}

function googleConnectorConfiguration() {
  return {
    clientId: googleConnectorClientId.value(),
    clientSecret: googleConnectorClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  };
}

function microsoftConnectorConfiguration() {
  return {
    clientId: microsoftConnectorClientId.value(),
    clientSecret: microsoftConnectorClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  };
}

function logAttention(label: string, results: Array<{ status: string }>): void {
  const attention = results.filter((result) => result.status === "attention");
  if (attention.length) console.error(`${label} need attention`, attention);
}

function logFailures(label: string, results: Array<{ ok: boolean }>): void {
  const failures = results.filter((result) => !result.ok);
  if (failures.length) console.error(`${label} failed`, failures);
}

export const recoverScheduledWork = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 0,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      geminiApiKey,
      qdrantApiKey,
      qdrantUrl,
      googleConnectorClientSecret,
      microsoftConnectorClientSecret,
      githubAppPrivateKey,
    ],
  },
  async () => runScheduledTasks([
    {
      name: "knowledge-index-deliveries",
      run: async () => logAttention(
        "Knowledge-index deliveries",
        await recoverDueKnowledgeIndexDeliveries(knowledgeIndexDependencies()),
      ),
    },
    {
      name: "google-calendar",
      run: async () => logAttention(
        "Google Calendar recovery runs",
        await retryDueGoogleCalendarSyncRuns(googleConnectorConfiguration()),
      ),
    },
    {
      name: "google-drive",
      run: async () => logAttention(
        "Google Drive recovery runs",
        await retryDueGoogleDriveSyncRuns(googleConnectorConfiguration()),
      ),
    },
    {
      name: "google-mail",
      run: async () => logAttention(
        "Google Mail recovery runs",
        await retryDueGoogleGmailSyncRuns(googleConnectorConfiguration()),
      ),
    },
    {
      name: "outlook-mail",
      run: async () => logAttention(
        "Outlook Mail recovery runs",
        await retryDueMicrosoftOutlookSyncRuns(microsoftConnectorConfiguration()),
      ),
    },
    {
      name: "outlook-calendar",
      run: async () => logAttention(
        "Outlook Calendar recovery runs",
        await retryDueMicrosoftOutlookCalendarSyncRuns(microsoftConnectorConfiguration()),
      ),
    },
    {
      name: "github",
      run: async () => logAttention(
        "GitHub recovery runs",
        await retryDueGitHubSyncRuns({
          configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
        }),
      ),
    },
    {
      name: "coding-run-executions",
      run: async () => {
        const result = await reconcileCodingRuns({
          artifactStore: new GoogleCodingArtifactStore(),
          inspectExecution: createCloudRunExecutionInspector(),
          queuePublisher: (companyId, runId) => queueCodingPublisher({ companyId, runId }),
        });
        if (result.failures) {
          throw new Error(`${result.failures} coding run reconciliation check(s) failed`);
        }
      },
    },
  ]),
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

export const syncScheduledSources = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Europe/Prague",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 0,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      googleConnectorClientSecret,
      microsoftConnectorClientSecret,
      githubAppPrivateKey,
    ],
  },
  async () => runScheduledTasks([
    {
      name: "google-calendar",
      run: async () => logFailures(
        "Google Calendar connections",
        await syncAllGoogleCalendarConnections(googleConnectorConfiguration()),
      ),
    },
    {
      name: "google-drive",
      run: async () => logFailures(
        "Google Drive connections",
        await syncAllGoogleDriveConnections(googleConnectorConfiguration()),
      ),
    },
    {
      name: "google-mail",
      run: async () => logFailures(
        "Google Mail connections",
        await syncAllGoogleGmailConnections(googleConnectorConfiguration()),
      ),
    },
    {
      name: "outlook-mail",
      run: async () => logFailures(
        "Outlook Mail connections",
        await syncAllMicrosoftOutlookConnections(microsoftConnectorConfiguration()),
      ),
    },
    {
      name: "outlook-calendar",
      run: async () => logFailures(
        "Outlook Calendar connections",
        await syncAllMicrosoftOutlookCalendarConnections(microsoftConnectorConfiguration()),
      ),
    },
    {
      name: "github",
      run: async () => logFailures(
        "GitHub connections",
        await syncAllGitHubConnections({
          configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
        }),
      ),
    },
  ]),
);

export const runScheduledMaintenance = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "Europe/Prague",
    region: "europe-west3",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 0,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      microsoftConnectorClientSecret,
    ],
  },
  async () => {
    const tasks: ScheduledTask[] = [{
      name: "conversation-retention",
      run: async () => {
        const migration = await backfillLegacyConversationRetentionMetadata();
        const result = await redactExpiredConversationContent();
        if (migration.examined || result.redacted) {
          console.info("Applied conversation retention maintenance", { migration, ...result });
        }
      },
    }];

    const pragueHour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Prague",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()));
    if (pragueHour === 0 || pragueHour === 12) {
      tasks.push({
        name: "outlook-subscriptions",
        run: async () => logFailures(
          "Outlook subscriptions",
          await ensureAllMicrosoftOutlookSubscriptions(microsoftConnectorConfiguration()),
        ),
      });
    }
    await runScheduledTasks(tasks);
  },
);
