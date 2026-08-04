import { z } from "zod";

import type {
  ActionDescriptor,
  ApprovedActionExecutionContext,
} from "../actions/registry.js";
import { mailDraftCreateActionSchema } from "../actions/contracts.js";

export type MailDraftCreateAction = z.infer<typeof mailDraftCreateActionSchema>;

const mailDraftCreatedResultSchema = z.object({
  draftId: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  deepLink: z.string().min(1),
}).strict();

export type MailDraftCreatedResult = z.infer<typeof mailDraftCreatedResultSchema>;

export type MailDraftExecutor = (
  context: ApprovedActionExecutionContext,
  action: MailDraftCreateAction,
) => Promise<MailDraftCreatedResult>;

/**
 * Thrown by the default executor for as long as the product holds no Gmail
 * write scope. It is a deliberate dead end, not a bug: G2 proves the proposal
 * is exact, and G3 supplies the executor that makes it real.
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
 * The `mail.draft.create` proposal.
 *
 * Registered, and therefore approvable, because `requestWorkflowActionApproval`
 * resolves every action through the registry — an unregistered kind cannot
 * produce an approval record, a digest, or a decision card. What keeps this
 * slice non-executing is the executor: the default one refuses, so approving
 * lands the approval in `execution_failed` / `failed_safe_to_retry` having
 * touched no provider. G3 injects a real executor and nothing else about the
 * record shape changes.
 *
 * The registry requires `external.write` actions to declare a provider
 * capability, provider-aware idempotency and reconciliation before retry. Those
 * are declared honestly here for the effect this action *names*, even though no
 * scope is granted yet — `draftRequestId` is the idempotency key G3 will send.
 */
export function createMailDraftCreateDescriptor(
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
    // A draft is deletable, so the effect can be compensated.
    reversibility: "compensatable",
    idempotency: "provider_aware",
    reconciliation: "required_before_retry",

    /**
     * Rewrite the mailbox from the connection rather than trusting what the
     * workflow carried, so the digest binds the address Gmail would actually
     * send from. Same reasoning as the task action rewriting the assignee name.
     */
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
     * Re-proved inside the approval transaction: the mailbox is still connected
     * and mail is still enabled on it, and every cited source still reads
     * exactly as it did when the draft was composed.
     */
    async assertRequestPreconditions(context, action) {
      const connectionRef = context.database.doc(
        `companies/${context.companyId}/connections/${action.connectionId}`,
      );
      const [connection, capability, ...evidence] = await Promise.all([
        context.transaction.get(connectionRef),
        context.transaction.get(connectionRef.collection("capabilities").doc("mail")),
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

      const capabilityData = capability.data() || {};
      if (
        !capability.exists
        || capabilityData.capabilityId !== "context.mail.read_scoped"
        || !["active", "attention"].includes(String(capabilityData.status))
      ) throw new Error("Mail is not enabled on this connection");

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
    // Nothing has been sent, so a later attempt is always safe.
    classifyFailure: () => "failed_safe_to_retry",
  };
}

export const mailDraftCreateDescriptor = createMailDraftCreateDescriptor();

export const mailActionDescriptors = [mailDraftCreateDescriptor];
