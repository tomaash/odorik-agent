import { Timestamp } from "firebase-admin/firestore";
import { requestWorkflowActionApproval } from "../approvals/repository.js";
import {
  resolveGitHubRepositoryBaseSha,
  type FetchLike,
  type GitHubAppConfiguration,
} from "../connectors/github.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import type { WorkflowActionSource } from "../actions/contracts.js";
import type { CodingIssueImplementAction } from "./action.js";
import { CodingRunError, getCodingRun } from "./repository.js";
import type { GitHubPublicationSnapshot } from "./github-recovery.js";
import { activeCodingRunStatuses } from "./types.js";

const codingWorkflowVersion = 1;

function boundedTitle(value: unknown): string {
  return String(value || "GitHub issue")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim()
    .slice(0, 240) || "GitHub issue";
}

async function activeApprover(input: {
  companyId: string;
  preferredUid?: string;
  database: FirebaseFirestore.Firestore;
}): Promise<{ uid: string; displayName: string; email: string }> {
  if (input.preferredUid) {
    const member = await input.database.doc(
      `companies/${input.companyId}/memberships/${input.preferredUid}`,
    ).get();
    if (
      !member.exists
      || member.data()?.status !== "active"
      || member.data()?.role !== "admin"
    ) throw new CodingRunError("A coding approver must be an active administrator", 409);
    return {
      uid: input.preferredUid,
      displayName: String(
        member.data()?.displayName || member.data()?.email || "Administrator",
      ).slice(0, 200),
      email: String(member.data()?.email || "").slice(0, 320),
    };
  }
  const memberships = await input.database.collection(
    `companies/${input.companyId}/memberships`,
  ).get();
  const admin = memberships.docs
    .filter((entry) => entry.data().status === "active" && entry.data().role === "admin")
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!admin) throw new CodingRunError("No active administrator can approve coding work", 409);
  return {
    uid: admin.id,
    displayName: String(admin.data().displayName || admin.data().email || "Administrator").slice(0, 200),
    email: String(admin.data().email || "").slice(0, 320),
  };
}

export async function requestCodingImplementationApproval(input: {
  companyId: string;
  actorUid: string;
  issueContextItemId: string;
  configuration: GitHubAppConfiguration;
  preferredApproverUid?: string;
  workflowId?:
    | "coding.issue.manual"
    | "coding.issue.label"
    | "coding.issue.retry"
    | "coding.pr.changes";
  linkedAttempt?: NonNullable<CodingIssueImplementAction["linkedAttempt"]>;
  sourceOverride?: {
    sourceBranch: string;
    baseSha: string;
    resultBranch: string;
  };
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: Timestamp;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const issue = await database.doc(
    `companies/${input.companyId}/contextItems/${input.issueContextItemId}`,
  ).get();
  const issueData = issue.data() || {};
  if (!issue.exists || issueData.kind !== "github.issue") {
    throw new CodingRunError("GitHub issue not found", 404);
  }
  if (issueData.metadata?.state !== "open") {
    throw new CodingRunError("Only an open GitHub issue can be implemented", 409);
  }
  const connectionId = String(issueData.source?.connectionId || "");
  const repoResourceId = String(issueData.source?.resourceId || "");
  const [connection, resource, grok, approver] = await Promise.all([
    database.doc(`companies/${input.companyId}/connections/${connectionId}`).get(),
    database.doc(
      `companies/${input.companyId}/connections/${connectionId}/resources/${repoResourceId}`,
    ).get(),
    database.doc(`companies/${input.companyId}/connections/grok_subscription`).get(),
    activeApprover({
      companyId: input.companyId,
      preferredUid: input.preferredApproverUid,
      database,
    }),
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
  ) throw new CodingRunError("Connect the Grok subscription before requesting coding work", 409);

  const installationId = Number(connection.data()?.installationId || 0);
  const repositoryId = Number(issueData.metadata?.repositoryId || resource.data()?.externalId);
  const issueNumber = Number(issueData.metadata?.issueNumber || 0);
  const fullName = String(issueData.metadata?.repository || resource.data()?.displayName || "");
  const [owner, repo, ...extra] = fullName.split("/");
  const baseBranch = String(resource.data()?.defaultBranch || "main");
  const issueVersion = String(issueData.source?.version || "");
  const issueChecksum = String(issueData.provenance?.checksum || "").toLowerCase();
  const issueUrl = String(issueData.metadata?.sourceUrl || "");
  if (
    !Number.isSafeInteger(installationId) || installationId <= 0
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(issueNumber) || issueNumber <= 0
    || !owner || !repo || extra.length > 0
    || !/^[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)
    || !issueVersion
    || !/^[a-f0-9]{64}$/.test(issueChecksum)
    || !/^https:\/\/github\.com\//.test(issueUrl)
  ) throw new CodingRunError("The issue source metadata is incomplete", 409);

  const baseSha = input.sourceOverride?.baseSha || await resolveGitHubRepositoryBaseSha({
    configuration: input.configuration,
    installationId,
    repositoryId,
    fullName,
    baseBranch,
    fetcher: input.fetcher,
  });
  const sourceBranch = input.sourceOverride?.sourceBranch || baseBranch;
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(sourceBranch)
    || !/^[a-f0-9]{40,64}$/.test(baseSha)
    || (
      input.sourceOverride
      && !/^erik\/[A-Za-z0-9._/-]{1,190}$/.test(input.sourceOverride.resultBranch)
    )
  ) throw new CodingRunError("The linked coding source is invalid", 409);
  const workflowId = input.workflowId || "coding.issue.manual";
  const fingerprint = sha256Hex(JSON.stringify({
    companyId: input.companyId,
    workflowId,
    workflowVersion: codingWorkflowVersion,
    issueContextItemId: input.issueContextItemId,
    issueVersion,
    issueChecksum,
    baseSha,
    sourceBranch,
    linkedAttempt: input.linkedAttempt || null,
  }));
  const runId = `coding_${fingerprint.slice(0, 32)}`;
  const approvalId = `coding_approval_${fingerprint.slice(0, 40)}`;
  const title = boundedTitle(issueData.title);
  const issuePrompt = input.linkedAttempt
    ? [
        String(issueData.text || "").slice(0, 75_000),
        "",
        "Approved operator instructions for this linked attempt:",
        input.linkedAttempt.instructions,
      ].join("\n").slice(0, 100_000)
    : String(issueData.text || "").slice(0, 100_000);
  const action: CodingIssueImplementAction = {
    kind: "coding.issue.implement",
    runId,
    title,
    issueExcerpt: String(issueData.text || "").slice(0, 5_000),
    issuePrompt,
    github: {
      connectionId,
      installationId,
      repoResourceId,
      repositoryId,
      owner,
      repo,
      issueNumber,
      issueContextItemId: input.issueContextItemId,
      issueUrl,
      issueVersion,
      issueChecksum,
    },
    git: {
      baseBranch,
      sourceBranch,
      baseSha,
      resultBranch: input.sourceOverride?.resultBranch
        || `erik/issue-${issueNumber}-${runId.slice(-8)}`,
    },
    ...(input.linkedAttempt ? { linkedAttempt: input.linkedAttempt } : {}),
    grok: {
      connectionId: "grok_subscription",
      authKind: "subscription_oauth",
    },
    limits: {
      maxRuntimeMinutes: 60,
      maxTurns: 30,
      maxChangedFiles: 300,
      maxPatchBytes: 10 * 1024 * 1024,
      maxArtifactBytes: 50 * 1024 * 1024,
    },
    publication: {
      draft: true,
      prTitle: `Implement #${issueNumber}: ${title}`.slice(0, 256),
      prBody: [
        input.linkedAttempt?.kind === "pull_request_changes"
          ? `Follow-up for #${issueNumber}`
          : `Closes #${issueNumber}`,
        "",
        "Implemented by Agent Erik using the connected Grok subscription.",
        `Coding run: ${runId}`,
        `Approval: ${approvalId}`,
        `Approved base: ${baseSha}`,
      ].join("\n"),
      ...(input.linkedAttempt?.kind === "pull_request_changes"
        ? { existingPullRequestNumber: input.linkedAttempt.pullRequestNumber }
        : {}),
    },
  };
  const source: WorkflowActionSource = {
    kind: "workflow",
    issueContextItemId: input.issueContextItemId,
    workflowId,
    workflowVersion: codingWorkflowVersion,
    runId: `coding_workflow_${fingerprint.slice(0, 24)}`,
    blockId: "implement-with-grok",
  };
  const [runs, approvals] = await Promise.all([
    database.collection(`companies/${input.companyId}/codingRuns`).get(),
    database.collection(`companies/${input.companyId}/actionApprovals`).get(),
  ]);
  const activeRun = runs.docs.find((entry) => (
    activeCodingRunStatuses.includes(entry.data().status)
    && entry.data().github?.issueContextItemId === input.issueContextItemId
  ));
  if (activeRun) throw new CodingRunError("This issue already has an active coding run", 409);
  const otherPending = approvals.docs.find((entry) => (
    entry.id !== approvalId
    && entry.data().decisionStatus === "pending"
    && entry.data().action?.kind === "coding.issue.implement"
    && entry.data().action?.github?.issueContextItemId === input.issueContextItemId
  ));
  if (otherPending) throw new CodingRunError("This issue already has a pending coding approval", 409);
  return requestWorkflowActionApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    approvalId,
    approverUid: approver.uid,
    approverName: approver.displayName,
    action,
    source,
  }, {
    database,
    resolveActiveMember: async (_companyId, uid) => {
      if (uid !== approver.uid) throw new CodingRunError("Coding approver changed", 409);
      return approver;
    },
  }) as Promise<Record<string, unknown>>;
}

function linkedAttemptIdentity(runId: string, run: Record<string, unknown>): {
  rootRunId: string;
  attempt: number;
} {
  const prior = run.linkedAttempt as Record<string, unknown> | undefined;
  const priorAttempt = Number(prior?.attempt || 1);
  const attempt = priorAttempt + 1;
  if (!Number.isSafeInteger(attempt) || attempt < 2 || attempt > 100) {
    throw new CodingRunError("This coding attempt chain reached its limit", 409);
  }
  return {
    rootRunId: String(prior?.rootRunId || runId),
    attempt,
  };
}

export async function requestCodingRetryApproval(input: {
  companyId: string;
  actorUid: string;
  runId: string;
  instructions: string;
  configuration: GitHubAppConfiguration;
  preferredApproverUid?: string;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const prior = await getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
  if (!["failed", "cancelled", "no_changes"].includes(String(prior.status))) {
    throw new CodingRunError("Reconcile uncertain publication outcomes before retrying", 409);
  }
  const instructions = input.instructions.trim();
  if (!instructions || instructions.length > 20_000) {
    throw new CodingRunError("Retry instructions are required", 400);
  }
  const identity = linkedAttemptIdentity(input.runId, prior);
  const github = prior.github as Record<string, unknown> | undefined;
  return requestCodingImplementationApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    issueContextItemId: String(github?.issueContextItemId || ""),
    configuration: input.configuration,
    preferredApproverUid: input.preferredApproverUid,
    workflowId: "coding.issue.retry",
    linkedAttempt: {
      kind: "retry",
      parentRunId: input.runId,
      rootRunId: identity.rootRunId,
      attempt: identity.attempt,
      instructions,
    },
    database,
    fetcher: input.fetcher,
  });
}

export async function requestCodingPullRequestChangesApproval(input: {
  companyId: string;
  actorUid: string;
  runId: string;
  instructions: string;
  configuration: GitHubAppConfiguration;
  inspectPublication: (value: {
    installationId: number;
    repositoryId: number;
    fullName: string;
    resultBranch: string;
    baseBranch: string;
  }) => Promise<GitHubPublicationSnapshot>;
  preferredApproverUid?: string;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
}): Promise<Record<string, unknown>> {
  const database = input.database || db;
  const prior = await getCodingRun({
    companyId: input.companyId,
    runId: input.runId,
    database,
  });
  if (prior.status !== "succeeded") {
    throw new CodingRunError("Only a published coding run can receive PR changes", 409);
  }
  const instructions = input.instructions.trim();
  if (!instructions || instructions.length > 20_000) {
    throw new CodingRunError("Pull request change instructions are required", 400);
  }
  const github = prior.github as Record<string, unknown> | undefined;
  const git = prior.git as Record<string, unknown> | undefined;
  const publication = prior.publicationResult as Record<string, unknown> | undefined;
  const approvalId = String((prior.authorization as Record<string, unknown> | undefined)?.approvalId || "");
  const approval = await database.doc(
    `companies/${input.companyId}/actionApprovals/${approvalId}`,
  ).get();
  const installationId = Number(approval.data()?.action?.github?.installationId);
  const snapshot = await input.inspectPublication({
    installationId,
    repositoryId: Number(github?.repositoryId),
    fullName: `${String(github?.owner)}/${String(github?.repo)}`,
    resultBranch: String(git?.proposedBranch),
    baseBranch: String(git?.baseBranch),
  });
  const pull = snapshot.pullRequest;
  const expectedSha = String(git?.resultSha || "");
  if (
    !pull
    || pull.state !== "open"
    || pull.number !== Number(publication?.pullRequestNumber)
    || pull.headSha !== expectedSha
    || snapshot.branchSha !== expectedSha
  ) throw new CodingRunError("The pull request changed; reconcile it before requesting changes", 409);
  const identity = linkedAttemptIdentity(input.runId, prior);
  return requestCodingImplementationApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    issueContextItemId: String(github?.issueContextItemId || ""),
    configuration: input.configuration,
    preferredApproverUid: input.preferredApproverUid,
    workflowId: "coding.pr.changes",
    linkedAttempt: {
      kind: "pull_request_changes",
      parentRunId: input.runId,
      rootRunId: identity.rootRunId,
      attempt: identity.attempt,
      instructions,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.url,
    },
    sourceOverride: {
      sourceBranch: pull.headBranch,
      baseSha: pull.headSha,
      resultBranch: pull.headBranch,
    },
    database,
    fetcher: input.fetcher,
  });
}

export async function requestLabeledCodingImplementationApproval(input: {
  companyId: string;
  actorUid: string;
  issueContextItemId: string;
  configuration: GitHubAppConfiguration;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
}): Promise<Record<string, unknown> | null> {
  const database = input.database || db;
  const issue = await database.doc(
    `companies/${input.companyId}/contextItems/${input.issueContextItemId}`,
  ).get();
  const labels = Array.isArray(issue.data()?.metadata?.labels)
    ? issue.data()?.metadata?.labels.map((label: unknown) => String(label).toLowerCase())
    : [];
  if (!issue.exists || issue.data()?.metadata?.state !== "open" || !labels.includes("erik-implement")) {
    return null;
  }
  return requestCodingImplementationApproval({
    ...input,
    database,
    workflowId: "coding.issue.label",
  });
}
