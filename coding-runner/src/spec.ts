const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const GIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type CodingRunSpec = {
  schemaVersion: 1;
  runId: string;
  source: {
    downloadUrl: string;
    sha256: string;
    baseSha: string;
  };
  task: {
    title: string;
    prompt: string;
    sourceUrl?: string;
  };
  agent: {
    maxTurns: number;
    model?: string;
  };
  artifacts: {
    uploadUrl: string;
  };
  limits: {
    maxSourceBytes: number;
    maxArtifactBytes: number;
    maxChangedFiles: number;
    maxPatchBytes: number;
  };
};

type JsonObject = Record<string, unknown>;

const DEFAULT_LIMITS = {
  maxSourceBytes: 2 * 1024 * 1024 * 1024,
  maxArtifactBytes: 50 * 1024 * 1024,
  maxChangedFiles: 300,
  maxPatchBytes: 10 * 1024 * 1024,
} as const;

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function string(
  value: unknown,
  field: string,
  options: { min?: number; max: number; pattern?: RegExp },
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const min = options.min ?? 1;
  if (value.length < min || value.length > options.max) {
    throw new Error(`${field} must contain ${min}-${options.max} characters`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return string(value, field, { max });
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function validateHttpsUrl(value: unknown, field: string): string {
  const raw = string(value, field, { max: 8192 });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  const localFileAllowed = process.env.ALLOW_LOCAL_FILES === "true" && parsed.protocol === "file:";
  if (parsed.protocol !== "https:" && !localFileAllowed) {
    throw new Error(`${field} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not contain basic-auth credentials`);
  }
  return parsed.toString();
}

export function parseRunSpec(value: unknown): CodingRunSpec {
  const root = object(value, "run spec");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = object(root.source, "source");
  const task = object(root.task, "task");
  const agent = root.agent === undefined ? {} : object(root.agent, "agent");
  const artifacts = object(root.artifacts, "artifacts");
  const limits = root.limits === undefined ? {} : object(root.limits, "limits");
  const model = optionalString(agent.model, "agent.model", 128);
  if (model && !MODEL_PATTERN.test(model)) throw new Error("agent.model has an invalid format");
  const sourceUrl = optionalString(task.sourceUrl, "task.sourceUrl", 2048);

  const parsed: CodingRunSpec = {
    schemaVersion: 1,
    runId: string(root.runId, "runId", { max: 128, pattern: RUN_ID_PATTERN }),
    source: {
      downloadUrl: validateHttpsUrl(source.downloadUrl, "source.downloadUrl"),
      sha256: string(source.sha256, "source.sha256", { max: 64, pattern: SHA256_PATTERN }).toLowerCase(),
      baseSha: string(source.baseSha, "source.baseSha", { max: 64, pattern: GIT_SHA_PATTERN }).toLowerCase(),
    },
    task: {
      title: string(task.title, "task.title", { max: 500 }),
      prompt: string(task.prompt, "task.prompt", { max: 100_000 }),
      ...(sourceUrl ? { sourceUrl } : {}),
    },
    agent: {
      maxTurns: integer(agent.maxTurns, "agent.maxTurns", 30, 1, 100),
      ...(model ? { model } : {}),
    },
    artifacts: {
      uploadUrl: validateHttpsUrl(artifacts.uploadUrl, "artifacts.uploadUrl"),
    },
    limits: {
      maxSourceBytes: integer(
        limits.maxSourceBytes,
        "limits.maxSourceBytes",
        DEFAULT_LIMITS.maxSourceBytes,
        1024,
        8 * 1024 * 1024 * 1024,
      ),
      maxArtifactBytes: integer(
        limits.maxArtifactBytes,
        "limits.maxArtifactBytes",
        DEFAULT_LIMITS.maxArtifactBytes,
        1024,
        500 * 1024 * 1024,
      ),
      maxChangedFiles: integer(
        limits.maxChangedFiles,
        "limits.maxChangedFiles",
        DEFAULT_LIMITS.maxChangedFiles,
        1,
        5000,
      ),
      maxPatchBytes: integer(
        limits.maxPatchBytes,
        "limits.maxPatchBytes",
        DEFAULT_LIMITS.maxPatchBytes,
        1024,
        100 * 1024 * 1024,
      ),
    },
  };
  return parsed;
}

export function assertRunIdMatchesEnvironment(spec: CodingRunSpec, expected?: string): void {
  if (expected && spec.runId !== expected) {
    throw new Error("The run spec runId does not match RUN_ID");
  }
}
