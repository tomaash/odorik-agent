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
 * Closed default used by isolated descriptor tests. Production wires the
 * provider router.
 */
export class MailDraftExecutionUnavailableError extends Error {
  constructor() {
    super(
      "Creating an email draft is unavailable. The proposal records the "
      + "exact effect; no provider was contacted.",
    );
    this.name = "MailDraftExecutionUnavailableError";
  }
}

/**
 * The provider-neutral `mail.draft.create` proposal and executor.
 *
 * Registered so `requestWorkflowActionApproval` can produce a digest and card.
 * Execution creates one Gmail or Outlook draft when the selected connection has
 * its provider-specific draft grant. Sending is never called.
 */
export function createMailDraftCreateDescriptor(
  /**
   * Production wires `createProviderMailDraftExecutor()` from the action
   * registry. The default refuses so unit tests never touch a provider.
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
      providerCapabilityId: "mail.drafts.write",
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
        || !["google_workspace", "microsoft_365"].includes(String(connectionData.connectorId))
        || !["active", "attention"].includes(String(connectionData.status))
        || String(connectionData.accountLabel || "") !== action.mailboxAddress
        || String(connectionData.providerAccountId || "") !== action.providerAccountId
      ) throw new Error("The mail connection for this mailbox is not active");

      const draftWriteData = draftWrite.data() || {};
      if (
        !draftWrite.exists
        || draftWriteData.capabilityId !== "action.mail.draft.create"
        || !["permission_granted", "active", "attention"].includes(String(draftWriteData.status))
      ) {
        throw new Error(
          "Draft creation is not enabled on this connection. "
          + "Grant the provider draft permission under Sources first.",
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
