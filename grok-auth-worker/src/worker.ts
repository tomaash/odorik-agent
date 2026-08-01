import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  addGrokSecretVersion,
  disableOtherGrokSecretVersions,
  extractDeviceAuthorization,
  metadataAccessToken,
  postAuthCallback,
  validateGrokAuthDocument,
} from "./protocol.js";

type WorkerEnvironment = Record<string, string | undefined>;

function required(environment: WorkerEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "[device-code]")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[path]")
    .slice(0, 500);
}

function safeCliDiagnostic(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "[device-code]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[account]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[opaque]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function connect(environment: WorkerEnvironment): Promise<void> {
  const projectId = required(environment, "GCP_PROJECT_ID");
  const secretName = required(environment, "GROK_AUTH_SECRET_NAME");
  const sessionId = required(environment, "GROK_AUTH_SESSION_ID");
  const callbackUrl = required(environment, "GROK_AUTH_CALLBACK_URL");
  const grokHome = required(environment, "GROK_HOME");
  await rm(grokHome, { recursive: true, force: true });
  await mkdir(grokHome, { recursive: true, mode: 0o700 });

  const childEnvironment: WorkerEnvironment = { ...environment, GROK_HOME: grokHome };
  delete childEnvironment.XAI_API_KEY;
  const child = spawn("grok", ["login", "--device-auth"], {
    env: childEnvironment as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boundedOutput = "";
  let devicePublished = false;
  let publishFailure: Error | null = null;
  let devicePublishPromise: Promise<void> | null = null;
  const consume = (chunk: Buffer) => {
    boundedOutput = `${boundedOutput}${chunk.toString("utf8")}`.slice(-32_000);
    if (devicePublished) return;
    const device = extractDeviceAuthorization(boundedOutput);
    if (!device) return;
    devicePublished = true;
    devicePublishPromise = postAuthCallback({
      callbackUrl,
      event: { type: "device", sessionId, ...device },
    }).catch((error) => {
      publishFailure = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
    });
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  if (devicePublishPromise) await devicePublishPromise;
  if (publishFailure) throw publishFailure;
  if (!devicePublished) {
    const diagnostic = safeCliDiagnostic(boundedOutput);
    throw new Error(`Grok did not provide a device authorization code${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  if (exit.code !== 0) throw new Error(`Grok device authorization failed (${exit.code ?? exit.signal})`);

  const authPath = join(grokHome, "auth.json");
  const authPayload = await readFile(authPath);
  const account = validateGrokAuthDocument(authPayload);
  const accessToken = await metadataAccessToken();
  let secretVersion: string;
  try {
    secretVersion = await addGrokSecretVersion({
      projectId,
      secretName,
      payload: authPayload,
      accessToken,
    });
  } finally {
    authPayload.fill(0);
  }
  await disableOtherGrokSecretVersions({
    projectId,
    secretName,
    keepVersion: secretVersion,
    accessToken,
  });
  await postAuthCallback({
    callbackUrl,
    event: {
      type: "completed",
      action: "connect",
      sessionId,
      secretVersion,
      ...account,
    },
  });
}

async function disconnect(environment: WorkerEnvironment): Promise<void> {
  const projectId = required(environment, "GCP_PROJECT_ID");
  const secretName = required(environment, "GROK_AUTH_SECRET_NAME");
  const sessionId = required(environment, "GROK_AUTH_SESSION_ID");
  const callbackUrl = required(environment, "GROK_AUTH_CALLBACK_URL");
  const accessToken = await metadataAccessToken();
  const disabledVersions = await disableOtherGrokSecretVersions({
    projectId,
    secretName,
    accessToken,
  });
  await postAuthCallback({
    callbackUrl,
    event: {
      type: "completed",
      action: "disconnect",
      sessionId,
      disabledVersions,
    },
  });
}

export async function runAuthWorker(
  environment: WorkerEnvironment = process.env,
): Promise<void> {
  if (environment.XAI_API_KEY) throw new Error("XAI_API_KEY is forbidden");
  const action = required(environment, "GROK_AUTH_ACTION");
  const sessionId = required(environment, "GROK_AUTH_SESSION_ID");
  const callbackUrl = required(environment, "GROK_AUTH_CALLBACK_URL");
  try {
    if (action === "connect") await connect(environment);
    else if (action === "disconnect") await disconnect(environment);
    else throw new Error("Unsupported Grok auth action");
    console.log(`Grok subscription ${action} completed for ${sessionId}`);
  } catch (error) {
    await postAuthCallback({
      callbackUrl,
      event: {
        type: "failed",
        action,
        sessionId,
        error: safeError(error),
      },
    }).catch(() => undefined);
    throw error;
  }
}
