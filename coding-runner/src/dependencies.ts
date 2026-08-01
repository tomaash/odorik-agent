import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export type DependencyPreparation = {
  kind: "none" | "preinstalled" | "unavailable";
  durationMs: number;
};

export async function prepareDependencies(repositoryPath: string): Promise<DependencyPreparation> {
  const started = Date.now();
  const packageJson = join(repositoryPath, "package.json");
  if (!(await exists(packageJson))) {
    return { kind: "none", durationMs: 0 };
  }

  // Dependency trees are runtime input, not a coding result. Excluding caches
  // also prevents a repository that forgot node_modules in .gitignore from
  // producing a huge accidental patch.
  await appendFile(
    join(repositoryPath, ".git", "info", "exclude"),
    "\nnode_modules/\n.npm/\n.pnpm-store/\n.yarn/cache/\n",
  );
  // Never resolve repository-controlled dependencies in the privileged runner
  // supervisor. Even with lifecycle scripts disabled, package metadata can
  // trigger network requests while Cloud Run metadata is reachable. A later
  // credential-free preparation job may provide a prebuilt dependency tree.
  return {
    kind: await exists(join(repositoryPath, "node_modules")) ? "preinstalled" : "unavailable",
    durationMs: Date.now() - started,
  };
}
