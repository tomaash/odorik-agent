import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import type { CodingArtifactStore } from "../coding/artifacts.js";
import {
  createActionRegistry,
  type ApprovedActionExecutionContext,
} from "../actions/registry.js";
import { actionEffectDigest } from "../actions/contracts.js";
import {
  createCodingIssueImplementDescriptor,
  type CodingIssueImplementAction,
} from "../coding/action.js";
import { approveAction } from "../approvals/repository.js";
import { processCodingCallback } from "../coding/callback.js";
import {
  CodingRunError,
  getCodingRun,
  listCodingIssues,
} from "../coding/repository.js";
import { queueCodingPublisher, startApprovedCodingRun } from "../coding/service.js";
import { reconcileCodingRuns } from "../coding/reconcile.js";
import { requestCodingImplementationApproval } from "../coding/proposal.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "explorers";
const connectionId = "github_150346586";
const resourceId = `repo_${"b".repeat(24)}`;
const contextItemId = `github_issue_${"c".repeat(32)}`;

function seedCodingSources(memory: MemoryFirestore): void {
  memory.seed(`companies/${companyId}/connections/${connectionId}`, {
    connectorId: "github",
    status: "active",
    installationId: 150346586,
  });
  memory.seed(`companies/${companyId}/connections/${connectionId}/resources/${resourceId}`, {
    status: "enabled",
    externalId: "987654",
    displayName: "tomaash/elixir-play",
    defaultBranch: "main",
  });
  memory.seed(`companies/${companyId}/connections/grok_subscription`, {
    connectorId: "grok_subscription",
    status: "active",
    subscription: { state: "active" },
  });
  memory.seed(`companies/${companyId}/memberships/admin-1`, {
    status: "active",
    role: "admin",
    displayName: "Administrator",
    email: "admin@example.com",
  });
  memory.seed(`companies/${companyId}/contextItems/${contextItemId}`, {
    kind: "github.issue",
    title: "[tomaash/elixir-play #17] Keep the parser total",
    text: "Repository: tomaash/elixir-play\nIssue: #17\n\nThe parser throws.",
    source: {
      connectionId,
      resourceId,
      version: "2026-08-01T00:00:00Z",
    },
    provenance: { checksum: "d".repeat(64) },
    metadata: {
      repository: "tomaash/elixir-play",
      repositoryId: 987654,
      issueNumber: 17,
      state: "open",
      sourceUrl: "https://github.com/tomaash/elixir-play/issues/17",
      labels: ["bug"],
    },
  });
}

const approvedContext: ApprovedActionExecutionContext = {
  companyId,
  actorUid: "admin-1",
  approvalId: "coding-approval-1",
  approvedBy: "admin-1",
  attemptId: "attempt-1",
  source: {
    kind: "workflow",
    issueContextItemId: contextItemId,
    workflowId: "coding.issue.manual",
    workflowVersion: 1,
    runId: "coding-workflow-1",
    blockId: "implement-with-grok",
  },
};

function codingAction(): CodingIssueImplementAction {
  const runId = `coding_${"e".repeat(32)}`;
  return {
    kind: "coding.issue.implement",
    runId,
    title: "Keep the parser total",
    issueExcerpt: "The parser throws.",
    issuePrompt: "Repository: tomaash/elixir-play\nIssue: #17\n\nThe parser throws.",
    github: {
      connectionId,
      installationId: 150346586,
      repoResourceId: resourceId,
      repositoryId: 987654,
      owner: "tomaash",
      repo: "elixir-play",
      issueNumber: 17,
      issueContextItemId: contextItemId,
      issueUrl: "https://github.com/tomaash/elixir-play/issues/17",
      issueVersion: "2026-08-01T00:00:00Z",
      issueChecksum: "d".repeat(64),
    },
    git: {
      baseBranch: "main",
      baseSha: "a".repeat(40),
      resultBranch: "erik/issue-17-eeeeeeee",
    },
    grok: { connectionId: "grok_subscription", authKind: "subscription_oauth" },
    limits: {
      maxRuntimeMinutes: 60,
      maxTurns: 30,
      maxChangedFiles: 300,
      maxPatchBytes: 10 * 1024 * 1024,
      maxArtifactBytes: 50 * 1024 * 1024,
    },
    publication: {
      draft: true,
      prTitle: "Implement #17: Keep the parser total",
      prBody: "Closes #17\n\nApproved coding run.",
    },
  };
}

class MemoryArtifacts implements CodingArtifactStore {
  readonly objects = new Map<string, string>();

  async putJson(object: string, value: unknown): Promise<void> {
    if (this.objects.has(object)) throw new Error("object already exists");
    this.objects.set(object, JSON.stringify(value));
  }

  async signedReadUrl(object: string): Promise<string> {
    return `https://storage.invalid/${encodeURIComponent(object)}?signature=hidden`;
  }

  async signedWriteUrl(object: string): Promise<string> {
    return `https://storage.invalid/${encodeURIComponent(object)}?signature=hidden`;
  }

  async readText(object: string): Promise<{ text: string; truncated: boolean }> {
    return { text: this.objects.get(object) || "", truncated: false };
  }

  async exists(object: string): Promise<boolean> {
    return this.objects.has(object);
  }
}

test("one issue creates one active run and duplicate starts reuse it", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const dispatches: string[] = [];
  const start = () => startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: artifacts,
    executeDispatcher: async ({ runId }) => {
      dispatches.push(runId);
      return { operationName: `operations/${runId}` };
    },
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T10:00:00Z")),
  });

  const first = await start();
  const second = await start();
  assert.equal(first.id, second.id);
  assert.equal(first.status, "packaging");
  assert.deepEqual(dispatches, [first.id as string]);
  assert.equal(memory.list(`companies/${companyId}/codingRuns`).length, 1);
  assert.doesNotMatch(JSON.stringify(memory.entries()), /signature=hidden/);

  const issues = await listCodingIssues({ companyId, database: memory.asFirestore() });
  assert.equal(issues[0]?.activeRunId, first.id);
});

test("requesting implementation creates approval first and approval queues Grok", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const fetcher = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({
        token: "read-token",
        expires_at: "2026-08-01T12:00:00Z",
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/repos/tomaash/elixir-play") {
      return new Response(JSON.stringify({
        id: 987654,
        name: "elixir-play",
        full_name: "tomaash/elixir-play",
        private: false,
        default_branch: "main",
        html_url: "https://github.com/tomaash/elixir-play",
        owner: { login: "tomaash" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/repos/tomaash/elixir-play/commits/main") {
      return new Response(JSON.stringify({ sha: "a".repeat(40) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const requested = await requestCodingImplementationApproval({
    companyId,
    actorUid: "admin-1",
    preferredApproverUid: "admin-1",
    issueContextItemId: contextItemId,
    configuration: {
      appId: 4447426,
      clientId: "Iv23liy3QUr30tDzuO2F",
      appSlug: "agent-erik-development",
      privateKey,
    },
    fetcher,
    database: memory.asFirestore(),
  });
  assert.equal(requested.status, "pending");
  assert.equal(memory.list(`companies/${companyId}/codingRuns`).length, 0);

  const registry = createActionRegistry([
    createCodingIssueImplementDescriptor(async (context, action) => {
      const run = await startApprovedCodingRun({
        context,
        action,
        artifactStore: artifacts,
        executeDispatcher: async () => ({ operationName: "operations/approved-dispatch" }),
        database: memory.asFirestore(),
      });
      return { codingRunId: String(run.id), status: "packaging" };
    }),
  ]);
  await approveAction({
    companyId,
    actorUid: "admin-1",
    approvalId: String(requested.id),
  }, {
    database: memory.asFirestore(),
    registry,
    resolveActiveMember: async (_company, uid) => ({
      uid,
      displayName: "Administrator",
      email: "admin@example.com",
    }),
  });
  const runs = memory.list(`companies/${companyId}/codingRuns`);
  assert.equal(runs.length, 1);
  const runData = runs[0] as Record<string, unknown>;
  assert.equal(runData.status, "packaging");
  assert.equal((runData.authorization as Record<string, unknown>).approvalId, requested.id);
});

test("callbacks are tenant-routed, idempotent, bounded, and produce review state", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: artifacts,
    executeDispatcher: async () => ({ operationName: "operations/dispatch" }),
    database: memory.asFirestore(),
  });
  const runId = String(run.id);
  const event = {
    eventId: "runner-9-completed",
    runId,
    type: "completed",
    phase: "succeeded",
    status: "ready_to_publish",
    message: "Result is ready for review",
    executionName: "erik-coding-runner-abc12",
    result: {
      baseSha: "a".repeat(40),
      resultSha: "b".repeat(40),
      changedFiles: 1,
      changedPaths: ["src/parser.ex"],
      patchBytes: 900,
      artifactBytes: 2_000,
      durationMs: 7_000,
      authKind: "subscription_oauth",
      resultBundleSha256: "f".repeat(64),
      resultBundleBytes: 1_200,
    },
  };
  await processCodingCallback({
    body: event,
    principalEmail: "erik-coding-runner@odorik-tx-260720-c58d.iam.gserviceaccount.com",
    database: memory.asFirestore(),
  });
  await processCodingCallback({
    body: event,
    principalEmail: "erik-coding-runner@odorik-tx-260720-c58d.iam.gserviceaccount.com",
    database: memory.asFirestore(),
  });

  const completed = await getCodingRun({ companyId, runId, database: memory.asFirestore() });
  assert.equal(completed.status, "ready_to_publish");
  assert.deepEqual((completed.result as { changedPaths: string[] }).changedPaths, ["src/parser.ex"]);
  assert.equal((completed.events as unknown[]).length, 3);
  await assert.rejects(
    getCodingRun({ companyId: "another-company", runId, database: memory.asFirestore() }),
    (error: unknown) => error instanceof CodingRunError && error.statusCode === 404,
  );
});

test("an approved result queues one publisher and records the draft PR", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const action = codingAction();
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action,
    artifactStore: artifacts,
    executeDispatcher: async () => ({ operationName: "operations/dispatch" }),
    database: memory.asFirestore(),
  });
  const runId = String(run.id);
  const effectDigest = actionEffectDigest(action);
  memory.seed(`companies/${companyId}/actionApprovals/${approvedContext.approvalId}`, {
    objectType: "action_approval",
    decisionStatus: "approved",
    executionStatus: "succeeded",
    approvedBy: approvedContext.approvedBy,
    effectDigest,
    action,
    result: { kind: "coding_run", id: runId },
  });
  const runArtifacts = (
    memory.read(`companies/${companyId}/codingRuns/${runId}`)?.artifacts || {}
  ) as Record<string, unknown>;
  artifacts.objects.set(String(runArtifacts.sourceObject), "source");
  artifacts.objects.set(String(runArtifacts.resultBundleObject), "result");
  await processCodingCallback({
    body: {
      eventId: "runner-completed-for-publish",
      runId,
      type: "completed",
      phase: "succeeded",
      status: "ready_to_publish",
      message: "Result is ready for approved draft PR publication",
      result: {
        baseSha: "a".repeat(40),
        resultSha: "b".repeat(40),
        changedFiles: 1,
        changedPaths: ["src/parser.ex"],
        patchBytes: 900,
        artifactBytes: 2_000,
        durationMs: 7_000,
        authKind: "subscription_oauth",
        resultBundleSha256: "f".repeat(64),
        resultBundleBytes: 1_200,
      },
    },
    principalEmail: "erik-coding-runner@odorik-tx-260720-c58d.iam.gserviceaccount.com",
    database: memory.asFirestore(),
  });
  const publications: string[] = [];
  await queueCodingPublisher({
    companyId,
    runId,
    artifactStore: artifacts,
    executePublisher: async ({ publishSpecUrl }) => {
      publications.push(publishSpecUrl);
      return { operationName: "operations/publisher", executionName: "publisher-execution" };
    },
    database: memory.asFirestore(),
  });
  assert.equal(publications.length, 1);
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${runId}`)?.status, "publishing");
  assert.doesNotMatch(JSON.stringify(memory.entries()), /signature=hidden/);

  await processCodingCallback({
    body: {
      eventId: "publisher-completed",
      runId,
      type: "completed",
      phase: "succeeded",
      status: "succeeded",
      message: "Draft pull request opened",
      result: {
        baseSha: "a".repeat(40),
        resultSha: "b".repeat(40),
        branch: action.git.resultBranch,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/tomaash/elixir-play/pull/42",
        draft: true,
        approvalId: approvedContext.approvalId,
        effectDigest,
      },
    },
    principalEmail: "erik-coding-dispatcher@odorik-tx-260720-c58d.iam.gserviceaccount.com",
    database: memory.asFirestore(),
  });
  const completed = await getCodingRun({ companyId, runId, database: memory.asFirestore() });
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(completed.publicationResult, {
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/tomaash/elixir-play/pull/42",
    branch: action.git.resultBranch,
    draft: true,
  });
});

test("coding starts fail closed for an unselected repository or disconnected Grok", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  memory.seed(`companies/${companyId}/connections/${connectionId}/resources/${resourceId}`, {
    status: "disabled",
    externalId: "987654",
    displayName: "tomaash/elixir-play",
    defaultBranch: "main",
  });
  await assert.rejects(
    startApprovedCodingRun({
      context: approvedContext,
      action: codingAction(),
      artifactStore: new MemoryArtifacts(),
      executeDispatcher: async () => ({ operationName: "must-not-run" }),
      database: memory.asFirestore(),
    }),
    /repository is not selected/,
  );
});

test("reconciliation closes terminal executions that missed their callback", async () => {
  const memory = new MemoryFirestore();
  memory.seed(`companies/${companyId}`, { displayName: "Explorers" });
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: artifacts,
    executeDispatcher: async () => ({
      operationName: "operations/dispatch",
      executionName: "erik-coding-dispatcher-abc12",
    }),
    database: memory.asFirestore(),
  });
  const result = await reconcileCodingRuns({
    artifactStore: artifacts,
    inspectExecution: async () => ({ terminal: true, outcome: "failed" }),
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T11:30:00Z")),
  });
  assert.deepEqual(result, { inspected: 1, repaired: 1, failures: 0 });
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.status, "failed");
  assert.equal(
    (memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.error as Record<string, unknown>).code,
    "completion_callback_missing",
  );
});
