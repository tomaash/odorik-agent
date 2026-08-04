import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";

import { db, jsonSafe } from "../firestore.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { reconcileMailDraftExecution } from "./executor.js";

/**
 * Operator path for `outcome_unknown` mail draft approvals: discover the draft
 * if Google already created it, attach IDs to the approval, and clear the
 * unknown state without a second create.
 */
export async function reconcileMailDraftApproval(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  clientId: string;
  clientSecret: string;
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
      message: "This approval is not a Gmail draft.",
    });
  }

  let result;
  try {
    result = await reconcileMailDraftExecution({
      companyId: input.companyId,
      draftRequestId: action.draftRequestId,
      connectionId: action.connectionId,
      actorUid: input.actorUid,
      auth: {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
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
