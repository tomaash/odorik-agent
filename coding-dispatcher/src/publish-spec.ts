export type PublishSpec = {
  schemaVersion: 1;
  runId: string;
  companyId: string;
  approval: { approvalId: string; approvedBy: string; effectDigest: string };
  github: {
    installationId: number;
    repositoryId: number;
    fullName: string;
    issueNumber: number;
  };
  git: {
    baseBranch: string;
    baseSha: string;
    resultBranch: string;
    resultSha: string;
    branchMode: "create" | "fast_forward";
  };
  publication: {
    draft: true;
    prTitle: string;
    prBody: string;
    existingPullRequestNumber?: number;
  };
  objects: { source: string; resultBundle: string };
  resultBundleSha256: string;
  maxResultBundleBytes: number;
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, pattern: RegExp, max = 500): string {
  if (typeof value !== "string" || !value || value.length > max || !pattern.test(value)) {
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

export function parsePublishSpec(value: unknown): PublishSpec {
  const root = object(value, "publish spec");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const approval = object(root.approval, "approval");
  const github = object(root.github, "github");
  const git = object(root.git, "git");
  const publication = object(root.publication, "publication");
  const objects = object(root.objects, "objects");
  const companyId = text(root.companyId, "companyId", /^[a-z0-9][a-z0-9_-]{1,63}$/);
  const runId = text(root.runId, "runId", /^coding_[a-f0-9]{32}$/);
  const prefix = `companies/${companyId}/coding-runs/${runId}/`;
  const artifact = (value: unknown, name: string) => {
    const result = text(value, name, /^[A-Za-z0-9][A-Za-z0-9/_.-]+$/);
    if (!result.startsWith(prefix) || result.includes("..")) {
      throw new Error(`${name} is outside the approved run prefix`);
    }
    return result;
  };
  if (publication.draft !== true) throw new Error("Only draft pull requests are allowed");
  const parsed: PublishSpec = {
    schemaVersion: 1,
    runId,
    companyId,
    approval: {
      approvalId: text(approval.approvalId, "approval.approvalId", /^[A-Za-z0-9_-]+$/, 200),
      approvedBy: text(approval.approvedBy, "approval.approvedBy", /^[^\r\n\0]+$/, 200),
      effectDigest: text(approval.effectDigest, "approval.effectDigest", /^[a-f0-9]{64}$/),
    },
    github: {
      installationId: integer(github.installationId, "github.installationId", 1, Number.MAX_SAFE_INTEGER),
      repositoryId: integer(github.repositoryId, "github.repositoryId", 1, Number.MAX_SAFE_INTEGER),
      fullName: text(github.fullName, "github.fullName", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      issueNumber: integer(github.issueNumber, "github.issueNumber", 1, 2_147_483_647),
    },
    git: {
      baseBranch: text(git.baseBranch, "git.baseBranch", /^[A-Za-z0-9._/-]+$/, 200),
      baseSha: text(git.baseSha, "git.baseSha", /^[a-f0-9]{40,64}$/),
      resultBranch: text(git.resultBranch, "git.resultBranch", /^erik\/[A-Za-z0-9._/-]+$/, 200),
      resultSha: text(git.resultSha, "git.resultSha", /^[a-f0-9]{40,64}$/),
      branchMode: git.branchMode === undefined
        ? "create"
        : text(git.branchMode, "git.branchMode", /^(create|fast_forward)$/) as "create" | "fast_forward",
    },
    publication: {
      draft: true,
      prTitle: text(publication.prTitle, "publication.prTitle", /^[^\r\n\0]+$/, 256),
      prBody: text(publication.prBody, "publication.prBody", /^[\s\S]+$/, 10_000),
      ...(publication.existingPullRequestNumber === undefined
        ? {}
        : {
            existingPullRequestNumber: integer(
              publication.existingPullRequestNumber,
              "publication.existingPullRequestNumber",
              1,
              2_147_483_647,
            ),
          }),
    },
    objects: {
      source: artifact(objects.source, "objects.source"),
      resultBundle: artifact(objects.resultBundle, "objects.resultBundle"),
    },
    resultBundleSha256: text(
      root.resultBundleSha256,
      "resultBundleSha256",
      /^[a-f0-9]{64}$/,
    ),
    maxResultBundleBytes: integer(
      root.maxResultBundleBytes,
      "maxResultBundleBytes",
      1_024,
      500 * 1024 * 1024,
    ),
  };
  if (
    (parsed.git.branchMode === "fast_forward")
    !== (parsed.publication.existingPullRequestNumber !== undefined)
  ) {
    throw new Error("Linked pull request updates require fast-forward publication mode");
  }
  return parsed;
}

export async function readPublishSpec(urlValue: string): Promise<PublishSpec> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("PUBLISH_SPEC_URL must be an HTTPS URL without credentials");
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { "user-agent": "agent-erik-coding-publisher/0.1" },
  });
  if (!response.ok) throw new Error(`publish spec download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024) throw new Error("publish spec is too large");
  return parsePublishSpec(JSON.parse(new TextDecoder().decode(bytes)));
}
