import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  caseCreateActionSchema,
  caseMoveActionSchema,
  taskCreateActionSchema,
  type ActionSource,
} from "./contracts.js";
import type {
  ActionDescriptor,
  ActionPreconditionContext,
  ActionScope,
  ApprovedActionExecutionContext,
} from "./registry.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { createTask } from "../tasks/repository.js";
import {
  createCase,
  moveCase,
  pipelineStage,
} from "../pipeline/repository.js";

type TaskCreateAction = z.infer<typeof taskCreateActionSchema>;
type CaseCreateAction = z.infer<typeof caseCreateActionSchema>;
type CaseMoveAction = z.infer<typeof caseMoveActionSchema>;

const taskCreateResultSchema = z.object({
  taskId: z.string().min(1),
}).strict();

const caseCreateResultSchema = z.object({
  caseId: z.string().min(1),
}).strict();

const caseMoveResultSchema = z.object({
  caseId: z.string().min(1),
  movementId: z.string().min(1),
  stageId: z.string().min(1),
  revision: z.number().int().nonnegative(),
}).strict();

function scope(input: {
  contactId?: string | null;
  callId: string;
  caseId?: string | null;
}): ActionScope {
  return {
    contactId: input.contactId || null,
    callId: input.callId,
    caseId: input.caseId || null,
  };
}

function approvedSource(
  context: ApprovedActionExecutionContext,
): ActionSource & { approvalId: string; approvedBy: string } {
  return {
    ...context.source,
    approvalId: context.approvalId,
    approvedBy: context.approvedBy,
  };
}

function workflowApprovedSource(
  context: ApprovedActionExecutionContext,
): Extract<ActionSource, { kind: "workflow" }> & { approvalId: string; approvedBy: string } {
  if (context.source.kind !== "workflow") {
    throw new Error("This action requires workflow provenance.");
  }
  return { ...context.source, approvalId: context.approvalId, approvedBy: context.approvedBy };
}

async function assertTaskPreconditions(
  context: ActionPreconditionContext,
  action: TaskCreateAction,
): Promise<void> {
  if (!action.caseId) return;
  const linkedCaseRef = context.database.doc(
    companyDocumentPath(context.companyId, "cases", action.caseId),
  );
  const matchingSubject = action.subject?.kind === "matching_case"
    ? action.subject
    : null;
  const matchingCasesQuery = matchingSubject
    && action.contactId
    ? context.database.collection(
      companyCollectionPath(context.companyId, "cases"),
    ).where("contactId", "==", action.contactId)
    : null;
  const linkedCase = matchingCasesQuery
    ? null
    : await context.transaction.get(linkedCaseRef);
  const matchingCases = matchingCasesQuery
    ? await context.transaction.get(matchingCasesQuery)
    : null;
  const selectedCase = matchingCases
    ? matchingCases.docs.find((document) => document.id === action.caseId) || null
    : linkedCase;
  const activeMatches = matchingCases?.docs.filter((document) => {
    const data = document.data();
    return data.objectType === "case"
      && data.archived !== true
      && String(data.pipelineId || "default") === matchingSubject?.pipelineId
      && data.stageId === matchingSubject?.stageId;
  });
  if (
    !selectedCase?.exists
    || selectedCase.data()?.objectType !== "case"
    || selectedCase.data()?.archived === true
    || selectedCase.data()?.contactId !== action.contactId
    || (
      matchingSubject
      && (
        activeMatches?.length !== 1
        || activeMatches[0]?.id !== action.caseId
      )
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The task's selected case is no longer an active unique match.",
    });
  }
}

async function assertCaseMovePreconditions(
  context: ActionPreconditionContext,
  action: CaseMoveAction,
): Promise<void> {
  const linkedCase = await context.transaction.get(context.database.doc(
    companyDocumentPath(context.companyId, "cases", action.caseId),
  ));
  if (
    !linkedCase.exists
    || linkedCase.data()?.objectType !== "case"
    || linkedCase.data()?.archived === true
    || linkedCase.data()?.contactId !== action.contactId
    || String(linkedCase.data()?.pipelineId || "default") !== action.pipelineId
    || linkedCase.data()?.stageId !== action.fromStageId
    || Number(linkedCase.data()?.revision || 0) !== action.expectedRevision
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The selected case changed before the approval could be requested.",
    });
  }
}

export const taskCreateDescriptor: ActionDescriptor<
  TaskCreateAction,
  z.infer<typeof taskCreateResultSchema>
> = {
  kind: "task.create",
  capabilityId: "action.task.create",
  contractVersion: 1,
  category: "company.write",
  inputSchema: taskCreateActionSchema,
  resultSchema: taskCreateResultSchema,
  authorization: { requiresApproval: true },
  reversibility: "compensatable",
  idempotency: "deterministic_internal",
  reconciliation: "deterministic_lookup",
  async prepareForApproval(context, action) {
    const assignee = await context.resolveActiveMember(
      context.companyId,
      action.assigneeUid,
    );
    return { ...action, assigneeName: assignee.displayName };
  },
  assertRequestPreconditions: assertTaskPreconditions,
  scope: (action) => scope({
    contactId: action.contactId,
    callId: action.callId,
    caseId: action.caseId,
  }),
  async execute(context, action) {
    await createTask({
      companyId: context.companyId,
      actorUid: context.actorUid,
      title: action.title,
      instructions: action.instructions || undefined,
      assigneeUid: action.assigneeUid,
      dueAt: action.dueAt,
      contactId: action.contactId,
      caseId: action.caseId,
      callId: action.callId,
      source: approvedSource(context),
      context: action.context,
      access: context.access,
      deterministicId: action.taskId,
    });
    return { taskId: action.taskId };
  },
  resultId: (action) => action.taskId,
  resultReference: (action) => ({ kind: "task", id: action.taskId }),
  classifyFailure: () => "failed_safe_to_retry",
};

export const caseCreateDescriptor: ActionDescriptor<
  CaseCreateAction,
  z.infer<typeof caseCreateResultSchema>
> = {
  kind: "case.create",
  capabilityId: "action.case.create",
  contractVersion: 1,
  category: "company.write",
  inputSchema: caseCreateActionSchema,
  resultSchema: caseCreateResultSchema,
  authorization: { requiresApproval: true },
  reversibility: "compensatable",
  idempotency: "deterministic_internal",
  reconciliation: "deterministic_lookup",
  async prepareForApproval(context, action) {
    const [owner, stage] = await Promise.all([
      context.resolveActiveMember(context.companyId, action.ownerUid),
      pipelineStage(context.companyId, action.stageId),
    ]);
    return {
      ...action,
      ownerName: owner.displayName,
      stageName: stage.name,
    };
  },
  async assertRequestPreconditions() {},
  scope: (action) => scope({
    contactId: action.contactId,
    callId: action.callId,
  }),
  async execute(context, action) {
    await createCase({
      companyId: context.companyId,
      actorUid: context.actorUid,
      title: action.title,
      contactId: action.contactId,
      ownerUid: action.ownerUid,
      stageId: action.stageId,
      callId: action.callId,
      source: workflowApprovedSource(context),
      access: context.access,
      deterministicId: action.caseId,
    });
    return { caseId: action.caseId };
  },
  resultId: (action) => action.caseId,
  resultReference: (action) => ({ kind: "case", id: action.caseId }),
  classifyFailure: () => "failed_safe_to_retry",
};

export const caseMoveDescriptor: ActionDescriptor<
  CaseMoveAction,
  z.infer<typeof caseMoveResultSchema>
> = {
  kind: "case.move",
  capabilityId: "action.case.move",
  contractVersion: 1,
  category: "company.write",
  inputSchema: caseMoveActionSchema,
  resultSchema: caseMoveResultSchema,
  authorization: { requiresApproval: true },
  reversibility: "compensatable",
  idempotency: "deterministic_internal",
  reconciliation: "deterministic_lookup",
  async prepareForApproval(context, action) {
    const [from, to] = await Promise.all([
      pipelineStage(context.companyId, action.fromStageId),
      pipelineStage(context.companyId, action.toStageId),
    ]);
    return {
      ...action,
      fromStageName: from.name,
      toStageName: to.name,
    };
  },
  assertRequestPreconditions: assertCaseMovePreconditions,
  scope: (action) => scope({
    contactId: action.contactId,
    callId: action.callId,
    caseId: action.caseId,
  }),
  async execute(context, action) {
    const moved = await moveCase({
      companyId: context.companyId,
      actorUid: context.actorUid,
      caseId: action.caseId,
      stageId: action.toStageId,
      expectedRevision: action.expectedRevision,
      expectedStageId: action.fromStageId,
      movementId: action.movementId,
      authorization: {
        approvalId: context.approvalId,
        approvedBy: context.approvedBy,
      },
    }) as { stageId?: unknown; revision?: unknown };
    return {
      caseId: action.caseId,
      movementId: action.movementId,
      stageId: typeof moved.stageId === "string"
        ? moved.stageId
        : action.toStageId,
      revision: Number.isInteger(Number(moved.revision))
        ? Number(moved.revision)
        : action.expectedRevision + 1,
    };
  },
  resultId: (action) => action.caseId,
  resultReference: (action) => ({
    kind: "case_movement",
    id: action.movementId,
  }),
  classifyFailure: () => "failed_safe_to_retry",
};

export const internalActionDescriptors = [
  taskCreateDescriptor,
  caseCreateDescriptor,
  caseMoveDescriptor,
] as const;
