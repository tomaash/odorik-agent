import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { callback, safeError } from "./callback.js";
import { downloadFile } from "./cloud.js";
import {
  createDraftPullRequest,
  findOpenPullRequest,
  githubBranchSha,
  githubPublishingToken,
} from "./github.js";
import { readPublishSpec } from "./publish-spec.js";

const exec = promisify(execFile);

class UnknownPublicationOutcome extends Error {}

export function branchPublicationDecision(input: {
  mode: "create" | "fast_forward";
  currentSha: string | null;
  baseSha: string;
  resultSha: string;
}): "push" | "noop" {
  if (input.currentSha === input.resultSha) return "noop";
  if (input.currentSha === null) return "push";
  if (input.mode === "fast_forward" && input.currentSha === input.baseSha) return "push";
  throw new Error("Approved result branch already exists at a different commit");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function git(args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
} = {}): Promise<string> {
  const result = await exec("git", args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout || 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function runPublisher(): Promise<void> {
  if (process.env.XAI_API_KEY) throw new Error("XAI_API_KEY is forbidden in the publisher");
  const expectedRunId = required("CODING_RUN_ID");
  const callbackUrl = required("CODING_CALLBACK_URL");
  const spec = await readPublishSpec(required("PUBLISH_SPEC_URL"));
  if (spec.runId !== expectedRunId) throw new Error("Publish run ID does not match the environment");
  const root = await mkdtemp(join(tmpdir(), "erik-coding-publish-"));
  let sequence = 0;
  const publish = async (
    type: "phase" | "completed" | "failed",
    phase: string,
    status: "publishing" | "succeeded" | "failed" | "outcome_unknown",
    message: string,
    result?: Record<string, unknown>,
  ) => {
    sequence += 1;
    await callback({
      callbackUrl,
      event: {
        eventId: `publisher-${sequence}-${phase}`,
        runId: spec.runId,
        type,
        phase,
        status,
        message,
        ...(process.env.CLOUD_RUN_EXECUTION
          ? { executionName: process.env.CLOUD_RUN_EXECUTION }
          : {}),
        ...(result ? { result } : {}),
      },
    });
  };

  try {
    await publish("phase", "publishing", "publishing", "Validating approved result artifacts");
    const sourceBundle = join(root, "source.bundle");
    const resultBundle = join(root, "result.bundle");
    const repository = join(root, "repository");
    const [source, result] = await Promise.all([
      downloadFile(spec.objects.source, sourceBundle, 2 * 1024 * 1024 * 1024),
      downloadFile(spec.objects.resultBundle, resultBundle, spec.maxResultBundleBytes),
    ]);
    if (!source.bytes) throw new Error("Approved source bundle is empty");
    if (result.sha256 !== spec.resultBundleSha256) {
      throw new Error("Result bundle checksum does not match the runner completion record");
    }

    await git(["clone", "--no-local", "--", sourceBundle, repository]);
    const baseSha = (await git(["rev-parse", "HEAD"], { cwd: repository })).toLowerCase();
    if (baseSha !== spec.git.baseSha) throw new Error("Source bundle does not match approved base SHA");
    await git(["fetch", "--no-tags", "--", resultBundle, "HEAD"], { cwd: repository });
    const resultSha = (await git(["rev-parse", "FETCH_HEAD"], { cwd: repository })).toLowerCase();
    if (resultSha !== spec.git.resultSha) throw new Error("Result bundle does not match expected result SHA");
    await git(["merge-base", "--is-ancestor", spec.git.baseSha, resultSha], { cwd: repository });

    const privateKey = await readFile(required("GITHUB_PRIVATE_KEY_PATH"), "utf8");
    const token = await githubPublishingToken({
      installationId: spec.github.installationId,
      repositoryId: spec.github.repositoryId,
      configuration: { clientId: required("GITHUB_CLIENT_ID"), privateKey },
    });
    let pull = spec.publication.existingPullRequestNumber
      ? await findOpenPullRequest({
          token,
          fullName: spec.github.fullName,
          headBranch: spec.git.resultBranch,
          baseBranch: spec.git.baseBranch,
        })
      : null;
    if (
      spec.publication.existingPullRequestNumber
      && (!pull || pull.number !== spec.publication.existingPullRequestNumber)
    ) throw new Error("The approved pull request is no longer open at the expected branch");
    const currentBranchSha = await githubBranchSha({
      token,
      fullName: spec.github.fullName,
      branch: spec.git.resultBranch,
    });
    const branchDecision = branchPublicationDecision({
      mode: spec.git.branchMode,
      currentSha: currentBranchSha,
      baseSha: spec.git.baseSha,
      resultSha,
    });
    if (branchDecision === "push") {
      const askpass = join(root, "git-askpass.sh");
      await writeFile(
        askpass,
        "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *) printf '%s\\n' \"$GITHUB_TOKEN\" ;; esac\n",
        { mode: 0o700 },
      );
      await chmod(askpass, 0o700);
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: process.env.LANG || "C.UTF-8",
        HOME: root,
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GITHUB_TOKEN: token,
      };
      await git([
        "remote", "add", "github",
        `https://github.com/${spec.github.fullName}.git`,
      ], { cwd: repository, env: environment });
      try {
        await git([
          "-c", "core.hooksPath=/dev/null",
          "push", "github", `${resultSha}:refs/heads/${spec.git.resultBranch}`,
        ], { cwd: repository, env: environment });
      } catch (error) {
        const reconciled = await githubBranchSha({
          token,
          fullName: spec.github.fullName,
          branch: spec.git.resultBranch,
        });
        if (reconciled !== resultSha) {
          throw new UnknownPublicationOutcome(
            `GitHub branch push outcome is unknown: ${safeError(error)}`,
          );
        }
      }
    }

    pull = await findOpenPullRequest({
      token,
      fullName: spec.github.fullName,
      headBranch: spec.git.resultBranch,
      baseBranch: spec.git.baseBranch,
    });
    if (
      pull
      && spec.publication.existingPullRequestNumber
      && pull.number !== spec.publication.existingPullRequestNumber
    ) {
      throw new UnknownPublicationOutcome(
        "A different pull request appeared while the approved branch was being updated",
      );
    }
    if (!pull) {
      if (spec.publication.existingPullRequestNumber) {
        throw new UnknownPublicationOutcome(
          "The approved pull request closed while its branch was being updated",
        );
      }
      try {
        pull = await createDraftPullRequest({
          token,
          fullName: spec.github.fullName,
          headBranch: spec.git.resultBranch,
          baseBranch: spec.git.baseBranch,
          title: spec.publication.prTitle,
          body: spec.publication.prBody,
        });
      } catch (error) {
        pull = await findOpenPullRequest({
          token,
          fullName: spec.github.fullName,
          headBranch: spec.git.resultBranch,
          baseBranch: spec.git.baseBranch,
        });
        if (!pull) {
          throw new UnknownPublicationOutcome(
            `GitHub pull request creation outcome is unknown: ${safeError(error)}`,
          );
        }
      }
    }
    await publish(
      "completed",
      "succeeded",
      "succeeded",
      spec.git.branchMode === "fast_forward"
        ? "Pull request branch updated"
        : "Draft pull request opened",
      {
      baseSha: spec.git.baseSha,
      resultSha,
      branch: spec.git.resultBranch,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.htmlUrl,
      draft: pull.draft,
      approvalId: spec.approval.approvalId,
      effectDigest: spec.approval.effectDigest,
      },
    );
  } catch (error) {
    const unknown = error instanceof UnknownPublicationOutcome;
    await publish(
      "failed",
      unknown ? "outcome_unknown" : "publish_failed",
      unknown ? "outcome_unknown" : "failed",
      safeError(error),
    ).catch(() => undefined);
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
