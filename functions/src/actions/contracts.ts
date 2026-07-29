import { createHash } from "node:crypto";
import { z } from "zod";
import { createCase, moveCase } from "../pipeline/repository.js";
import { createTask } from "../tasks/repository.js";

const compactContextSchema = z.object({
  callerName: z.string().nullable().optional(),
  callerPhone: z.string().nullable().optional(),
  callSummary: z.string().nullable().optional(),
  transcriptExcerpt: z.string().nullable().optional(),
}).strict();

const taskSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("internal") }).strict(),
  z.object({ kind: z.literal("contact") }).strict(),
  z.object({
    kind: z.literal("matching_case"),
    pipelineId: z.literal("default"),
    stageId: z.string().min(1),
    stageName: z.string().min(1),
  }).strict(),
]).nullable();

export const workflowActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task.create"),
    taskId: z.string().min(1),
    title: z.string().min(1).max(300),
    instructions: z.string().max(5_000).nullable(),
    assigneeUid: z.string().min(1),
    assigneeName: z.string().min(1),
    dueAt: z.string().datetime().nullable(),
    contactId: z.string().nullable(),
    caseId: z.string().nullable().optional(),
    caseTitle: z.string().min(1).max(300).nullable().optional(),
    callId: z.string().min(1),
    subject: taskSubjectSchema.optional(),
    context: compactContextSchema,
  }).strict(),
  z.object({
    kind: z.literal("case.create"),
    caseId: z.string().min(1),
    title: z.string().min(1).max(300),
    pipelineId: z.literal("default"),
    stageId: z.string().min(1),
    stageName: z.string().min(1),
    ownerUid: z.string().min(1),
    ownerName: z.string().min(1),
    contactId: z.string().min(1),
    callId: z.string().min(1),
    context: compactContextSchema,
  }).strict(),
  z.object({
    kind: z.literal("case.move"),
    movementId: z.string().min(1),
    caseId: z.string().min(1),
    caseTitle: z.string().min(1),
    pipelineId: z.literal("default"),
    fromStageId: z.string().min(1),
    fromStageName: z.string().min(1),
    toStageId: z.string().min(1),
    toStageName: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    contactId: z.string().min(1),
    callId: z.string().min(1),
    context: compactContextSchema,
  }).strict(),
]).superRefine((action, context) => {
  if (action.kind !== "task.create" || !action.subject) return;
  if (action.subject.kind === "internal" && (action.contactId || action.caseId)) {
    context.addIssue({
      code: "custom",
      message: "An internal task cannot target a contact or case",
    });
  }
  if (action.subject.kind === "contact" && (!action.contactId || action.caseId)) {
    context.addIssue({
      code: "custom",
      message: "A contact task requires a contact and cannot target a case",
    });
  }
  if (
    action.subject.kind === "matching_case"
    && (!action.contactId || !action.caseId || !action.caseTitle)
  ) {
    context.addIssue({
      code: "custom",
      message: "A case task requires the matched case, its title, and its contact",
    });
  }
});

export type WorkflowAction = z.infer<typeof workflowActionSchema>;

export type WorkflowActionSource = {
  kind: "workflow";
  callId: string;
  workflowId: string;
  workflowVersion: number;
  runId: string;
  blockId: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function actionEffectDigest(action: WorkflowAction): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(action)))
    .digest("hex");
}

export function legacyActionEffectDigest(action: WorkflowAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

export function parseWorkflowAction(value: unknown): WorkflowAction {
  return workflowActionSchema.parse(value);
}

export async function executeWorkflowAction(input: {
  companyId: string;
  actorUid: string;
  approvalId: string;
  action: WorkflowAction;
  source: WorkflowActionSource;
}) {
  const authorization = {
    ...input.source,
    approvalId: input.approvalId,
    approvedBy: input.actorUid,
  };
  if (input.action.kind === "task.create") {
    const task = await createTask({
      companyId: input.companyId,
      actorUid: input.actorUid,
      title: input.action.title,
      instructions: input.action.instructions || undefined,
      assigneeUid: input.action.assigneeUid,
      dueAt: input.action.dueAt,
      contactId: input.action.contactId,
      caseId: input.action.caseId,
      callId: input.action.callId,
      source: authorization,
      context: input.action.context,
      deterministicId: input.action.taskId,
    });
    return { kind: input.action.kind, resultId: input.action.taskId, result: task };
  }
  if (input.action.kind === "case.create") {
    const created = await createCase({
      companyId: input.companyId,
      actorUid: input.actorUid,
      title: input.action.title,
      contactId: input.action.contactId,
      ownerUid: input.action.ownerUid,
      stageId: input.action.stageId,
      callId: input.action.callId,
      source: authorization,
      deterministicId: input.action.caseId,
    });
    return { kind: input.action.kind, resultId: input.action.caseId, result: created };
  }
  const moved = await moveCase({
    companyId: input.companyId,
    actorUid: input.actorUid,
    caseId: input.action.caseId,
    stageId: input.action.toStageId,
    expectedRevision: input.action.expectedRevision,
    expectedStageId: input.action.fromStageId,
    movementId: input.action.movementId,
    authorization: {
      approvalId: input.approvalId,
      approvedBy: input.actorUid,
    },
  });
  return { kind: input.action.kind, resultId: input.action.caseId, result: moved };
}
