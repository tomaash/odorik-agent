import { db } from "../firestore.js";
import type { MailDraftExecutor } from "./executor.js";
import { createGmailDraftExecutor } from "./executor.js";
import { createOutlookDraftExecutor } from "./outlook-executor.js";

export function createProviderMailDraftExecutor(
  options: {
    database?: FirebaseFirestore.Firestore;
    gmail?: MailDraftExecutor;
    outlook?: MailDraftExecutor;
  } = {},
): MailDraftExecutor {
  const database = options.database || db;
  const gmail = options.gmail || createGmailDraftExecutor(undefined, { database });
  const outlook = options.outlook || createOutlookDraftExecutor(undefined, { database });
  return async (context, action) => {
    const connection = await database.doc(
      `companies/${context.companyId}/connections/${action.connectionId}`,
    ).get();
    const connectorId = String(connection.data()?.connectorId || "");
    if (connectorId === "google_workspace") return gmail(context, action);
    if (connectorId === "microsoft_365") return outlook(context, action);
    throw new Error("The selected mail provider does not support draft creation");
  };
}
