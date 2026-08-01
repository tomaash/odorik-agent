import { Timestamp } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";
import { db } from "../firestore.js";
import type { CodingArtifactStore } from "./artifacts.js";
import { safeCodingError, updateCodingRunState } from "./repository.js";
import type { CodingRunStatus } from "./types.js";

export type CodingExecutionState = {
  terminal: boolean;
  outcome: "succeeded" | "failed" | "cancelled" | "running";
};

export type CodingExecutionInspector = (executionName: string) => Promise<CodingExecutionState>;

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d";
const codingRegion = process.env.CODING_REGION || "europe-west1";
const authentication = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

function canonicalExecutionName(value: string): string {
  if (/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+\/executions\/[^/]+$/.test(value)) {
    return value;
  }
  if (/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    return `projects/${projectId}/locations/${codingRegion}/jobs/erik-coding-runner/executions/${value}`;
  }
  throw new Error("Invalid Cloud Run execution name");
}

export function createCloudRunExecutionInspector(): CodingExecutionInspector {
  return async (executionName) => {
    const client = await authentication.getClient();
    const response = await client.request<{
      completionTime?: string;
      cancelledCount?: number;
      failedCount?: number;
      succeededCount?: number;
      terminalCondition?: { state?: string; reason?: string };
    }>({
      url: `https://run.googleapis.com/v2/${canonicalExecutionName(executionName)}`,
      method: "GET",
    });
    const value = response.data;
    const terminal = Boolean(value.completionTime)
      || value.terminalCondition?.state === "CONDITION_SUCCEEDED"
      || value.terminalCondition?.state === "CONDITION_FAILED";
    return {
      terminal,
      outcome: !terminal
        ? "running"
        : Number(value.cancelledCount || 0) > 0
          ? "cancelled"
          : Number(value.succeededCount || 0) > 0 && Number(value.failedCount || 0) === 0
            ? "succeeded"
            : "failed",
    };
  };
}

function millis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

export async function reconcileCodingRuns(input: {
  artifactStore: CodingArtifactStore;
  inspectExecution: CodingExecutionInspector;
  queuePublisher?: (companyId: string, runId: string) => Promise<unknown>;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<{ inspected: number; repaired: number; failures: number }> {
  const database = input.database || db;
  const now = input.now || Timestamp.now();
  const companies = await database.collection("companies").get();
  let inspected = 0;
  let repaired = 0;
  let failures = 0;
  for (const company of companies.docs) {
    const runs = await company.ref.collection("codingRuns").get();
    for (const run of runs.docs) {
      const data = run.data();
      const status = data.status as CodingRunStatus;
      if (![
        "queued", "packaging", "provisioning", "running", "cancel_requested",
        "ready_to_publish", "publishing",
      ].includes(status)) continue;
      inspected += 1;
      try {
        const artifactObject = String(data.artifacts?.artifactObject || "");
        if (status === "ready_to_publish") {
          const resultBundleObject = String(data.artifacts?.resultBundleObject || "");
          if (
            !artifactObject
            || !resultBundleObject
            || !await input.artifactStore.exists(artifactObject)
            || !await input.artifactStore.exists(resultBundleObject)
          ) {
            await updateCodingRunState({
              companyId: company.id,
              runId: run.id,
              status: "failed",
              phase: "artifact_missing",
              message: "The immutable result artifact is missing",
              eventId: `reconcile-artifact-${now.toMillis()}`,
              values: {
                error: {
                  code: "artifact_missing",
                  message: "The immutable result artifact is missing",
                  phase: "reconciliation",
                },
              },
              database,
              now,
            });
            repaired += 1;
          } else if (input.queuePublisher) {
            await input.queuePublisher(company.id, run.id);
            repaired += 1;
          }
          continue;
        }
        const executionName = String(
          status === "publishing"
            ? data.cloudRun?.publisherExecutionName || ""
            : data.cloudRun?.runnerExecutionName || data.cloudRun?.dispatcherExecutionName || "",
        );
        if (executionName) {
          const execution = await input.inspectExecution(executionName);
          if (execution.terminal) {
            const cancelled = status === "cancel_requested" || execution.outcome === "cancelled";
            await updateCodingRunState({
              companyId: company.id,
              runId: run.id,
              status: cancelled
                ? "cancelled"
                : status === "publishing"
                  ? "outcome_unknown"
                  : "failed",
              phase: cancelled
                ? "cancelled"
                : status === "publishing"
                  ? "publication_callback_missing"
                  : "callback_missing",
              message: cancelled
                ? "Cloud Run execution cancellation confirmed"
                : status === "publishing"
                  ? "Publisher ended without a completion callback; reconcile GitHub before retrying"
                  : "Cloud Run execution ended without a completion callback",
              eventId: `reconcile-terminal-${now.toMillis()}`,
              values: cancelled ? {} : {
                error: {
                  code: "completion_callback_missing",
                  message: "Cloud Run execution ended without a completion callback",
                  phase: "reconciliation",
                },
              },
              database,
              now,
            });
            repaired += 1;
            continue;
          }
        }
        const updatedAt = millis(data.updatedAt) || millis(data.createdAt) || now.toMillis();
        if (now.toMillis() - updatedAt > 70 * 60 * 1000) {
          await updateCodingRunState({
            companyId: company.id,
            runId: run.id,
            status: status === "cancel_requested"
              ? "cancelled"
              : status === "publishing"
                ? "outcome_unknown"
                : "failed",
            phase: status === "cancel_requested"
              ? "cancelled"
              : status === "publishing"
                ? "publication_timed_out"
                : "timed_out",
            message: status === "cancel_requested"
              ? "Cancellation confirmed after the run timeout"
              : "Coding run exceeded its reconciliation timeout",
            eventId: `reconcile-timeout-${now.toMillis()}`,
            values: status === "cancel_requested" ? {} : {
              error: {
                code: "coding_run_timed_out",
                message: "Coding run exceeded its reconciliation timeout",
                phase: "reconciliation",
              },
            },
            database,
            now,
          });
          repaired += 1;
        }
      } catch (error) {
        failures += 1;
        console.error("Coding run reconciliation failed", {
          companyId: company.id,
          runId: run.id,
          error: safeCodingError(error),
        });
      }
    }
  }
  return { inspected, repaired, failures };
}
