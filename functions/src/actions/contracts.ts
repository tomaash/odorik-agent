import { createHash } from "node:crypto";
import { z } from "zod";

const compactContextSchema = z.object({
  callerName: z.string().nullable().optional(),
  callerPhone: z.string().nullable().optional(),
  callSummary: z.string().nullable().optional(),
  transcriptExcerpt: z.string().nullable().optional(),
}).strict();

export const taskSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("internal") }).strict(),
  z.object({ kind: z.literal("contact") }).strict(),
  z.object({
    kind: z.literal("matching_case"),
    pipelineId: z.literal("default"),
    stageId: z.string().min(1),
    stageName: z.string().min(1),
  }).strict(),
]).nullable();

export const taskCreateActionSchema = z.object({
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
}).strict().superRefine((action, context) => {
  if (!action.subject) return;
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

export const caseCreateActionSchema = z.object({
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
}).strict();

export const caseMoveActionSchema = z.object({
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
}).strict();

/**
 * A cited source the draft was derived from. Version and checksum are pinned so
 * the approval transaction can prove the evidence has not moved underneath the
 * proposal, exactly as the coding action pins its issue.
 */
export const mailEvidenceReferenceSchema = z.object({
  contextItemId: z.string().min(1),
  version: z.string().min(1),
  checksum: z.string().min(1),
}).strict();

/**
 * Every field here can reach Gmail, and `actionEffectDigest` hashes the whole
 * object — so this schema *is* the disclosed effect. Nothing that would change
 * what the provider receives may live outside it.
 */
export const mailDraftCreateActionSchema = z.object({
  kind: z.literal("mail.draft.create"),
  draftRequestId: z.string().min(1),
  connectionId: z.string().min(1),
  mailboxAddress: z.string().min(3).max(320),
  providerAccountId: z.string().min(1),
  // One recipient. A draft that could reach a list is a different, larger effect.
  to: z.array(z.string().min(3).max(320)).length(1),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50_000),
  threadId: z.string().nullable(),
  inReplyToRfc822MessageId: z.string().nullable(),
  evidence: z.array(mailEvidenceReferenceSchema).max(20),
  contactId: z.string().nullable(),
  callId: z.string().min(1),
  context: compactContextSchema,
}).strict();

export const workflowActionSchema = z.union([
  taskCreateActionSchema,
  caseCreateActionSchema,
  caseMoveActionSchema,
  mailDraftCreateActionSchema,
]);

export type WorkflowAction = z.infer<typeof workflowActionSchema>;

type WorkflowSourceBase = {
  kind: "workflow";
  workflowId: string;
  workflowVersion: number;
  runId: string;
  blockId: string;
};

export type WorkflowActionSource = WorkflowSourceBase & (
  | { callId: string; issueContextItemId?: never }
  | { issueContextItemId: string; callId?: never }
);

/**
 * A proposal prepared from a member-owned conversation rather than a saved
 * workflow. The message and session identities are immutable provenance; they
 * do not authorize execution. The normal named-approver decision still does.
 */
export type ConversationActionSource = {
  kind: "conversation";
  surface: "slack_dm" | "teams_personal";
  threadId: string;
  sessionId: string;
  messageId: string;
  callId: string;
  proposalRootId?: string;
  proposalVersion?: number;
  supersedesApprovalId?: string;
};

export type ActionSource = WorkflowActionSource | ConversationActionSource;

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

export function actionEffectDigest(action: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(action)))
    .digest("hex");
}

export function legacyActionEffectDigest(action: unknown): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

export function parseWorkflowAction(value: unknown): WorkflowAction {
  return workflowActionSchema.parse(value);
}
