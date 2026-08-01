export type DispatchSpec = {
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
  grok: { connectionId: string; authKind: "subscription_oauth" };
  proposedBranch: string;
  sourceBranch: string;
  baseSha: string;
  approval: { approvalId: string; approvedBy: string; effectDigest: string };
  publication: { draft: true; prTitle: string; prBody: string };
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

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeString(value: unknown, name: string, pattern: RegExp, max = 500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

export function parseDispatchSpec(value: unknown): DispatchSpec {
  const root = object(value, "dispatch spec");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const github = object(root.github, "github");
  const grok = object(root.grok, "grok");
  const objects = object(root.objects, "objects");
  const limits = object(root.limits, "limits");
  const approval = object(root.approval, "approval");
  const publication = object(root.publication, "publication");
  const companyId = safeString(root.companyId, "companyId", /^[a-z0-9][a-z0-9_-]{1,63}$/);
  const runId = safeString(root.runId, "runId", /^coding_[a-f0-9]{32}$/);
  const objectPrefix = `companies/${companyId}/coding-runs/${runId}/`;
  const safeObject = (value: unknown, name: string) => {
    const result = safeString(value, name, /^[A-Za-z0-9][A-Za-z0-9/_.-]+$/);
    if (!result.startsWith(objectPrefix) || result.includes("..")) {
      throw new Error(`${name} is outside the run object prefix`);
    }
    return result;
  };
  if (grok.authKind !== "subscription_oauth") throw new Error("Only subscription OAuth is allowed");
  if (publication.draft !== true) throw new Error("publication.draft must be true");
  return {
    schemaVersion: 1,
    runId,
    companyId,
    github: {
      connectionId: safeString(github.connectionId, "github.connectionId", /^github_[0-9]{1,20}$/),
      installationId: integer(github.installationId, "github.installationId", 1, Number.MAX_SAFE_INTEGER),
      repoResourceId: safeString(github.repoResourceId, "github.repoResourceId", /^repo_[a-f0-9]{24}$/),
      repositoryId: integer(github.repositoryId, "github.repositoryId", 1, Number.MAX_SAFE_INTEGER),
      fullName: safeString(github.fullName, "github.fullName", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      defaultBranch: safeString(github.defaultBranch, "github.defaultBranch", /^[A-Za-z0-9._/-]+$/, 200),
      issueNumber: integer(github.issueNumber, "github.issueNumber", 1, 2_147_483_647),
      issueContextItemId: safeString(
        github.issueContextItemId,
        "github.issueContextItemId",
        /^github_issue_[a-f0-9]{32}$/,
      ),
      issueVersion: safeString(github.issueVersion, "github.issueVersion", /^[^\r\n\0]+$/, 200),
      issueChecksum: safeString(github.issueChecksum, "github.issueChecksum", /^[a-f0-9]{64}$/),
      issuePrompt: safeString(github.issuePrompt, "github.issuePrompt", /^[\s\S]+$/, 100_000),
    },
    grok: {
      connectionId: safeString(grok.connectionId, "grok.connectionId", /^grok_subscription$/),
      authKind: "subscription_oauth",
    },
    proposedBranch: safeString(root.proposedBranch, "proposedBranch", /^erik\/[A-Za-z0-9._/-]+$/, 200),
    sourceBranch: root.sourceBranch === undefined
      ? safeString(github.defaultBranch, "github.defaultBranch", /^[A-Za-z0-9._/-]+$/, 200)
      : safeString(root.sourceBranch, "sourceBranch", /^[A-Za-z0-9._/-]+$/, 200),
    baseSha: safeString(root.baseSha, "baseSha", /^[a-f0-9]{40,64}$/),
    approval: {
      approvalId: safeString(approval.approvalId, "approval.approvalId", /^[A-Za-z0-9_-]+$/, 200),
      approvedBy: safeString(approval.approvedBy, "approval.approvedBy", /^[^\r\n\0]+$/, 200),
      effectDigest: safeString(approval.effectDigest, "approval.effectDigest", /^[a-f0-9]{64}$/),
    },
    publication: {
      draft: true,
      prTitle: safeString(publication.prTitle, "publication.prTitle", /^[^\r\n\0]+$/, 256),
      prBody: safeString(publication.prBody, "publication.prBody", /^[\s\S]+$/, 10_000),
    },
    objects: {
      source: safeObject(objects.source, "objects.source"),
      runSpec: safeObject(objects.runSpec, "objects.runSpec"),
      artifact: safeObject(objects.artifact, "objects.artifact"),
      patch: safeObject(objects.patch, "objects.patch"),
      resultBundle: safeObject(objects.resultBundle, "objects.resultBundle"),
      publishSpec: safeObject(objects.publishSpec, "objects.publishSpec"),
    },
    limits: {
      maxSourceBytes: integer(limits.maxSourceBytes, "limits.maxSourceBytes", 1_024, 8 * 1024 ** 3),
      maxArtifactBytes: integer(limits.maxArtifactBytes, "limits.maxArtifactBytes", 1_024, 500 * 1024 ** 2),
      maxChangedFiles: integer(limits.maxChangedFiles, "limits.maxChangedFiles", 1, 5_000),
      maxPatchBytes: integer(limits.maxPatchBytes, "limits.maxPatchBytes", 1_024, 100 * 1024 ** 2),
      maxTurns: integer(limits.maxTurns, "limits.maxTurns", 1, 100),
    },
  };
}

export async function readDispatchSpec(urlValue: string): Promise<DispatchSpec> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("DISPATCH_SPEC_URL must be an HTTPS URL without credentials");
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { "user-agent": "agent-erik-coding-dispatcher/0.1" },
  });
  if (!response.ok) throw new Error(`dispatch spec download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024) throw new Error("dispatch spec is too large");
  return parseDispatchSpec(JSON.parse(new TextDecoder().decode(bytes)));
}
