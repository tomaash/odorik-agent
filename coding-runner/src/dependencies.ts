import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { requireSuccessfulCommand } from "./command.js";
import { runtimeIdentity } from "./security.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export type DependencyPreparation = {
  kind: "none" | "npm-ci-ignore-scripts";
  durationMs: number;
};

export async function prepareDependencies(repositoryPath: string): Promise<DependencyPreparation> {
  const packageJson = join(repositoryPath, "package.json");
  const packageLock = join(repositoryPath, "package-lock.json");
  if (!(await exists(packageJson)) || !(await exists(packageLock))) {
    return { kind: "none", durationMs: 0 };
  }

  // Dependency trees are runtime input, not a coding result. Excluding caches
  // also prevents a repository that forgot node_modules in .gitignore from
  // producing a huge accidental patch.
  await appendFile(
    join(repositoryPath, ".git", "info", "exclude"),
    "\nnode_modules/\n.npm/\n.pnpm-store/\n.yarn/cache/\n",
  );
  const identity = runtimeIdentity();
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: identity.workspaceUid === undefined ? process.env.HOME : "/home/workspace",
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "true",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
  const result = await requireSuccessfulCommand(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: repositoryPath,
      env: environment,
      timeoutMs: 15 * 60 * 1000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
      ...(identity.workspaceUid === undefined
        ? {}
        : { uid: identity.workspaceUid, gid: identity.workspaceGid }),
    },
  );
  return { kind: "npm-ci-ignore-scripts", durationMs: result.durationMs };
}
