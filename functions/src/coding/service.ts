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
import type {
  CodingAuthRefreshExecutor,
  CodingDispatcherExecutor,
  CodingPublisherExecutor,
} from "./types.js";
import type { GitHubPublicationSnapshot } from "./github-recovery.js";
import {
  createCloudRunGrokAuthJobExecutor,
  grokSubscriptionSecretName,
} from "../connectors/grok-subscription.js";
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
const defaultGrokAuthJobExecutor = createCloudRunGrokAuthJobExecutor();
const codingAuthCallbackUrl = process.env.CODING_AUTH_CALLBACK_URL?.trim()
  || "https://agent-erik-app.web.app/callbacks/coding-auth";
const defaultAuthRefreshExecutor: CodingAuthRefreshExecutor = (input) => (
  defaultGrokAuthJobExecutor({
    action: "refresh",
    sessionId: input.runId,
    secretName: grokSubscriptionSecretName,
    callbackUrl: codingAuthCallbackUrl,
  })
);

export async function queueCodingDispatcher(input: {
  companyId: string;
  runId: string;
  artifactStore?: CodingArtifactStore;
  executeDispatcher?: CodingDispatcherExecutor;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const artifactStore = input.artifactStore || defaultArtifactStore;
  const executeDispatcher = input.executeDispatcher || defaultDispatcherExecutor;
  const runRef = database.doc(`companies/${input.companyId}/codingRuns/${input.runId}`);
  const initial = await runRef.get();
  if (!initial.exists) throw new CodingRunError("Coding run not found", 404);
  const initialStatus = String(initial.data()?.status || "");
  const initialPhase = String(initial.data()?.phase || "");
  if (initialStatus === "packaging" && initial.data()?.cloudRun?.dispatcherOperationName) {
    return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
  }
  const initialQueued = initialStatus === "queued"
    && ["queued", "auth_refresh_completed"].includes(initialPhase);
  if (!initialQueued && !(initialStatus === "failed" && initialPhase === "dispatch_failed")) {
    if (initialStatus === "queued" && initialPhase === "dispatcher_queuing") {
      return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
    }
    throw new CodingRunError("The coding run is not ready for source dispatch", 409);
  }
  const sourceObject = String(initial.data()?.artifacts?.sourceObject || "");
  const dispatchObject = sourceObject.replace(/source\.bundle$/, "dispatch.json");
  if (!dispatchObject || dispatchObject === sourceObject || !await artifactStore.exists(dispatchObject)) {
    throw new CodingRunError("The immutable coding dispatch specification is missing", 409);
  }
  const now = input.now || Timestamp.now();
  let claimed = false;
  await database.runTransaction(async (transaction) => {
    const latest = await transaction.get(runRef);
    const status = String(latest.data()?.status || "");
    const phase = String(latest.data()?.phase || "");
    if (status === "packaging" && latest.data()?.cloudRun?.dispatcherOperationName) return;
    if (status === "queued" && phase === "dispatcher_queuing") return;
    const queued = status === "queued" && ["queued", "auth_refresh_completed"].includes(phase);
    if (!queued && !(status === "failed" && phase === "dispatch_failed")) {
      throw new CodingRunError("The coding run dispatch state changed", 409);
    }
    claimed = true;
    transaction.set(runRef, {
      status: "queued",
      phase: "dispatcher_queuing",
      error: null,
      completedAt: null,
      updatedAt: now,
    }, { merge: true });
  });
  if (!claimed) return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
  try {
    const dispatchSpecUrl = await artifactStore.signedReadUrl(dispatchObject, 30 * 60 * 1000);
    const execution = await executeDispatcher({ runId: input.runId, dispatchSpecUrl });
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "packaging",
      phase: "dispatcher_queued",
      message: "Trusted source dispatcher queued",
      eventId: "dispatcher-queued",
      values: {
        error: null,
        completedAt: null,
        cloudRun: {
          ...(initial.data()?.cloudRun || {}),
          dispatcherOperationName: execution.operationName,
          ...(execution.executionName
            ? { dispatcherExecutionName: execution.executionName }
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
        completedAt: now,
      },
      database,
      now,
    });
    throw error;
  }
  return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
}

export async function startApprovedCodingRun(input: {
  context: ApprovedActionExecutionContext;
  action: CodingIssueImplementAction;
  artifactStore?: CodingArtifactStore;
  executeAuthRefresh?: CodingAuthRefreshExecutor;
  executeDispatcher?: CodingDispatcherExecutor;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const artifactStore = input.artifactStore || defaultArtifactStore;
  const created = await createCodingRunFromApprovedAction({
    context: input.context,
    action: input.action,
    database,
    now: input.now,
  });
  if (!created.created && !["dispatch_failed", "auth_refresh_failed"].includes(
    String(created.run.phase || ""),
  )) return created.run;
  const dispatchObject = created.dispatchSpec.objects.runSpec.replace(/run-spec\.json$/, "dispatch.json");
  // Unit-test callers that inject a dispatcher retain the direct seam. The
  // production path always refreshes the rotating OAuth credential in the
  // dedicated least-privilege auth worker before starting Grok.
  const executeAuthRefresh = input.executeAuthRefresh
    || (input.executeDispatcher ? undefined : defaultAuthRefreshExecutor);
  try {
    if (!await artifactStore.exists(dispatchObject)) {
      await artifactStore.putJson(dispatchObject, created.dispatchSpec);
    }
    if (!executeAuthRefresh) {
      return queueCodingDispatcher({
        companyId: input.context.companyId,
        runId: created.dispatchSpec.runId,
        artifactStore,
        executeDispatcher: input.executeDispatcher,
        database,
        now: input.now,
      });
    }
    const execution = await executeAuthRefresh({ runId: created.dispatchSpec.runId });
    await updateCodingRunState({
      companyId: input.context.companyId,
      runId: created.dispatchSpec.runId,
      status: "queued",
      phase: "auth_refresh_queued",
      message: "Dedicated Grok OAuth refresh worker queued",
      eventId: "auth-refresh-queued",
      values: {
        error: null,
        completedAt: null,
        cloudRun: {
          authRefreshOperationName: execution.operationName,
          ...(execution.executionName
            ? { authRefreshExecutionName: execution.executionName }
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
      phase: executeAuthRefresh ? "auth_refresh_failed" : "dispatch_failed",
      message: safeCodingError(error),
      eventId: executeAuthRefresh ? "auth-refresh-start-failed" : "dispatch-failed",
      values: {
        error: {
          code: executeAuthRefresh ? "grok_auth_refresh_start_failed" : "dispatcher_start_failed",
          message: safeCodingError(error),
          phase: executeAuthRefresh ? "authentication" : "dispatch",
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
      branchMode: initial.data()?.linkedAttempt?.kind === "pull_request_changes"
        ? "fast_forward"
        : "create",
    },
    publication: {
      draft: true,
      prTitle: String(publication.prTitle),
      prBody: String(publication.prBody),
      ...(Number.isSafeInteger(publication.existingPullRequestNumber)
        ? { existingPullRequestNumber: Number(publication.existingPullRequestNumber) }
        : {}),
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

export async function reconcileCodingPublication(input: {
  companyId: string;
  runId: string;
  actorUid: string;
  inspectPublication: (value: {
    installationId: number;
    repositoryId: number;
    fullName: string;
    resultBranch: string;
    baseBranch: string;
  }) => Promise<GitHubPublicationSnapshot>;
  queuePublisher?: (companyId: string, runId: string) => Promise<Record<string, unknown>>;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const run = await getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
  if (!["outcome_unknown", "succeeded"].includes(String(run.status))) {
    throw new CodingRunError("This coding run does not need publication reconciliation", 409);
  }
  const authorization = run.authorization as Record<string, unknown> | undefined;
  const approvalId = String(authorization?.approvalId || "");
  const approval = await database.doc(
    `companies/${input.companyId}/actionApprovals/${approvalId}`,
  ).get();
  const action = approval.data()?.action as Record<string, unknown> | undefined;
  const actionGitHub = action?.github as Record<string, unknown> | undefined;
  const github = run.github as Record<string, unknown> | undefined;
  const git = run.git as Record<string, unknown> | undefined;
  const expectedResultSha = String(git?.resultSha || "").toLowerCase();
  if (
    !approval.exists
    || action?.kind !== "coding.issue.implement"
    || !Number.isSafeInteger(actionGitHub?.installationId)
    || !/^[a-f0-9]{40,64}$/.test(expectedResultSha)
  ) throw new CodingRunError("The approved publication record is incomplete", 409);

  const snapshot = await input.inspectPublication({
    installationId: Number(actionGitHub?.installationId),
    repositoryId: Number(github?.repositoryId),
    fullName: `${String(github?.owner)}/${String(github?.repo)}`,
    resultBranch: String(git?.proposedBranch),
    baseBranch: String(git?.baseBranch),
  });
  const pull = snapshot.pullRequest;
  const conflictingBranch = snapshot.branchSha !== null
    && snapshot.branchSha !== expectedResultSha;
  const conflictingPull = pull !== null && pull.headSha !== expectedResultSha;
  if (run.status === "outcome_unknown" && (conflictingBranch || conflictingPull)) {
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "failed",
      phase: "publication_conflict",
      message: "GitHub publication conflicts with the approved result SHA",
      eventId: `reconcile-conflict-${now.toMillis()}`,
      values: {
        completedAt: now,
        error: {
          code: "publication_conflict",
          message: "GitHub publication conflicts with the approved result SHA",
          phase: "reconciliation",
        },
        recovery: {
          reconciledBy: input.actorUid,
          reconciledAt: now,
        },
      },
      database,
      now,
    });
    return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
  }

  if (pull) {
    const advanced = pull.headSha !== expectedResultSha;
    const phase = pull.mergedAt
      ? "pull_request_merged"
      : pull.state === "closed"
        ? "pull_request_closed"
        : advanced
          ? "pull_request_advanced"
          : "publication_reconciled";
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "succeeded",
      phase,
      message: pull.mergedAt
        ? "Merged pull request reconciled from GitHub"
        : pull.state === "closed"
          ? "Closed pull request reconciled from GitHub"
          : advanced
            ? "Pull request head advanced on GitHub"
            : "Pull request reconciled from GitHub",
      eventId: `reconcile-pull-${now.toMillis()}`,
      values: {
        completedAt: now,
        error: null,
        publicationResult: {
          pullRequestNumber: pull.number,
          pullRequestUrl: pull.url,
          branch: pull.headBranch,
          draft: pull.draft,
          state: pull.state,
          mergedAt: pull.mergedAt,
          headSha: pull.headSha,
        },
        recovery: {
          reconciledBy: input.actorUid,
          reconciledAt: now,
        },
      },
      database,
      now,
    });
    return getCodingRun({ companyId: input.companyId, runId: input.runId, database });
  }

  if (run.status === "succeeded") {
    throw new CodingRunError("The recorded pull request could not be found on GitHub", 409);
  }
  await updateCodingRunState({
    companyId: input.companyId,
    runId: input.runId,
    status: "ready_to_publish",
    phase: snapshot.branchSha ? "orphan_branch_recovered" : "publication_absent",
    message: snapshot.branchSha
      ? "Approved result branch found without a pull request; republishing"
      : "No GitHub publication found; safely republishing the approved result",
    eventId: `reconcile-republish-${now.toMillis()}`,
    values: {
      completedAt: null,
      error: null,
      recovery: {
        reconciledBy: input.actorUid,
        reconciledAt: now,
      },
    },
    database,
    now,
  });
  const queue = input.queuePublisher || (async (companyId, runId) => queueCodingPublisher({
    companyId,
    runId,
    database,
  }));
  return queue(input.companyId, input.runId);
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
  const cancellation = await requestCodingRunCancellation({
    companyId: input.companyId,
    runId: input.runId,
    actorUid: input.actorUid,
    database,
  });
  const cloudRun = cancellation.cloudRun as Record<string, unknown> | undefined;
  const status = String(cancellation.cancelRequestedFromStatus || run.status);
  const executionName = String(
    status === "publishing"
      ? cloudRun?.publisherExecutionName || ""
      : status === "queued" || status === "packaging"
        ? cloudRun?.dispatcherExecutionName || cloudRun?.authRefreshExecutionName || ""
        : cloudRun?.runnerExecutionName || cloudRun?.dispatcherExecutionName || "",
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
  } else if (status === "ready_to_publish") {
    await updateCodingRunState({
      companyId: input.companyId,
      runId: input.runId,
      status: "cancelled",
      phase: "cancelled",
      message: "Coding publication cancelled before the publisher started",
      eventId: `cancelled-${Timestamp.now().toMillis()}`,
      values: { completedAt: Timestamp.now() },
      database,
    });
  }
  return getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
}
