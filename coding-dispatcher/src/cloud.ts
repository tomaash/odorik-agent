import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GoogleAuth, Impersonated } from "google-auth-library";
import { Storage } from "@google-cloud/storage";

const projectId = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || "odorik-tx-260720-c58d";
const region = process.env.CODING_REGION || "europe-west1";
const bucketName = process.env.CODING_ARTIFACT_BUCKET || `${projectId}-coding-artifacts-euw1`;
const signerEmail = process.env.CODING_SIGNER_SERVICE_ACCOUNT
  || `erik-coding-signer@${projectId}.iam.gserviceaccount.com`;
const runnerJob = process.env.CODING_RUNNER_JOB || "erik-coding-runner";

const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
let storagePromise: Promise<Storage> | undefined;

async function storage(): Promise<Storage> {
  storagePromise ||= (async () => {
    const source = await googleAuth.getClient();
    const authClient = new Impersonated({
      sourceClient: source,
      targetPrincipal: signerEmail,
      targetScopes: ["https://www.googleapis.com/auth/devstorage.full_control"],
      lifetime: 3600,
    });
    return new Storage({ projectId, authClient });
  })();
  return storagePromise;
}

function file(object: string) {
  return storage().then((client) => client.bucket(bucketName).file(object));
}

export async function downloadFile(
  object: string,
  destination: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  const source = await file(object);
  const [metadata] = await source.getMetadata();
  const declaredSize = Number(metadata.size || 0);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) {
    throw new Error(`Artifact ${object} exceeds its size limit`);
  }
  await source.download({ destination });
  const info = await stat(destination);
  if (!info.isFile() || info.size !== declaredSize || info.size > maxBytes) {
    throw new Error(`Artifact ${object} changed while downloading`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), bytes: info.size };
}

export async function uploadFile(
  object: string,
  path: string,
  contentType: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = chunk as Buffer;
    hash.update(value);
    bytes += value.length;
  }
  await (await file(object)).save(createReadStream(path), {
    resumable: true,
    contentType,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { cacheControl: "private, no-store" },
  });
  return { sha256: hash.digest("hex"), bytes };
}

export async function uploadJson(object: string, value: unknown): Promise<void> {
  await (await file(object)).save(`${JSON.stringify(value)}\n`, {
    resumable: false,
    contentType: "application/json",
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { cacheControl: "private, no-store" },
  });
}

export async function signedUrl(
  object: string,
  action: "read" | "write",
  contentType?: string,
): Promise<string> {
  const [url] = await (await file(object)).getSignedUrl({
    version: "v4",
    action,
    expires: Date.now() + 2 * 60 * 60 * 1000,
    ...(contentType ? { contentType } : {}),
  });
  return url;
}

export async function executeRunner(input: {
  runId: string;
  runSpecUrl: string;
  callbackUrl: string;
}): Promise<{ operationName: string; executionName?: string }> {
  const client = await googleAuth.getClient();
  const response = await client.request<{
    name?: string;
    metadata?: { target?: string };
  }>({
    url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${runnerJob}:run`,
    method: "POST",
    data: {
      overrides: {
        containerOverrides: [{
          name: "coding-runner",
          env: [
            { name: "RUN_ID", value: input.runId },
            { name: "RUN_SPEC_URL", value: input.runSpecUrl },
            { name: "CODING_CALLBACK_URL", value: input.callbackUrl },
          ],
        }],
        taskCount: 1,
        timeout: "3600s",
      },
    },
  });
  if (!response.data.name) throw new Error("Cloud Run did not return a runner operation");
  return {
    operationName: response.data.name,
    ...(response.data.metadata?.target ? { executionName: response.data.metadata.target } : {}),
  };
}
