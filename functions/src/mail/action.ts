import { z } from "zod";

import type {
  ActionDescriptor,
} from "../actions/registry.js";
import { mailDraftCreateActionSchema } from "../actions/contracts.js";
import {
  MailDraftOutcomeUnknownError,
  MailDraftWriteGrantMissingError,
  type MailDraftCreateAction,
  type MailDraftCreatedResult,
  type MailDraftExecutor,
} from "./executor.js";

export type { MailDraftCreateAction, MailDraftCreatedResult, MailDraftExecutor };

const mailDraftCreatedResultSchema = z.object({
  draftId: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  deepLink: z.string().min(1),
}).strict();

/**
 * Kept for tests that still assert the G2 closed-executor shape. Production
 * wires `createGmailDraftExecutor`.
 */
export class MailDraftExecutionUnavailableError extends Error {
  constructor() {
    super(
      "Creating the Gmail draft is not available yet. The proposal records the "
      + "exact effect; nothing was sent to Google.",
    );
    this.name = "MailDraftExecutionUnavailableError";
  }
}

/**
 * The `mail.draft.create` proposal and G3 executor.
 *
 * Registered so `requestWorkflowActionApproval` can produce a digest and card.
 * Execution creates one Gmail draft when `action.mail.draft.create` is granted
 * on the Workspace connection (`gmail.compose` scope). Sending is never called.
 */
export function createMailDraftCreateDescriptor(
  /**
   * Production wires `createGmailDraftExecutor()` from the action registry.
   * The default refuses so unit tests never touch Google by accident.
   */
  executeAction: MailDraftExecutor = async () => {
    throw new MailDraftExecutionUnavailableError();
  },
): ActionDescriptor<MailDraftCreateAction, MailDraftCreatedResult> {
  return {
    kind: "mail.draft.create",
    capabilityId: "action.mail.draft.create",
    contractVersion: 1,
    category: "external.write",
    inputSchema: mailDraftCreateActionSchema,
    resultSchema: mailDraftCreatedResultSchema,
    authorization: {
      requiresApproval: true,
      providerCapabilityId: "google.gmail.drafts.write",
    },
    reversibility: "compensatable",
    idempotency: "provider_aware",
    reconciliation: "required_before_retry",

    async prepareForApproval(context, action) {
      const connection = await context.database
        .doc(`companies/${context.companyId}/connections/${action.connectionId}`)
        .get();
      const data = connection.data() || {};
      const mailboxAddress = String(data.accountLabel || "").trim();
      const providerAccountId = String(data.providerAccountId || "").trim();
      if (!connection.exists || !mailboxAddress || !providerAccountId) {
        throw new Error("The mailbox for this draft is no longer available");
      }
      return { ...action, mailboxAddress, providerAccountId };
    },

    /**
     * Mailbox must still be connected; draft-write grant must be active; cited
     * evidence must be unchanged. Mail *read* is not required to create a draft
     * from a literal recipient — write grant is.
     */
    async assertRequestPreconditions(context, action) {
      const connectionRef = context.database.doc(
        `companies/${context.companyId}/connections/${action.connectionId}`,
      );
      const [connection, draftWrite, ...evidence] = await Promise.all([
        context.transaction.get(connectionRef),
        context.transaction.get(connectionRef.collection("capabilities").doc("mail_draft")),
        ...action.evidence.map((reference) => context.transaction.get(
          context.database.doc(
            `companies/${context.companyId}/contextItems/${reference.contextItemId}`,
          ),
        )),
      ]);

      const connectionData = connection.data() || {};
      if (
        !connection.exists
        || connectionData.connectorId !== "google_workspace"
        || !["active", "attention"].includes(String(connectionData.status))
        || String(connectionData.accountLabel || "") !== action.mailboxAddress
        || String(connectionData.providerAccountId || "") !== action.providerAccountId
      ) throw new Error("The Google Workspace connection for this mailbox is not active");

      const draftWriteData = draftWrite.data() || {};
      if (
        !draftWrite.exists
        || draftWriteData.capabilityId !== "action.mail.draft.create"
        || !["active", "attention"].includes(String(draftWriteData.status))
      ) {
        throw new Error(
          "Gmail draft creation is not enabled on this connection. "
          + "Grant “Create Gmail drafts” under Sources first.",
        );
      }

      action.evidence.forEach((reference, index) => {
        const snapshot = evidence[index];
        const data = snapshot?.data() || {};
        if (
          !snapshot?.exists
          || String(data.source?.version || "") !== reference.version
          || String(data.provenance?.checksum || "") !== reference.checksum
        ) throw new Error("Evidence for this draft changed before approval could be requested");
      });
    },

    scope: (action) => ({
      contactId: action.contactId,
      callId: action.callId,
      caseId: null,
    }),

    execute: executeAction,
    resultId: (_action, result) => result.draftId,
    resultReference: (_action, result) => ({ kind: "mail_draft", id: result.draftId }),
    classifyFailure: (error) => {
      if (
        error instanceof MailDraftOutcomeUnknownError
        || (error instanceof Error && error.name === "MailDraftOutcomeUnknownError")
      ) {
        return "outcome_unknown";
      }
      // Missing grant / validation: safe to fix grant and retry.
      if (
        error instanceof MailDraftWriteGrantMissingError
        || error instanceof MailDraftExecutionUnavailableError
      ) {
        return "failed_safe_to_retry";
      }
      return "failed_safe_to_retry";
    },
  };
}

export const mailDraftCreateDescriptor = createMailDraftCreateDescriptor();

export const mailActionDescriptors = [mailDraftCreateDescriptor];
