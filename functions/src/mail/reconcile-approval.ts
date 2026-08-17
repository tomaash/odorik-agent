import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";

import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { reconcileMailDraftExecution } from "./executor.js";
import { reconcileOutlookDraftExecution } from "./outlook-executor.js";

/**
 * Operator path for `outcome_unknown` mail draft approvals: discover the draft
 * if the provider already created it, attach IDs to the approval, and clear the
 * unknown state without a second create.
 */
export async function reconcileMailDraftApproval(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  clientId: string;
  clientSecret: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  credentialKey: string;
}) {
  const approvalRef = db.doc(
    companyDocumentPath(input.companyId, "actionApprovals", input.approvalId),
  );
  const snapshot = await approvalRef.get();
  if (!snapshot.exists) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Approval not found" });
  }
  const data = snapshot.data() || {};
  if (data.approverUid !== input.actorUid) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the named approver can reconcile this draft.",
    });
  }
  if (
    data.status !== "execution_failed"
    || data.executionStatus !== "outcome_unknown"
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This approval is not waiting for draft reconciliation.",
    });
  }
  const action = data.action as {
    kind?: string;
    draftRequestId?: string;
    connectionId?: string;
  } | undefined;
  if (
    action?.kind !== "mail.draft.create"
    || !action.draftRequestId
    || !action.connectionId
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This approval is not an email draft.",
    });
  }

  let result;
  try {
    const connection = await db.doc(companyDocumentPath(
      input.companyId, "connections", action.connectionId,
    )).get();
    const isMicrosoft = connection.data()?.connectorId === "microsoft_365";
    const reconcile = isMicrosoft ? reconcileOutlookDraftExecution : reconcileMailDraftExecution;
    result = await reconcile({
      companyId: input.companyId,
      draftRequestId: action.draftRequestId,
      connectionId: action.connectionId,
      actorUid: input.actorUid,
      auth: {
        clientId: isMicrosoft ? input.microsoftClientId || input.clientId : input.clientId,
        clientSecret: isMicrosoft
          ? input.microsoftClientSecret || input.clientSecret
          : input.clientSecret,
        credentialKey: input.credentialKey,
      },
    });
  } catch (error) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const now = Timestamp.now();
  const auditRef = db.collection(
    companyCollectionPath(input.companyId, "auditEvents"),
  ).doc();
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(approvalRef);
    if (
      latest.data()?.status !== "execution_failed"
      || latest.data()?.executionStatus !== "outcome_unknown"
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "A newer attempt replaced this reconciliation.",
      });
    }
    transaction.update(approvalRef, {
      status: "approved",
      decisionStatus: "approved",
      executionStatus: "succeeded",
      resultId: result.draftId,
      result: { kind: "mail_draft", id: result.draftId },
      executionResult: result,
      executedAt: now,
      executionError: null,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      aggregateType: "action_approval",
      aggregateId: input.approvalId,
      type: "approval_mail_draft_reconciled",
      access: latest.data()?.access || { visibility: "company" },
      actor: { kind: "user", id: input.actorUid },
      after: {
        executionStatus: "succeeded",
        resultId: result.draftId,
        draftId: result.draftId,
        messageId: result.messageId,
      },
      createdAt: now,
    });
  });

  return jsonSafe({
    id: input.approvalId,
    status: "approved",
    resultId: result.draftId,
    executionResult: result,
  });
}
