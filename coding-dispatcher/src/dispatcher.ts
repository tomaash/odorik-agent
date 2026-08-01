import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { callback, safeError } from "./callback.js";
import { executeRunner, signedUrl, uploadFile, uploadJson } from "./cloud.js";
import { canonicalCodingSource } from "./github.js";
import { readDispatchSpec } from "./spec.js";

const exec = promisify(execFile);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function createSourceBundle(input: {
  cloneUrl: string;
  defaultBranch: string;
  expectedSha: string;
  token: string;
  root: string;
}): Promise<string> {
  const repository = join(input.root, "repository.git");
  const bundle = join(input.root, "source.bundle");
  const askpass = join(input.root, "git-askpass.sh");
  await writeFile(
    askpass,
    "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *) printf '%s\\n' \"$GITHUB_TOKEN\" ;; esac\n",
    { mode: 0o700 },
  );
  await chmod(askpass, 0o700);
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || "C.UTF-8",
    HOME: input.root,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_TOKEN: input.token,
  };
  await exec("git", [
    "-c", "core.hooksPath=/dev/null",
    "clone", "--bare", "--single-branch", "--branch", input.defaultBranch,
    "--", input.cloneUrl, repository,
  ], { env: environment, timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  const resolved = (await exec("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    env: environment,
    timeout: 60_000,
  })).stdout.trim().toLowerCase();
  if (resolved !== input.expectedSha) throw new Error("Cloned repository SHA does not match GitHub");
  await exec("git", ["bundle", "create", bundle, "HEAD"], {
    cwd: repository,
    env: environment,
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  await exec("git", ["bundle", "verify", bundle], {
    cwd: repository,
    env: environment,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return bundle;
}

export async function runDispatcher(): Promise<void> {
  if (process.env.XAI_API_KEY) throw new Error("XAI_API_KEY is forbidden in the dispatcher");
  const expectedRunId = required("CODING_RUN_ID");
  const callbackUrl = required("CODING_CALLBACK_URL");
  const dispatchSpecUrl = required("DISPATCH_SPEC_URL");
  let runId = expectedRunId;
  let sequence = 0;
  const publish = async (
    phase: string,
    status: "packaging" | "provisioning" | "running" | "failed",
    message: string,
    result?: Record<string, unknown>,
    executionName?: string,
  ) => {
    sequence += 1;
    await callback({
      callbackUrl,
      event: {
        eventId: `dispatcher-${sequence}-${phase}`,
        runId,
        type: status === "failed" ? "failed" : "phase",
        phase,
        status,
        message,
        ...(result ? { result } : {}),
        ...(executionName ? { executionName } : {}),
      },
    });
  };
  const root = await mkdtemp(join(tmpdir(), "erik-coding-dispatch-"));
  try {
    const spec = await readDispatchSpec(dispatchSpecUrl);
    runId = spec.runId;
    if (runId !== expectedRunId) throw new Error("Dispatch run ID does not match the environment");
    await publish("packaging", "packaging", "Refetching canonical GitHub issue and repository");
    const privateKey = await readFile(required("GITHUB_PRIVATE_KEY_PATH"), "utf8");
    const source = await canonicalCodingSource({
      installationId: spec.github.installationId,
      repositoryId: spec.github.repositoryId,
      fullName: spec.github.fullName,
      expectedDefaultBranch: spec.github.defaultBranch,
      expectedBaseSha: spec.baseSha,
      issueNumber: spec.github.issueNumber,
      expectedIssueVersion: spec.github.issueVersion,
      configuration: {
        clientId: required("GITHUB_CLIENT_ID"),
        privateKey,
      },
    });
    const bundlePath = await createSourceBundle({
      cloneUrl: source.repository.clone_url,
      defaultBranch: source.repository.default_branch,
      expectedSha: source.baseSha,
      token: source.token,
      root,
    });
    const bundle = await uploadFile(spec.objects.source, bundlePath, "application/octet-stream");
    if (bundle.bytes > spec.limits.maxSourceBytes) throw new Error("Source bundle exceeds its limit");
    const [sourceUrl, artifactUrl, patchUrl, resultBundleUrl] = await Promise.all([
      signedUrl(spec.objects.source, "read"),
      signedUrl(spec.objects.artifact, "write", "application/gzip"),
      signedUrl(spec.objects.patch, "write", "text/x-diff; charset=utf-8"),
      signedUrl(spec.objects.resultBundle, "write", "application/octet-stream"),
    ]);
    const runSpec = {
      schemaVersion: 1,
      runId,
      source: { downloadUrl: sourceUrl, sha256: bundle.sha256, baseSha: source.baseSha },
      task: {
        title: source.issue.title,
        prompt: spec.github.issuePrompt,
        sourceUrl: source.issue.html_url,
      },
      agent: { maxTurns: spec.limits.maxTurns },
      artifacts: {
        uploadUrl: artifactUrl,
        patchUploadUrl: patchUrl,
        resultBundleUploadUrl: resultBundleUrl,
      },
      limits: {
        maxSourceBytes: spec.limits.maxSourceBytes,
        maxArtifactBytes: spec.limits.maxArtifactBytes,
        maxChangedFiles: spec.limits.maxChangedFiles,
        maxPatchBytes: spec.limits.maxPatchBytes,
      },
    };
    await uploadJson(spec.objects.runSpec, runSpec);
    const runSpecUrl = await signedUrl(spec.objects.runSpec, "read");
    await publish("provisioning", "provisioning", "Immutable source prepared; starting coding runner", {
      baseSha: source.baseSha,
      issueUpdatedAt: source.issue.updated_at,
      sourceBytes: bundle.bytes,
    });
    const execution = await executeRunner({ runId, runSpecUrl, callbackUrl });
    await publish(
      "runner_queued",
      "provisioning",
      "Isolated coding runner queued",
      { baseSha: source.baseSha, runnerOperationName: execution.operationName },
      execution.executionName,
    );
  } catch (error) {
    await publish("dispatch_failed", "failed", safeError(error)).catch(() => undefined);
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
