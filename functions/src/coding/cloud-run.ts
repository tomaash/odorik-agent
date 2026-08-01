import { GoogleAuth } from "google-auth-library";
import type { CodingDispatcherExecutor, CodingPublisherExecutor } from "./types.js";

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d";
const codingRegion = process.env.CODING_REGION?.trim() || "europe-west1";
const dispatcherJob = process.env.CODING_DISPATCHER_JOB?.trim() || "erik-coding-dispatcher";
const callbackUrl = process.env.CODING_CALLBACK_URL?.trim()
  || "https://agent-erik-app.web.app/callbacks/coding";

const authentication = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export function createCloudRunCodingDispatcherExecutor(): CodingDispatcherExecutor {
  return async (input) => {
    const client = await authentication.getClient();
    const response = await client.request<{
      name?: string;
      metadata?: { target?: string };
    }>({
      url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${codingRegion}/jobs/${dispatcherJob}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [{
            name: "coding-dispatcher",
            env: [
              { name: "CODING_RUN_ID", value: input.runId },
              { name: "DISPATCH_SPEC_URL", value: input.dispatchSpecUrl },
              { name: "CODING_CALLBACK_URL", value: callbackUrl },
            ],
          }],
          taskCount: 1,
          timeout: "1200s",
        },
      },
    });
    if (!response.data.name) throw new Error("Cloud Run did not return a dispatcher operation");
    return {
      operationName: response.data.name,
      ...(response.data.metadata?.target
        ? { executionName: response.data.metadata.target }
        : {}),
    };
  };
}

export function createCloudRunCodingPublisherExecutor(): CodingPublisherExecutor {
  return async (input) => {
    const client = await authentication.getClient();
    const response = await client.request<{
      name?: string;
      metadata?: { target?: string };
    }>({
      url: `https://run.googleapis.com/v2/projects/${projectId}/locations/${codingRegion}/jobs/${dispatcherJob}:run`,
      method: "POST",
      data: {
        overrides: {
          containerOverrides: [{
            name: "coding-dispatcher",
            env: [
              { name: "CODING_MODE", value: "publish" },
              { name: "CODING_RUN_ID", value: input.runId },
              { name: "PUBLISH_SPEC_URL", value: input.publishSpecUrl },
              { name: "CODING_CALLBACK_URL", value: callbackUrl },
            ],
          }],
          taskCount: 1,
          timeout: "1200s",
        },
      },
    });
    if (!response.data.name) throw new Error("Cloud Run did not return a publisher operation");
    return {
      operationName: response.data.name,
      ...(response.data.metadata?.target
        ? { executionName: response.data.metadata.target }
        : {}),
    };
  };
}

function canonicalExecutionName(value: string): string {
  if (/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+\/executions\/[^/]+$/.test(value)) {
    return value;
  }
  if (/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    return `projects/${projectId}/locations/${codingRegion}/jobs/erik-coding-runner/executions/${value}`;
  }
  throw new Error("Invalid Cloud Run execution name");
}

export async function cancelCodingExecution(executionName: string): Promise<void> {
  const client = await authentication.getClient();
  await client.request({
    url: `https://run.googleapis.com/v2/${canonicalExecutionName(executionName)}:cancel`,
    method: "POST",
    data: {},
  });
}
