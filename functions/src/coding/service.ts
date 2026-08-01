import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { actionEffectDigest } from "../actions/contracts.js";
import type { ApprovedActionExecutionContext } from "../actions/registry.js";
import type { CodingIssueImplementAction } from "./action.js";
import { GoogleCodingArtifactStore } from "./artifacts.js";
import {
  createCloudRunCodingDispatcherExecutor,
  createCloudRunCodingPublisherExecutor,
} from "./cloud-run.js";
import type { CodingArtifactStore } from "./artifacts.js";
import type { CodingDispatcherExecutor, CodingPublisherExecutor } from "./types.js";
import {
  CodingRunError,
  createCodingRunFromApprovedAction,
  getCodingRun,
  requestCodingRunCancellation,
  safeCodingError,
  updateCodingRunState,
} from "./repository.js";

const defaultArtifactStore = new GoogleCodingArtifactStore();
const defaultDispatcherExecutor = createCloudRunCodingDispatcherExecutor();
const defaultPublisherExecutor = createCloudRunCodingPublisherExecutor();

export async function startApprovedCodingRun(input: {
  context: ApprovedActionExecutionContext;
  action: CodingIssueImplementAction;
  artifactStore?: CodingArtifactStore;
  executeDispatcher?: CodingDispatcherExecutor;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const artifactStore = input.artifactStore || defaultArtifactStore;
  const executeDispatcher = input.executeDispatcher || defaultDispatcherExecutor;
  const created = await createCodingRunFromApprovedAction({
    context: input.context,
    action: input.action,
    database,
    now: input.now,
  });
  if (!created.created && created.run.status !== "queued") return created.run;
  const dispatchObject = created.dispatchSpec.objects.runSpec.replace(/run-spec\.json$/, "dispatch.json");
  try {
    if (!await artifactStore.exists(dispatchObject)) {
      await artifactStore.putJson(dispatchObject, created.dispatchSpec);
    }
    const dispatchSpecUrl = await artifactStore.signedReadUrl(
      dispatchObject,
      30 * 60 * 1000,
    );
    const execution = await executeDispatcher({
      runId: created.dispatchSpec.runId,
      dispatchSpecUrl,
    });
    await updateCodingRunState({
      companyId: input.context.companyId,
      runId: created.dispatchSpec.runId,
      status: "packaging",
      phase: "dispatcher_queued",
      message: "Trusted source dispatcher queued",
      eventId: "dispatcher-queued",
      values: {
        cloudRun: {
          dispatcherOperationName: execution.operationName,
          ...(execution.executionName
            ? { dispatcherExecutionName: execution.executionName }
            : {}),
        },
      },
      database,
      now: input.now,
    });
  } catch (error) {
    await updateCodingRunState({
      companyId: input.context.companyId,
      runId: created.dispatchSpec.runId,
      status: "failed",
      phase: "dispatch_failed",
      message: safeCodingError(error),
      eventId: "dispatch-failed",
      values: {
        error: {
          code: "dispatcher_start_failed",
          message: safeCodingError(error),
          phase: "dispatch",
        },
        completedAt: input.now || Timestamp.now(),
      },
      database,
      now: input.now,
    });
    throw error;
  }
  return getCodingRun({
    companyId: input.context.companyId,
    runId: created.dispatchSpec.runId,
    database,
  });
}

export async function queueCodingPublisher(input: {
  companyId: string;
  runId: string;
  artifactStore?: CodingArtifactStore;
  executePublisher?: CodingPublisherExecutor;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const artifactStore = input.artifactStore || defaultArtifactStore;
  const executePublisher = input.executePublisher || defaultPublisherExecutor;
  const runRef = database.doc(`companies/${input.companyId}/codingRuns/${input.runId}`);
  const initial = await runRef.get();
  if (!initial.exists) throw new CodingRunError("Coding run not found", 404);
  if (initial.data()?.status === "publishing" && initial.data()?.cloudRun?.publisherOperationName) {
    return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
  }
  if (initial.data()?.status !== "ready_to_publish") {
    throw new CodingRunError("The coding run is not ready to publish", 409);
  }
  const authorization = initial.data()?.authorization || {};
  const approvalId = String(authorization.approvalId || "");
  const approval = await database.doc(
    `companies/${input.companyId}/actionApprovals/${approvalId}`,
  ).get();
  const action = approval.data()?.action;
  if (!approval.exists || !action || typeof action !== "object") {
    throw new CodingRunError("The coding run approval is missing", 409);
  }
  const digest = actionEffectDigest(action);
  if (
    approval.data()?.decisionStatus !== "approved"
    || approval.data()?.executionStatus !== "succeeded"
    || approval.data()?.result?.kind !== "coding_run"
    || approval.data()?.result?.id !== input.runId
    || digest !== approval.data()?.effectDigest
    || digest !== authorization.effectDigest
    || approval.data()?.approvedBy !== authorization.approvedBy
  ) throw new CodingRunError("The coding run no longer has valid publication approval", 409);

  const git = initial.data()?.git || {};
  const github = initial.data()?.github || {};
  const publication = initial.data()?.publication || {};
  const artifacts = initial.data()?.artifacts || {};
  const result = initial.data()?.result || {};
  if (
    !/^[a-f0-9]{40,64}$/.test(String(git.baseSha || ""))
    || !/^[a-f0-9]{40,64}$/.test(String(git.resultSha || ""))
    || !/^[a-f0-9]{64}$/.test(String(result.resultBundleSha256 || ""))
    || !Number.isSafeInteger(result.resultBundleBytes)
    || result.resultBundleBytes <= 0
    || publication.draft !== true
  ) throw new CodingRunError("The coding result is incomplete", 409);
  for (const object of [artifacts.sourceObject, artifacts.resultBundleObject]) {
    if (!object || !await artifactStore.exists(String(object))) {
      throw new CodingRunError("A required coding publication artifact is missing", 409);
    }
  }

  const now = input.now || Timestamp.now();
  let claimed = false;
  await database.runTransaction(async (transaction) => {
    const latest = await transaction.get(runRef);
    if (latest.data()?.status === "publishing") return;
    if (latest.data()?.status !== "ready_to_publish") {
      throw new CodingRunError("The coding run publication state changed", 409);
    }
    claimed = true;
    transaction.set(runRef, {
      status: "publishing",
      phase: "publisher_queuing",
      updatedAt: now,
    }, { merge: true });
  });
  if (!claimed) return getCodingRun({ companyId: input.companyId, runId: input.runId, database });

  const publishSpec = {
    schemaVersion: 1,
    runId: input.runId,
    companyId: input.companyId,
    approval: {
      approvalId,
      approvedBy: String(authorization.approvedBy),
      effectDigest: digest,
    },
    github: {
      installationId: Number((action as Record<string, unknown> & {
        github?: Record<string, unknown>;
      }).github?.installationId),
      repositoryId: Number(github.repositoryId),
      fullName: `${github.owner}/${github.repo}`,
      issueNumber: Number(github.issueNumber),
    },
    git: {
      baseBranch: String(git.baseBranch),
      baseSha: String(git.baseSha),
      resultBranch: String(git.proposedBranch),
      resultSha: String(git.resultSha),
    },
    publication: {
      draft: true,
      prTitle: String(publication.prTitle),
      prBody: String(publication.prBody),
    },
    objects: {
      source: String(artifacts.sourceObject),
      resultBundle: String(artifacts.resultBundleObject),
    },
    resultBundleSha256: String(result.resultBundleSha256),
    maxResultBundleBytes: Number((action as Record<string, unknown> & {
      limits?: Record<string, unknown>;
    }).limits?.maxArtifactBytes),
  };
  const publishSpecObject = String(artifacts.publishSpecObject);
  try {
    if (!await artifactStore.exists(publishSpecObject)) {
      await artifactStore.putJson(publishSpecObject, publishSpec);
    }
    const execution = await executePublisher({
      runId: input.runId,
      publishSpecUrl: await artifactStore.signedReadUrl(publishSpecObject, 30 * 60 * 1000),
    });
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "publishing",
      phase: "publisher_queued",
      message: "Trusted draft pull request publisher queued",
      eventId: "publisher-queued",
      values: {
        cloudRun: {
          publisherOperationName: execution.operationName,
          ...(execution.executionName
            ? { publisherExecutionName: execution.executionName }
            : {}),
        },
      },
      database,
      now,
    });
  } catch (error) {
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "ready_to_publish",
      phase: "publisher_queue_failed",
      message: safeCodingError(error),
      eventId: `publisher-queue-failed-${now.toMillis()}`,
      database,
      now,
    });
    throw error;
  }
  return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
}

export async function codingPatchPreview(input: {
  companyId: string;
  runId: string;
  artifactStore: CodingArtifactStore;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ patch: string; truncated: boolean }> {
  const run = await getCodingRun(input);
  if (!["ready_to_publish", "publishing", "succeeded", "no_changes", "outcome_unknown"]
    .includes(String(run.status))) {
    throw new CodingRunError("The patch is not ready for review", 409);
  }
  const artifacts = run.artifacts as Record<string, unknown> | undefined;
  const object = String(artifacts?.patchObject || "");
  if (!object) throw new CodingRunError("The run has no patch artifact", 404);
  if (!await input.artifactStore.exists(object)) {
    throw new CodingRunError("The patch artifact is missing", 404);
  }
  const result = await input.artifactStore.readText(object, 250_000);
  return { patch: result.text, truncated: result.truncated };
}

export async function codingArtifactDownloadUrl(input: {
  companyId: string;
  runId: string;
  artifactStore: CodingArtifactStore;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ url: string; expiresAt: string }> {
  const run = await getCodingRun(input);
  if (!["ready_to_publish", "publishing", "succeeded", "no_changes", "outcome_unknown", "failed"]
    .includes(String(run.status))) {
    throw new CodingRunError("The result artifact is not available yet", 409);
  }
  const artifacts = run.artifacts as Record<string, unknown> | undefined;
  const object = String(artifacts?.artifactObject || "");
  if (!object || !await input.artifactStore.exists(object)) {
    throw new CodingRunError("The result artifact is missing", 404);
  }
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  return {
    url: await input.artifactStore.signedReadUrl(object, 15 * 60 * 1000),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function cancelCodingRun(input: {
  companyId: string;
  runId: string;
  actorUid: string;
  cancelExecution: (executionName: string) => Promise<void>;
  database?: FirebaseFirestore.Firestore;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const run = await getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
  await requestCodingRunCancellation({
    companyId: input.companyId,
    runId: input.runId,
    actorUid: input.actorUid,
    database,
  });
  const cloudRun = run.cloudRun as Record<string, unknown> | undefined;
  const executionName = String(
    cloudRun?.runnerExecutionName || cloudRun?.dispatcherExecutionName || "",
  );
  if (executionName) {
    try {
      await input.cancelExecution(executionName);
    } catch (error) {
      await database.doc(`companies/${input.companyId}/codingRuns/${input.runId}`).set({
        cancellationError: safeCodingError(error),
        updatedAt: Timestamp.now(),
      }, { merge: true });
      throw error;
    }
  }
  return getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
}
