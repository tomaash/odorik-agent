import { chmod, chown, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireSuccessfulCommand, runCommand } from "./command.js";
import { findLikelySecret } from "./redact.js";
import { runtimeIdentity, WORKSPACE_GID } from "./security.js";
import type { CodingRunSpec } from "./spec.js";

export const REPOSITORY_DIRECTORY_MODE = 0o770;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};

function workspaceCommandOptions(cwd?: string) {
  const identity = runtimeIdentity();
  return {
    ...(cwd ? { cwd } : {}),
    env: GIT_ENV,
    timeoutMs: 10 * 60 * 1000,
    ...(identity.workspaceUid === undefined
      ? {}
      : { uid: identity.workspaceUid, gid: identity.workspaceGid }),
  };
}

async function makeGroupWritable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await chmod(child, 0o770);
      await makeGroupWritable(child);
    } else if (entry.isFile()) {
      const info = await stat(child);
      await chmod(child, info.mode | 0o060);
    }
  }
}

export async function cloneBundle(
  bundlePath: string,
  repositoryPath: string,
  expectedBaseSha: string,
): Promise<string> {
  const identity = runtimeIdentity();
  await mkdir(repositoryPath, { recursive: true, mode: REPOSITORY_DIRECTORY_MODE });
  if (identity.workspaceUid !== undefined) {
    await chown(repositoryPath, identity.workspaceUid, WORKSPACE_GID);
  }
  await requireSuccessfulCommand("git", ["clone", "--no-local", bundlePath, repositoryPath], {
    ...workspaceCommandOptions(),
  });
  await requireSuccessfulCommand("git", ["remote", "remove", "origin"], workspaceCommandOptions(repositoryPath));
  await requireSuccessfulCommand(
    "git",
    ["config", "--local", "credential.helper", ""],
    workspaceCommandOptions(repositoryPath),
  );
  await requireSuccessfulCommand(
    "git",
    ["config", "--local", "core.hooksPath", "/dev/null"],
    workspaceCommandOptions(repositoryPath),
  );
  const resolved = (
    await requireSuccessfulCommand("git", ["rev-parse", "HEAD"], workspaceCommandOptions(repositoryPath))
  ).stdout.trim().toLowerCase();
  if (resolved !== expectedBaseSha) {
    throw new Error(`Source bundle HEAD ${resolved} does not match expected base SHA`);
  }
  await makeGroupWritable(repositoryPath);
  await chmod(repositoryPath, REPOSITORY_DIRECTORY_MODE);
  return resolved;
}

export type ChangeArtifact = {
  baseSha: string;
  resultSha: string;
  changedFiles: number;
  patchBytes: number;
  hasChanges: boolean;
};

export async function createChangeArtifacts(
  repositoryPath: string,
  artifactDirectory: string,
  spec: CodingRunSpec,
): Promise<ChangeArtifact> {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await requireSuccessfulCommand("git", ["add", "-A"], workspaceCommandOptions(repositoryPath));
  const names = await requireSuccessfulCommand(
    "git",
    ["diff", "--cached", "--name-only", "-z", spec.source.baseSha],
    { ...workspaceCommandOptions(repositoryPath), maxStdoutBytes: 10 * 1024 * 1024 },
  );
  const changedNames = names.stdout.split("\0").filter(Boolean);
  if (changedNames.length > spec.limits.maxChangedFiles) {
    throw new Error(`Run changed ${changedNames.length} files; limit is ${spec.limits.maxChangedFiles}`);
  }

  const patch = await requireSuccessfulCommand(
    "git",
    ["diff", "--cached", "--binary", "--no-ext-diff", spec.source.baseSha],
    {
      ...workspaceCommandOptions(repositoryPath),
      maxStdoutBytes: spec.limits.maxPatchBytes + 1,
      maxStderrBytes: 1024 * 1024,
    },
  );
  const patchBytes = Buffer.byteLength(patch.stdout);
  if (patch.stdoutTruncated || patchBytes > spec.limits.maxPatchBytes) {
    throw new Error(`Patch exceeds ${spec.limits.maxPatchBytes} bytes`);
  }
  const likelySecret = findLikelySecret(patch.stdout);
  if (likelySecret) throw new Error(`Patch blocked by secret scan: ${likelySecret}`);
  await writeFile(join(artifactDirectory, "changes.patch"), patch.stdout, { mode: 0o600 });
  await writeFile(join(artifactDirectory, "changed-files.txt"), `${changedNames.join("\n")}\n`, {
    mode: 0o600,
  });

  if (changedNames.length === 0) {
    return {
      baseSha: spec.source.baseSha,
      resultSha: spec.source.baseSha,
      changedFiles: 0,
      patchBytes,
      hasChanges: false,
    };
  }

  const commitEnvironment: NodeJS.ProcessEnv = {
    ...GIT_ENV,
    GIT_AUTHOR_NAME: "Agent Erik",
    GIT_AUTHOR_EMAIL: "coding-agent@agenterik.cz",
    GIT_COMMITTER_NAME: "Agent Erik",
    GIT_COMMITTER_EMAIL: "coding-agent@agenterik.cz",
  };
  await requireSuccessfulCommand(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", `Agent Erik run ${spec.runId}`],
    { ...workspaceCommandOptions(repositoryPath), env: commitEnvironment },
  );
  const resultSha = (
    await requireSuccessfulCommand("git", ["rev-parse", "HEAD"], workspaceCommandOptions(repositoryPath))
  ).stdout.trim();
  const bundlePath = join(artifactDirectory, "result.bundle");
  await requireSuccessfulCommand(
    "git",
    ["bundle", "create", bundlePath, "HEAD", `^${spec.source.baseSha}`],
    workspaceCommandOptions(repositoryPath),
  );
  const verify = await runCommand("git", ["bundle", "verify", bundlePath], workspaceCommandOptions(repositoryPath));
  if (verify.code !== 0) throw new Error(`Result bundle verification failed: ${verify.stderr}`);
  return {
    baseSha: spec.source.baseSha,
    resultSha,
    changedFiles: changedNames.length,
    patchBytes,
    hasChanges: true,
  };
}
