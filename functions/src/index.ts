import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { api } from "./api.js";
import { processCompletedCall, shouldProcessCallUpdate } from "./crm/process.js";
import { geminiApiKey } from "./router.js";

export { api };

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const processCallCrm = onDocumentUpdated(
  {
    document: "calls/{callId}",
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
      callId: event.params.callId,
      apiKey: geminiApiKey.value(),
    });
  },
);
