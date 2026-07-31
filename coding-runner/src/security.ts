import { chmod, chown, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireSuccessfulCommand } from "./command.js";

export const GROK_UID = 10001;
export const WORKSPACE_UID = 10002;
export const WORKSPACE_GID = 10002;

export type RuntimeIdentity = {
  grokUid?: number;
  workspaceUid?: number;
  workspaceGid?: number;
};

export function runtimeIdentity(): RuntimeIdentity {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { grokUid: GROK_UID, workspaceUid: WORKSPACE_UID, workspaceGid: WORKSPACE_GID };
  }
  return {};
}

export function assertSubscriptionOnlyEnvironment(): void {
  if (process.env.XAI_API_KEY) {
    throw new Error("XAI_API_KEY is forbidden: this runner uses Grok subscription OAuth only");
  }
}

export async function prepareGrokSubscriptionAuth(
  sourcePath: string,
  grokHome: string,
): Promise<void> {
  assertSubscriptionOnlyEnvironment();
  const info = await lstat(sourcePath);
  if (!info.isFile()) throw new Error("The Grok subscription auth mount is not a regular file");
  if (info.size < 2 || info.size > 1024 * 1024) {
    throw new Error("The Grok subscription auth file has an invalid size");
  }
  const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Grok subscription auth file is invalid");
  }

  await mkdir(grokHome, { recursive: true, mode: 0o700 });
  const destination = join(grokHome, "auth.json");
  await copyFile(sourcePath, destination);
  await chmod(grokHome, 0o700);
  await chmod(destination, 0o600);
  const identity = runtimeIdentity();
  if (identity.grokUid !== undefined) {
    await chown(grokHome, identity.grokUid, WORKSPACE_GID);
    await chown(destination, identity.grokUid, WORKSPACE_GID);
  }
}

type GrokInspection = {
  configWarnings?: unknown[];
  hooks?: unknown[];
  plugins?: unknown[];
  marketplaces?: unknown[];
  mcpServers?: unknown[];
  loginPolicy?: { apiKeyAuthDisabled?: unknown };
  permissions?: { sources?: unknown[] };
  configSources?: { layers?: Array<{ path?: unknown; role?: unknown }> };
};

export async function inspectRepositoryConfiguration(
  grokBinary: string,
  repositoryPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const identity = runtimeIdentity();
  const result = await requireSuccessfulCommand(grokBinary, ["inspect", "--json"], {
    cwd: repositoryPath,
    env: environment,
    timeoutMs: 30_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    ...(identity.grokUid === undefined ? {} : { uid: identity.grokUid, gid: WORKSPACE_GID }),
  });
  let inspection: GrokInspection;
  try {
    inspection = JSON.parse(result.stdout) as GrokInspection;
  } catch {
    throw new Error("Grok configuration inspection did not return valid JSON");
  }

  const forbiddenCollections: Array<[string, unknown[] | undefined]> = [
    ["hooks", inspection.hooks],
    ["plugins", inspection.plugins],
    ["marketplaces", inspection.marketplaces],
    ["MCP servers", inspection.mcpServers],
  ];
  for (const [label, values] of forbiddenCollections) {
    if (values && values.length > 0) {
      throw new Error(`Repository rejected because Grok discovered ${label}`);
    }
  }

  const root = `${repositoryPath.replace(/\/$/, "")}/`;
  const permissionSources = inspection.permissions?.sources ?? [];
  if (permissionSources.some((source) => typeof source === "string" && source.startsWith(root))) {
    throw new Error("Repository rejected because it defines Grok permission rules");
  }
  const projectConfigLayers = inspection.configSources?.layers ?? [];
  if (
    projectConfigLayers.some(
      (layer) => typeof layer.path === "string" && layer.path.startsWith(root),
    )
  ) {
    throw new Error("Repository rejected because it defines project-scoped Grok configuration");
  }
  if (inspection.configWarnings && inspection.configWarnings.length > 0) {
    const warningSummary = JSON.stringify(inspection.configWarnings).slice(0, 1500);
    throw new Error(`Grok root policy has configuration warnings: ${warningSummary}`);
  }
  if (inspection.loginPolicy?.apiKeyAuthDisabled !== true) {
    throw new Error("Grok root policy did not disable API-key authentication");
  }
}
