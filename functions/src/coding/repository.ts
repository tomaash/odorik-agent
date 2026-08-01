import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { jsonSafe, db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import type { CodingDispatchSpec, CodingRunStatus } from "./types.js";
import { activeCodingRunStatuses } from "./types.js";
import { codingObjectRoot } from "./artifacts.js";
import { actionEffectDigest } from "../actions/contracts.js";
import type { ApprovedActionExecutionContext } from "../actions/registry.js";
import type { CodingIssueImplementAction } from "./action.js";

const retentionMs = 7 * 24 * 60 * 60 * 1000;
const runPattern = /^coding_[a-f0-9]{32}$/;

export class CodingRunError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function codingRunPath(companyId: string, runId: string): string {
  if (!runPattern.test(runId)) throw new CodingRunError("Invalid coding run", 400);
  return `companies/${companyId}/codingRuns/${runId}`;
}

function publicRun(id: string, data: Record<string, unknown>): Record<string, unknown> {
  const value = jsonSafe(data) as Record<string, unknown>;
  return { id, ...value, companyId: undefined };
}

export async function listCodingIssues(input: {
  companyId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<Record<string, unknown>[]> {
  const database = input.database || db;
  const [items, runs, approvals] = await Promise.all([
    database.collection(`companies/${input.companyId}/contextItems`)
      .where("kind", "==", "github.issue").get(),
    database.collection(`companies/${input.companyId}/codingRuns`).get(),
    database.collection(`companies/${input.companyId}/actionApprovals`).get(),
  ]);
  const activeByIssue = new Map<string, string>();
  for (const run of runs.docs) {
    if (!activeCodingRunStatuses.includes(run.data().status)) continue;
    const contextItemId = String(run.data().github?.issueContextItemId || "");
    if (contextItemId) activeByIssue.set(contextItemId, run.id);
  }
  const pendingByIssue = new Map<string, string>();
  for (const approval of approvals.docs) {
    const data = approval.data();
    if (
      data.objectType === "action_approval"
      && data.decisionStatus === "pending"
      && data.action?.kind === "coding.issue.implement"
      && typeof data.action?.github?.issueContextItemId === "string"
    ) pendingByIssue.set(data.action.github.issueContextItemId, approval.id);
  }
  return items.docs
    .filter((document) => document.data().metadata?.state === "open")
    .map((document) => {
      const data = jsonSafe(document.data()) as Record<string, unknown>;
      const metadata = data.metadata as Record<string, unknown> || {};
      const source = data.source as Record<string, unknown> || {};
      return {
        id: document.id,
        title: String(data.title || "GitHub issue"),
        excerpt: String(data.text || "").slice(0, 1_500),
        sourceUrl: String(metadata.sourceUrl || ""),
        repository: String(metadata.repository || ""),
        issueNumber: Number(metadata.issueNumber || 0),
        labels: Array.isArray(metadata.labels) ? metadata.labels.map(String) : [],
        connectionId: String(source.connectionId || ""),
        repoResourceId: String(source.resourceId || ""),
        activeRunId: activeByIssue.get(document.id) || null,
        pendingApprovalId: pendingByIssue.get(document.id) || null,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      };
    })
    .sort((left, right) => Number(right.issueNumber) - Number(left.issueNumber));
}

export async function listCodingRuns(input: {
  companyId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<Record<string, unknown>[]> {
  const snapshot = await (input.database || db)
    .collection(`companies/${input.companyId}/codingRuns`)
    .orderBy("createdAt", "desc")
    .get();
  return snapshot.docs.slice(0, 100).map((document) => publicRun(document.id, document.data()));
}

export async function getCodingRun(input: {
  companyId: string;
  runId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const ref = database.doc(codingRunPath(input.companyId, input.runId));
  const [snapshot, events] = await Promise.all([
    ref.get(),
    ref.collection("events").orderBy("createdAt", "asc").get(),
  ]);
  if (!snapshot.exists) throw new CodingRunError("Coding run not found", 404);
  return {
    ...publicRun(snapshot.id, snapshot.data() || {}),
    events: events.docs.map((event) => ({ id: event.id, ...jsonSafe(event.data()) as object })),
  };
}

export async function createCodingRunFromApprovedAction(input: {
  context: ApprovedActionExecutionContext;
  action: CodingIssueImplementAction;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<{ run: Record<string, unknown>; created: boolean; dispatchSpec: CodingDispatchSpec }> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const { action } = input;
  const companyId = input.context.companyId;
  const runId = action.runId;
  const issueRef = database.doc(
    `companies/${companyId}/contextItems/${action.github.issueContextItemId}`,
  );
  const issue = await issueRef.get();
  const issueData = issue.data() || {};
  if (!issue.exists || issueData.kind !== "github.issue") {
    throw new CodingRunError("GitHub issue not found", 404);
  }
  if (issueData.metadata?.state !== "open") {
    throw new CodingRunError("Only an open GitHub issue can be implemented", 409);
  }
  const [connection, resource, grok] = await Promise.all([
    database.doc(`companies/${companyId}/connections/${action.github.connectionId}`).get(),
    database.doc(
      `companies/${companyId}/connections/${action.github.connectionId}`
        + `/resources/${action.github.repoResourceId}`,
    ).get(),
    database.doc(`companies/${companyId}/connections/${action.grok.connectionId}`).get(),
  ]);
  if (
    !connection.exists
    || connection.data()?.connectorId !== "github"
    || connection.data()?.status !== "active"
  ) throw new CodingRunError("The GitHub connection is not active", 409);
  if (!resource.exists || resource.data()?.status !== "enabled") {
    throw new CodingRunError("The issue repository is not selected", 409);
  }
  if (
    !grok.exists
    || grok.data()?.status !== "active"
    || grok.data()?.subscription?.state !== "active"
  ) throw new CodingRunError("Connect the Grok subscription before starting a coding run", 409);

  const fullName = `${action.github.owner}/${action.github.repo}`;
  if (
    issueData.source?.connectionId !== action.github.connectionId
    || issueData.source?.resourceId !== action.github.repoResourceId
    || String(issueData.source?.version || "") !== action.github.issueVersion
    || String(issueData.provenance?.checksum || "") !== action.github.issueChecksum
    || Number(issueData.metadata?.repositoryId) !== action.github.repositoryId
    || Number(issueData.metadata?.issueNumber) !== action.github.issueNumber
    || String(issueData.metadata?.repository || "").toLowerCase() !== fullName.toLowerCase()
    || Number(connection.data()?.installationId) !== action.github.installationId
    || Number(resource.data()?.externalId) !== action.github.repositoryId
    || String(resource.data()?.defaultBranch || "main") !== action.git.baseBranch
  ) throw new CodingRunError("The approved GitHub issue or repository changed", 409);

  const lockId = sha256Hex(
    `${action.github.connectionId}:${action.github.repoResourceId}:${action.github.issueNumber}`,
  ).slice(0, 40);
  const lockRef = database.doc(`companies/${companyId}/codingRunLocks/${lockId}`);
  const runRef = database.doc(codingRunPath(companyId, runId));
  const root = codingObjectRoot(companyId, runId);
  const effectDigest = actionEffectDigest(action);
  const dispatchSpec: CodingDispatchSpec = {
    schemaVersion: 1,
    runId,
    companyId,
    github: {
      connectionId: action.github.connectionId,
      installationId: action.github.installationId,
      repoResourceId: action.github.repoResourceId,
      repositoryId: action.github.repositoryId,
      fullName,
      defaultBranch: action.git.baseBranch,
      issueNumber: action.github.issueNumber,
      issueContextItemId: action.github.issueContextItemId,
      issueVersion: action.github.issueVersion,
      issueChecksum: action.github.issueChecksum,
      issuePrompt: action.issuePrompt,
    },
    grok: action.grok,
    proposedBranch: action.git.resultBranch,
    sourceBranch: action.git.sourceBranch || action.git.baseBranch,
    baseSha: action.git.baseSha,
    approval: {
      approvalId: input.context.approvalId,
      approvedBy: input.context.approvedBy,
      effectDigest,
    },
    publication: action.publication,
    objects: {
      source: `${root}/source.bundle`,
      runSpec: `${root}/run-spec.json`,
      artifact: `${root}/artifacts.tar.gz`,
      patch: `${root}/changes.patch`,
      resultBundle: `${root}/result.bundle`,
      publishSpec: `${root}/publish-spec.json`,
    },
    limits: {
      maxSourceBytes: 2 * 1024 * 1024 * 1024,
      maxArtifactBytes: action.limits.maxArtifactBytes,
      maxChangedFiles: action.limits.maxChangedFiles,
      maxPatchBytes: action.limits.maxPatchBytes,
      maxTurns: action.limits.maxTurns,
    },
  };
  let existingRunId: string | null = null;
  await database.runTransaction(async (transaction) => {
    const [existingRun, lock] = await Promise.all([
      transaction.get(runRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
      transaction.get(lockRef) as Promise<FirebaseFirestore.DocumentSnapshot>,
    ]);
    if (existingRun.exists) {
      existingRunId = runId;
      return;
    }
    const lockedRunId = String(lock.data()?.runId || "");
    if (lock.exists && runPattern.test(lockedRunId)) {
      const lockedRun = await transaction.get(
        database.doc(codingRunPath(companyId, lockedRunId)),
      ) as FirebaseFirestore.DocumentSnapshot;
      if (lockedRun.exists && activeCodingRunStatuses.includes(lockedRun.data()?.status)) {
        throw new CodingRunError("This issue already has an active approved coding run", 409);
      }
    }
    const expiresAt = Timestamp.fromMillis(now.toMillis() + retentionMs);
    transaction.create(runRef, {
      schemaVersion: 1,
      companyId,
      status: "queued",
      phase: "queued",
      initiatedBy: {
        uid: input.context.approvedBy,
        displayName: input.context.approvedBy,
      },
      authorization: {
        kind: "approval",
        approvalId: input.context.approvalId,
        approvedBy: input.context.approvedBy,
        effectDigest,
      },
      github: {
        connectionId: action.github.connectionId,
        repoResourceId: action.github.repoResourceId,
        owner: action.github.owner,
        repo: action.github.repo,
        repositoryId: action.github.repositoryId,
        issueNumber: action.github.issueNumber,
        issueUrl: action.github.issueUrl,
        issueContextItemId: action.github.issueContextItemId,
      },
      issueSnapshot: {
        contextVersion: action.github.issueVersion,
        checksum: action.github.issueChecksum,
        title: String(issueData.title || "GitHub issue"),
        text: String(issueData.text || "").slice(0, 500_000),
        labels: Array.isArray(issueData.metadata?.labels)
          ? issueData.metadata.labels.map(String).slice(0, 100)
          : [],
        capturedAt: now,
      },
      grok: action.grok,
      git: {
        baseBranch: action.git.baseBranch,
        sourceBranch: action.git.sourceBranch || action.git.baseBranch,
        baseSha: action.git.baseSha,
        proposedBranch: action.git.resultBranch,
      },
      ...(action.linkedAttempt ? { linkedAttempt: action.linkedAttempt } : {}),
      publication: action.publication,
      artifacts: {
        sourceObject: dispatchSpec.objects.source,
        artifactObject: dispatchSpec.objects.artifact,
        patchObject: dispatchSpec.objects.patch,
        resultBundleObject: dispatchSpec.objects.resultBundle,
        publishSpecObject: dispatchSpec.objects.publishSpec,
        expiresAt,
      },
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    transaction.set(lockRef, {
      runId,
      issueContextItemId: action.github.issueContextItemId,
      updatedAt: now,
    });
    transaction.create(runRef.collection("events").doc("queued"), {
      phase: "queued",
      status: "queued",
      message: "Approved coding run queued",
      actorUid: input.context.approvedBy,
      createdAt: now,
    });
    transaction.set(database.doc(`codingRunRoutes/${runId}`), {
      runId,
      companyId,
      createdAt: now,
      expiresAt,
    });
  });
  if (existingRunId) {
    return {
      run: await getCodingRun({ companyId, runId, database }),
      created: false,
      dispatchSpec,
    };
  }
  return {
    run: await getCodingRun({ companyId, runId, database }),
    created: true,
    dispatchSpec,
  };
}

export async function updateCodingRunState(input: {
  companyId: string;
  runId: string;
  status: CodingRunStatus;
  phase: string;
  message: string;
  values?: Record<string, unknown>;
  eventId: string;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<void> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const ref = database.doc(codingRunPath(input.companyId, input.runId));
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new CodingRunError("Coding run not found", 404);
  const batch = database.batch();
  batch.set(ref, {
    status: input.status,
    phase: input.phase,
    ...(input.values || {}),
    updatedAt: now,
  }, { merge: true });
  batch.set(ref.collection("events").doc(input.eventId), {
    status: input.status,
    phase: input.phase,
    message: input.message.slice(0, 1_000),
    createdAt: now,
  });
  batch.set(database.doc(`companies/${input.companyId}/auditEvents/coding_${input.runId}_${input.eventId}`), {
    eventType: `coding.${input.status}`,
    codingRunId: input.runId,
    status: input.status,
    phase: input.phase,
    occurredAt: now,
    createdAt: now,
  });
  await batch.commit();
}

export async function requestCodingRunCancellation(input: {
  companyId: string;
  runId: string;
  actorUid: string;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const ref = database.doc(codingRunPath(input.companyId, input.runId));
  await database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new CodingRunError("Coding run not found", 404);
    if (!activeCodingRunStatuses.includes(snapshot.data()?.status)) {
      throw new CodingRunError("This coding run is no longer active", 409);
    }
    transaction.set(ref, {
      status: "cancel_requested",
      phase: "cancel_requested",
      cancelRequestedFromStatus: snapshot.data()?.status,
      cancelRequestedFromPhase: snapshot.data()?.phase,
      cancelRequestedBy: input.actorUid,
      cancelRequestedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.create(
      ref.collection("events").doc(`cancel-${now.toMillis()}-${snapshot.data()?.status}`),
      {
        status: "cancel_requested",
        phase: "cancel_requested",
        message: "Cancellation requested by an administrator",
        actorUid: input.actorUid,
        createdAt: now,
      },
    );
  });
  return getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
}

export function safeCodingError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[opaque]")
    .replace(/(?:\/[^\s/]+){2,}/g, "[path]")
    .slice(0, 500);
}

export function eventDocumentId(principal: string, eventId: string): string {
  return `callback_${sha256Hex(`${principal}:${eventId}`).slice(0, 40)}`;
}

export function statusIsTerminal(status: unknown): boolean {
  return ["succeeded", "no_changes", "outcome_unknown", "failed", "cancelled"]
    .includes(String(status));
}

export function serverTimestamp(): FirebaseFirestore.FieldValue {
  return FieldValue.serverTimestamp();
}
