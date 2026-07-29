import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import {
  previewWorkflow,
  type ActionSkip,
  type ActionPreview,
  type CallTaskContext,
  type WorkflowSpec,
} from "@agent-erik/workflow";
import { db, jsonSafe, timestampToIso } from "../firestore.js";
import { normalizePhone } from "../phone.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { requestWorkflowActionApproval } from "../approvals/repository.js";
import { getPipeline } from "../pipeline/repository.js";
import type { WorkflowAction } from "../actions/contracts.js";
import { enabledWorkflows, workflowVersion } from "./repository.js";

type CallRecord = {
  status?: string;
  from?: string | null;
  contactId?: string | null;
  odorikTime?: string | null;
  transcript?: string | null;
  summary?: string | null;
  durationSeconds?: number | null;
  segments?: Array<{ speaker?: string; text?: string; startSeconds?: number }>;
  uploadedAt?: unknown;
  processedAt?: unknown;
};

type ResolvedCall = {
  callId: string;
  call: CallRecord;
  contact: {
    id: string;
    displayName?: string;
    phoneE164?: string;
    phoneRaw?: string;
  } | null;
  context: CallTaskContext;
};

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 28)}`;
}

async function resolveCall(companyId: string, callId: string): Promise<ResolvedCall> {
  const callSnapshot = await db.doc(companyDocumentPath(companyId, "calls", callId)).get();
  if (!callSnapshot.exists) throw new Error(`Call ${callId} not found.`);
  const call = callSnapshot.data() as CallRecord;
  if (call.status !== "completed") throw new Error(`Call ${callId} is not completed.`);
  let contactSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
  if (call.contactId) {
    contactSnapshot = await db.doc(companyDocumentPath(companyId, "contacts", call.contactId)).get();
  } else {
    const normalized = normalizePhone(call.from);
    const matching = normalized
      ? await db.collection(companyCollectionPath(companyId, "contacts"))
        .where("phoneE164", "==", normalized)
        .limit(1)
        .get()
      : null;
    contactSnapshot = matching?.docs[0] || null;
  }
  const contact = contactSnapshot?.exists
    ? {
        id: contactSnapshot.id,
        ...(contactSnapshot.data() as {
          displayName?: string;
          phoneE164?: string;
          phoneRaw?: string;
        }),
      }
    : null;
  const firstSegment = call.segments?.find((segment) => segment.text?.trim());
  const callerPhone = contact?.phoneE164
    || contact?.phoneRaw
    || normalizePhone(call.from)
    || call.from
    || null;
  const transcriptText = call.transcript?.trim()
    || call.segments
      ?.map((segment) => segment.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join("\n")
    || null;
  const [pipeline, relatedCases] = contact
    ? await Promise.all([
        getPipeline(companyId),
        db.collection(companyCollectionPath(companyId, "cases"))
          .where("contactId", "==", contact.id)
          .limit(50)
          .get(),
      ])
    : [null, null];
  const stageNames = new Map(pipeline?.stages.map((stage) => [stage.id, stage.name]));
  return {
    callId,
    call,
    contact,
    context: {
      callerName: contact?.displayName || null,
      callerPhone,
      callSummary: call.summary || null,
      transcriptExcerpt: firstSegment?.text?.trim() || call.transcript?.slice(0, 500) || null,
      callDurationSeconds: Number.isFinite(call.durationSeconds)
        ? Number(call.durationSeconds)
        : null,
      callerHasContact: Boolean(contact),
      transcriptText,
      cases: relatedCases?.docs
        .filter((document) => document.data().archived !== true)
        .map((document) => ({
          id: document.id,
          title: String(document.data().title || "Untitled case"),
          pipelineId: String(document.data().pipelineId || "default"),
          stageId: String(document.data().stageId || ""),
          stageName: stageNames.get(String(document.data().stageId || "")) || "Unknown stage",
          revision: Number(document.data().revision || 0),
        })) || [],
    },
  };
}

function actionPayload(input: {
  preview: ActionPreview;
  objectId: string;
  contactId: string | null;
  callId: string;
}): WorkflowAction {
  if (input.preview.kind === "task.create") {
    const explicitInternal = input.preview.subject?.kind === "internal";
    return {
      kind: "task.create",
      taskId: input.objectId,
      title: input.preview.title,
      instructions: input.preview.instructions,
      assigneeUid: input.preview.assigneeUid,
      assigneeName: input.preview.assigneeName,
      dueAt: input.preview.dueAt,
      contactId: explicitInternal ? null : input.contactId,
      caseId: input.preview.caseId,
      caseTitle: input.preview.caseTitle,
      callId: input.callId,
      subject: input.preview.subject,
      context: input.preview.context,
    };
  }
  if (!input.contactId) {
    throw new Error("Case actions require a resolved contact.");
  }
  if (input.preview.kind === "case.create") {
    return {
      kind: "case.create",
      caseId: input.objectId,
      title: input.preview.title,
      pipelineId: "default",
      stageId: input.preview.stageId,
      stageName: input.preview.stageName,
      ownerUid: input.preview.ownerUid,
      ownerName: input.preview.ownerName,
      contactId: input.contactId,
      callId: input.callId,
      context: input.preview.context,
    };
  }
  return {
    kind: "case.move",
    movementId: input.objectId,
    caseId: input.preview.caseId,
    caseTitle: input.preview.caseTitle,
    pipelineId: "default",
    fromStageId: input.preview.fromStageId,
    fromStageName: input.preview.fromStageName,
    toStageId: input.preview.toStageId,
    toStageName: input.preview.toStageName,
    expectedRevision: input.preview.expectedRevision,
    contactId: input.contactId,
    callId: input.callId,
    context: input.preview.context,
  };
}

export async function runWorkflowOnCall(input: {
  companyId: string;
  callId: string;
  workflow: { id: string; name: string; version: number; spec: WorkflowSpec };
  now?: Date;
}) {
  const resolved = await resolveCall(input.companyId, input.callId);
  const now = input.now || new Date();
  const preview = previewWorkflow(input.workflow.spec, resolved.context, now);
  const key = `${input.companyId}:${input.workflow.id}:${input.workflow.version}:${input.callId}`;
  const runId = deterministicId("run", key);
  const runRef = db.doc(companyDocumentPath(input.companyId, "workflowRuns", runId));
  const existingRun = await runRef.get();
  if (existingRun.exists) {
    return jsonSafe({ id: runRef.id, ...existingRun.data(), duplicate: true });
  }
  const approvalResults = [];
  const runtimeSkips: ActionSkip[] = [...preview.skippedActions];
  for (const actionPreview of preview.actions) {
    const objectPrefix = actionPreview.kind === "task.create"
      ? "task"
      : actionPreview.kind === "case.create"
        ? "case"
        : "movement";
    const objectId = deterministicId(objectPrefix, `${key}:${actionPreview.blockId}`);
    const approvalId = deterministicId("approval", `${key}:${actionPreview.blockId}`);
    const action = actionPayload({
      preview: actionPreview,
      objectId,
      contactId: resolved.contact?.id || null,
      callId: input.callId,
    });
    try {
      const approval = await requestWorkflowActionApproval({
        companyId: input.companyId,
        actorUid: `workflow:${input.workflow.id}`,
        approvalId,
        approverUid: actionPreview.approverUid,
        approverName: actionPreview.approverName,
        action,
        source: {
          kind: "workflow",
          callId: input.callId,
          workflowId: input.workflow.id,
          workflowVersion: input.workflow.version,
          runId,
          blockId: actionPreview.blockId,
        },
      }) as Record<string, unknown>;
      approvalResults.push({
        approvalId,
        actionKind: action.kind,
        resultId: objectId,
        blockId: actionPreview.blockId,
        title: actionPreview.kind === "case.move"
          ? `${actionPreview.caseTitle}: ${actionPreview.fromStageName} → ${actionPreview.toStageName}`
          : actionPreview.title,
        approverUid: actionPreview.approverUid,
        approverName: actionPreview.approverName,
        duplicate: approval.duplicate === true,
      });
    } catch (error) {
      if (
        !(error instanceof TRPCError)
        || (error.code !== "PRECONDITION_FAILED" && error.code !== "BAD_REQUEST")
      ) {
        throw error;
      }
      runtimeSkips.push({
        blockId: actionPreview.blockId,
        kind: action.kind === "task.create"
          ? "action.task.create"
          : action.kind === "case.create"
            ? "action.case.create"
            : "action.case.move",
        reason: "target_unavailable",
        matches: 0,
      });
    }
  }
  const requestedCount = approvalResults.filter((approval) => !approval.duplicate).length;
  const duplicateCount = approvalResults.length - requestedCount;
  const status = approvalResults.length === 0
    ? "no_actions"
    : requestedCount === 0
      ? "duplicate"
      : "approval_requested";
  const createdAt = Timestamp.now();
  const run = {
    companyId: input.companyId,
    workflowId: input.workflow.id,
    workflowName: input.workflow.name,
    workflowVersion: input.workflow.version,
    schemaVersion: 4,
    trigger: "event.call.transcribed",
    contextId: input.callId,
    status,
    approvalId: approvalResults[0]?.approvalId || null,
    approvalIds: approvalResults.map((approval) => approval.approvalId),
    actionTitles: approvalResults.map((approval) => approval.title),
    approvals: approvalResults,
    requestedCount,
    duplicateCount,
    conditions: preview.conditions,
    skippedActions: runtimeSkips,
    context: preview.actions[0]?.context || {
      callerName: resolved.context.callerName ?? null,
      callerPhone: resolved.context.callerPhone ?? null,
      callSummary: resolved.context.callSummary ?? null,
      transcriptExcerpt: resolved.context.transcriptExcerpt ?? null,
    },
    occurredAt: resolved.call.odorikTime
      || timestampToIso(resolved.call.processedAt)
      || timestampToIso(resolved.call.uploadedAt),
    createdAt,
  };
  try {
    await runRef.create(run);
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code !== 6 && code !== "already-exists") throw error;
  }
  return jsonSafe({ id: runRef.id, ...run, duplicate: status === "duplicate" });
}

export async function runEnabledWorkflowsForCall(input: {
  companyId: string;
  callId: string;
}) {
  const workflows = await enabledWorkflows(input.companyId, 10);
  const results = [];
  for (const workflow of workflows) {
    results.push(await runWorkflowOnCall({ ...input, workflow }));
  }
  return results;
}

export async function dryRunHistory(input: {
  companyId: string;
  workflowId: string;
  spec?: WorkflowSpec;
  limit: number;
}) {
  const workflow = input.spec
    ? { id: input.workflowId, name: input.spec.name, version: 0, spec: input.spec }
    : await workflowVersion(input.companyId, input.workflowId);
  const calls = await db.collection(companyCollectionPath(input.companyId, "calls"))
    .where("status", "==", "completed")
    .limit(Math.min(input.limit, 50))
    .get();
  const results = [];
  for (const call of calls.docs) {
    try {
      const resolved = await resolveCall(input.companyId, call.id);
      const preview = previewWorkflow(workflow.spec, resolved.context);
      const status = preview.actions.length > 0 ? "would_request" : "would_skip";
      results.push({
        callId: call.id,
        occurredAt: call.data().odorikTime || timestampToIso(call.data().processedAt),
        status,
        actions: preview.actions,
        skippedActions: preview.skippedActions,
        conditions: preview.conditions,
      });
    } catch (error) {
      results.push({
        callId: call.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return jsonSafe({
    workflowId: input.workflowId,
    sampleSize: results.length,
    wouldRequest: results.reduce(
      (count, result) => count + ("actions" in result ? result.actions?.length || 0 : 0),
      0,
    ),
    matchedCalls: results.filter((result) => result.status === "would_request").length,
    skipped: results.filter((result) => result.status === "would_skip").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  });
}

export function workflowRuntimeFlags(environment = process.env) {
  return {
    enabled: environment.WORKFLOW_ENGINE_ENABLED !== "false",
  };
}

export async function workflowHealth(companyId: string) {
  const [calls, runs, workflows] = await Promise.all([
    db.collection(companyCollectionPath(companyId, "calls"))
      .orderBy("uploadedAt", "desc")
      .limit(20)
      .get(),
    db.collection(companyCollectionPath(companyId, "workflowRuns"))
      .orderBy("createdAt", "desc")
      .limit(100)
      .get(),
    enabledWorkflows(companyId, 10),
  ]);
  const now = Date.now();
  const recentCalls = calls.docs.filter((document) => {
    const at = document.data().processedAt?.toMillis?.()
      || document.data().uploadedAt?.toMillis?.()
      || Date.parse(String(document.data().odorikTime || ""));
    return Number.isFinite(at) && at > now - 24 * 60 * 60 * 1000;
  }).length;
  const recentRuns = runs.docs.filter((document) => {
    const at = document.data().createdAt?.toMillis?.() || 0;
    return at > now - 24 * 60 * 60 * 1000;
  });
  return {
    ok: !(recentCalls > 0 && workflows.length > 0 && recentRuns.length === 0),
    recentCalls,
    recentRuns: recentRuns.length,
    recentTasks: recentRuns.reduce(
      (count, document) => count + Number(document.data().createdCount
        ?? (document.data().status === "task_created" ? 1 : 0)),
      0,
    ),
    recentApprovalRequests: recentRuns.reduce(
      (count, document) => count + Number(document.data().requestedCount
        ?? (document.data().status === "approval_requested" ? 1 : 0)),
      0,
    ),
    enabledWorkflows: workflows.length,
    warning: recentCalls > 0 && workflows.length > 0 && recentRuns.length === 0
      ? "Calls arrived in the last 24 hours but no workflow approval requests were recorded."
      : null,
  };
}
