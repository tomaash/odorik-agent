import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import {
  previewWorkflow,
  type CallTaskContext,
  type WorkflowSpec,
} from "@agent-erik/workflow";
import { db, jsonSafe, timestampToIso } from "../firestore.js";
import { normalizePhone } from "../crm/process.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { requestWorkflowTaskApproval } from "../approvals/repository.js";
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
    },
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
  for (const taskPreview of preview.tasks) {
    const taskId = deterministicId("task", `${key}:${taskPreview.blockId}`);
    const approvalId = deterministicId("approval", `${key}:${taskPreview.blockId}`);
    const approval = await requestWorkflowTaskApproval({
      companyId: input.companyId,
      actorUid: `workflow:${input.workflow.id}`,
      approvalId,
      taskId,
      preview: taskPreview,
      contactId: resolved.contact?.id || null,
      callId: input.callId,
      source: {
        kind: "workflow",
        callId: input.callId,
        workflowId: input.workflow.id,
        workflowVersion: input.workflow.version,
        runId,
        blockId: taskPreview.blockId,
      },
    }) as Record<string, unknown>;
    approvalResults.push({
      approvalId,
      taskId,
      blockId: taskPreview.blockId,
      title: taskPreview.title,
      assigneeUid: taskPreview.assigneeUid,
      assigneeName: taskPreview.assigneeName,
      approverUid: taskPreview.approverUid,
      approverName: taskPreview.approverName,
      dueAt: taskPreview.dueAt,
      duplicate: approval.duplicate === true,
    });
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
    context: preview.tasks[0]?.context || {
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
      const status = preview.tasks.length > 0 ? "would_request" : "would_skip";
      results.push({
        callId: call.id,
        occurredAt: call.data().odorikTime || timestampToIso(call.data().processedAt),
        status,
        tasks: preview.tasks,
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
      (count, result) => count + ("tasks" in result ? result.tasks?.length || 0 : 0),
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
    legacyCrmEnabled: environment.LEGACY_CRM_ENABLED !== "false",
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
