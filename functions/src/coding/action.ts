import { z } from "zod";
import type {
  ActionDescriptor,
  ApprovedActionExecutionContext,
} from "../actions/registry.js";
import { startApprovedCodingRun } from "./service.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

export const codingIssueImplementActionSchema = z.object({
  kind: z.literal("coding.issue.implement"),
  runId: z.string().regex(/^coding_[a-f0-9]{32}$/),
  title: z.string().min(1).max(300),
  issueExcerpt: z.string().max(5_000),
  issuePrompt: z.string().min(1).max(100_000),
  github: z.object({
    connectionId: z.string().regex(/^github_[0-9]{1,20}$/),
    installationId: z.number().int().positive(),
    repoResourceId: z.string().regex(/^repo_[a-f0-9]{24}$/),
    repositoryId: z.number().int().positive(),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    issueNumber: z.number().int().positive(),
    issueContextItemId: z.string().regex(/^github_issue_[a-f0-9]{32}$/),
    issueUrl: z.string().url().max(2_000),
    issueVersion: z.string().min(1).max(200),
    issueChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  git: z.object({
    baseBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
    baseSha: shaSchema,
    resultBranch: z.string().regex(/^erik\/[A-Za-z0-9._/-]{1,190}$/),
  }).strict(),
  grok: z.object({
    connectionId: z.literal("grok_subscription"),
    authKind: z.literal("subscription_oauth"),
  }).strict(),
  limits: z.object({
    maxRuntimeMinutes: z.number().int().min(1).max(60),
    maxTurns: z.number().int().min(1).max(100),
    maxChangedFiles: z.number().int().min(1).max(5_000),
    maxPatchBytes: z.number().int().min(1_024).max(100 * 1024 * 1024),
    maxArtifactBytes: z.number().int().min(1_024).max(500 * 1024 * 1024),
  }).strict(),
  publication: z.object({
    draft: z.literal(true),
    prTitle: z.string().min(1).max(256),
    prBody: z.string().min(1).max(10_000),
  }).strict(),
}).strict();

export type CodingIssueImplementAction = z.infer<typeof codingIssueImplementActionSchema>;

const codingRunQueuedResultSchema = z.object({
  codingRunId: z.string().regex(/^coding_[a-f0-9]{32}$/),
  status: z.enum(["queued", "packaging"]),
}).strict();

export type CodingActionExecutor = (
  context: ApprovedActionExecutionContext,
  action: CodingIssueImplementAction,
) => Promise<z.infer<typeof codingRunQueuedResultSchema>>;

export function createCodingIssueImplementDescriptor(
  executeAction: CodingActionExecutor = async (context, action) => {
    const run = await startApprovedCodingRun({ context, action });
    return {
      codingRunId: String(run.id),
      status: run.status === "packaging" ? "packaging" : "queued",
    };
  },
): ActionDescriptor<
  CodingIssueImplementAction,
  z.infer<typeof codingRunQueuedResultSchema>
> {
  return {
    kind: "coding.issue.implement",
    capabilityId: "action.coding.issue.implement",
    contractVersion: 1,
    category: "external.write",
    inputSchema: codingIssueImplementActionSchema,
    resultSchema: codingRunQueuedResultSchema,
    authorization: {
      requiresApproval: true,
      providerCapabilityId: "github.contents_and_pull_requests.write",
    },
    reversibility: "compensatable",
    idempotency: "provider_aware",
    reconciliation: "required_before_retry",
    async prepareForApproval(_context, action) {
      return action;
    },
    async assertRequestPreconditions(context, action) {
      const [issue, connection, resource, grok] = await Promise.all([
        context.transaction.get(context.database.doc(
          `companies/${context.companyId}/contextItems/${action.github.issueContextItemId}`,
        )),
        context.transaction.get(context.database.doc(
          `companies/${context.companyId}/connections/${action.github.connectionId}`,
        )),
        context.transaction.get(context.database.doc(
          `companies/${context.companyId}/connections/${action.github.connectionId}`
            + `/resources/${action.github.repoResourceId}`,
        )),
        context.transaction.get(context.database.doc(
          `companies/${context.companyId}/connections/${action.grok.connectionId}`,
        )),
      ]);
      const issueData = issue.data() || {};
      if (
        !issue.exists
        || issueData.kind !== "github.issue"
        || issueData.metadata?.state !== "open"
        || issueData.source?.connectionId !== action.github.connectionId
        || issueData.source?.resourceId !== action.github.repoResourceId
        || String(issueData.source?.version || "") !== action.github.issueVersion
        || String(issueData.provenance?.checksum || "") !== action.github.issueChecksum
      ) throw new Error("The GitHub issue changed before approval could be requested");
      if (
        !connection.exists
        || connection.data()?.connectorId !== "github"
        || connection.data()?.status !== "active"
        || Number(connection.data()?.installationId) !== action.github.installationId
      ) throw new Error("The GitHub connection is not active");
      if (
        !resource.exists
        || resource.data()?.status !== "enabled"
        || Number(resource.data()?.externalId) !== action.github.repositoryId
      ) throw new Error("The issue repository is not selected");
      if (
        !grok.exists
        || grok.data()?.status !== "active"
        || grok.data()?.subscription?.state !== "active"
      ) throw new Error("The Grok subscription is not active");
    },
    scope: (action) => ({
      contactId: null,
      callId: null,
      caseId: null,
      issueContextItemId: action.github.issueContextItemId,
    }),
    execute: executeAction,
    resultId: (_action, result) => result.codingRunId,
    resultReference: (_action, result) => ({
      kind: "coding_run",
      id: result.codingRunId,
    }),
    classifyFailure: () => "failed_safe_to_retry",
  };
}

export const codingIssueImplementDescriptor = createCodingIssueImplementDescriptor();

export const codingActionDescriptors = [codingIssueImplementDescriptor] as const;
