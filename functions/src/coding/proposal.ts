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
import { CodingRunError } from "./repository.js";

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
  workflowId?: "coding.issue.manual" | "coding.issue.label";
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

  const baseSha = await resolveGitHubRepositoryBaseSha({
    configuration: input.configuration,
    installationId,
    repositoryId,
    fullName,
    baseBranch,
    fetcher: input.fetcher,
  });
  const workflowId = input.workflowId || "coding.issue.manual";
  const fingerprint = sha256Hex(JSON.stringify({
    companyId: input.companyId,
    workflowId,
    workflowVersion: codingWorkflowVersion,
    issueContextItemId: input.issueContextItemId,
    issueVersion,
    issueChecksum,
    baseSha,
  }));
  const runId = `coding_${fingerprint.slice(0, 32)}`;
  const approvalId = `coding_approval_${fingerprint.slice(0, 40)}`;
  const title = boundedTitle(issueData.title);
  const action: CodingIssueImplementAction = {
    kind: "coding.issue.implement",
    runId,
    title,
    issueExcerpt: String(issueData.text || "").slice(0, 5_000),
    issuePrompt: String(issueData.text || "").slice(0, 100_000),
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
      baseSha,
      resultBranch: `erik/issue-${issueNumber}-${runId.slice(-8)}`,
    },
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
        `Closes #${issueNumber}`,
        "",
        "Implemented by Agent Erik using the connected Grok subscription.",
        `Coding run: ${runId}`,
        `Approval: ${approvalId}`,
        `Approved base: ${baseSha}`,
      ].join("\n"),
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
