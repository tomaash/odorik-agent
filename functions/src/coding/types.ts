export type CodingRunStatus =
  | "queued"
  | "packaging"
  | "provisioning"
  | "running"
  | "ready_to_publish"
  | "publishing"
  | "succeeded"
  | "no_changes"
  | "outcome_unknown"
  | "cancel_requested"
  | "cancelled"
  | "failed";

export const activeCodingRunStatuses: CodingRunStatus[] = [
  "queued",
  "packaging",
  "provisioning",
  "running",
  "ready_to_publish",
  "publishing",
  "cancel_requested",
];

export type CodingDispatchSpec = {
  schemaVersion: 1;
  runId: string;
  companyId: string;
  github: {
    connectionId: string;
    installationId: number;
    repoResourceId: string;
    repositoryId: number;
    fullName: string;
    defaultBranch: string;
    issueNumber: number;
    issueContextItemId: string;
    issueVersion: string;
    issueChecksum: string;
    issuePrompt: string;
  };
  grok: {
    connectionId: string;
    authKind: "subscription_oauth";
  };
  proposedBranch: string;
  sourceBranch: string;
  baseSha: string;
  approval: {
    approvalId: string;
    approvedBy: string;
    effectDigest: string;
  };
  publication: {
    draft: true;
    prTitle: string;
    prBody: string;
  };
  objects: {
    source: string;
    runSpec: string;
    artifact: string;
    patch: string;
    resultBundle: string;
    publishSpec: string;
  };
  limits: {
    maxSourceBytes: number;
    maxArtifactBytes: number;
    maxChangedFiles: number;
    maxPatchBytes: number;
    maxTurns: number;
  };
};

export type CodingPublisherExecutor = (input: {
  runId: string;
  publishSpecUrl: string;
}) => Promise<{ operationName: string; executionName?: string }>;

export type CodingDispatcherExecutor = (input: {
  runId: string;
  dispatchSpecUrl: string;
}) => Promise<{ operationName: string; executionName?: string }>;

export type CodingAuthRefreshExecutor = (input: {
  runId: string;
}) => Promise<{ operationName: string; executionName?: string }>;

export type CodingCallbackEvent = {
  eventId: string;
  runId: string;
  type: "phase" | "completed" | "failed";
  phase: string;
  status: CodingRunStatus;
  message: string;
  executionName?: string;
  result?: Record<string, unknown>;
};
