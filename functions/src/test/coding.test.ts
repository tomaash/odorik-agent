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
import { processCodingAuthRefreshCallback } from "../coding/auth-refresh.js";
import {
  CodingRunError,
  getCodingRun,
  listCodingIssues,
} from "../coding/repository.js";
import {
  cancelCodingRun,
  queueCodingDispatcher,
  queueCodingPublisher,
  reconcileCodingPublication,
  startApprovedCodingRun,
} from "../coding/service.js";
import { reconcileCodingRuns } from "../coding/reconcile.js";
import {
  requestCodingImplementationApproval,
  requestCodingPullRequestChangesApproval,
  requestCodingRetryApproval,
} from "../coding/proposal.js";
import { inspectGitHubPublication } from "../coding/github-recovery.js";
import { canonicalCodingExecutionName } from "../coding/cloud-run.js";
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
      sourceBranch: "main",
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

test("production coding waits for persisted OAuth rotation before dispatching Grok", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  const refreshes: string[] = [];
  const dispatches: string[] = [];
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: artifacts,
    executeAuthRefresh: async ({ runId }) => {
      refreshes.push(runId);
      return {
        operationName: `operations/auth/${runId}`,
        executionName: "erik-grok-auth-abc12",
      };
    },
    executeDispatcher: async ({ runId }) => {
      dispatches.push(runId);
      return { operationName: `operations/dispatch/${runId}` };
    },
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T10:00:00Z")),
  });
  assert.equal(run.status, "queued");
  assert.equal(run.phase, "auth_refresh_queued");
  assert.deepEqual(refreshes, [run.id as string]);
  assert.equal(dispatches.length, 0);

  const callback = await processCodingAuthRefreshCallback({
    body: {
      type: "completed",
      action: "refresh",
      runId: run.id,
      secretVersion: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/9",
      expiresAt: "2026-08-01T16:00:00.000Z",
      refreshed: true,
    },
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T10:00:02Z")),
  });
  assert.equal(callback.shouldDispatch, true);
  await queueCodingDispatcher({
    companyId,
    runId: run.id as string,
    artifactStore: artifacts,
    executeDispatcher: async ({ runId }) => {
      dispatches.push(runId);
      return { operationName: `operations/dispatch/${runId}` };
    },
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T10:00:03Z")),
  });
  assert.deepEqual(dispatches, [run.id as string]);
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.status, "packaging");
  assert.equal(
    (memory.read(`companies/${companyId}/connections/grok_subscription`)?.credentialRef as Record<string, unknown>).version,
    "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/9",
  );
});

test("a failed OAuth preflight stops before Grok and marks the connection for attention", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: new MemoryArtifacts(),
    executeAuthRefresh: async () => ({
      operationName: "operations/auth",
      executionName: "erik-grok-auth-def34",
    }),
    executeDispatcher: async () => ({ operationName: "must-not-dispatch" }),
    database: memory.asFirestore(),
  });
  const callback = await processCodingAuthRefreshCallback({
    body: {
      type: "failed",
      action: "refresh",
      runId: run.id,
      error: "Grok OAuth refresh failed (400)",
    },
    database: memory.asFirestore(),
  });
  assert.equal(callback.shouldDispatch, false);
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.status, "failed");
  assert.equal(memory.read(`companies/${companyId}/connections/grok_subscription`)?.status, "attention");
});

test("OAuth completion cannot reactivate a disconnected Grok connection", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: new MemoryArtifacts(),
    executeAuthRefresh: async () => ({ operationName: "operations/auth" }),
    executeDispatcher: async () => ({ operationName: "must-not-dispatch" }),
    database: memory.asFirestore(),
  });
  const connectionPath = `companies/${companyId}/connections/grok_subscription`;
  memory.seed(connectionPath, {
    ...memory.read(connectionPath),
    status: "disconnected",
    subscription: { state: "disconnected" },
  });
  const callback = await processCodingAuthRefreshCallback({
    body: {
      type: "completed",
      action: "refresh",
      runId: run.id,
      secretVersion: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/9",
      expiresAt: "2026-08-01T16:00:00.000Z",
      refreshed: true,
    },
    database: memory.asFirestore(),
  });
  assert.equal(callback.shouldDispatch, false);
  assert.equal(memory.read(connectionPath)?.status, "disconnected");
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.status, "failed");
  assert.equal(
    (memory.read(`companies/${companyId}/codingRuns/${run.id}`)?.error as Record<string, unknown>).code,
    "grok_connection_inactive",
  );
});

test("replayed OAuth completion retries only a safe dispatcher-start failure", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const run = await startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore: new MemoryArtifacts(),
    executeAuthRefresh: async () => ({ operationName: "operations/auth" }),
    executeDispatcher: async () => ({ operationName: "unused" }),
    database: memory.asFirestore(),
  });
  const body = {
    type: "completed",
    action: "refresh",
    runId: run.id,
    secretVersion: "projects/odorik-tx-260720-c58d/secrets/grok-subscription-auth/versions/9",
    expiresAt: "2026-08-01T16:00:00.000Z",
    refreshed: false,
  };
  const first = await processCodingAuthRefreshCallback({
    body,
    database: memory.asFirestore(),
  });
  assert.equal(first.shouldDispatch, true);
  const runPath = `companies/${companyId}/codingRuns/${run.id}`;
  memory.seed(runPath, {
    ...memory.read(runPath),
    status: "failed",
    phase: "dispatch_failed",
  });
  const replay = await processCodingAuthRefreshCallback({
    body,
    database: memory.asFirestore(),
  });
  assert.equal(replay.shouldDispatch, true);
});

test("a safe dispatcher-start failure can retry the same approved run", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const artifacts = new MemoryArtifacts();
  let failArtifactCheck = true;
  const artifactStore: CodingArtifactStore = {
    ...artifacts,
    putJson: artifacts.putJson.bind(artifacts),
    signedReadUrl: artifacts.signedReadUrl.bind(artifacts),
    signedWriteUrl: artifacts.signedWriteUrl.bind(artifacts),
    readText: artifacts.readText.bind(artifacts),
    exists: async (object) => {
      if (failArtifactCheck) {
        failArtifactCheck = false;
        throw new Error("artifact authentication unavailable");
      }
      return artifacts.exists(object);
    },
  };
  const dispatches: string[] = [];
  const start = () => startApprovedCodingRun({
    context: approvedContext,
    action: codingAction(),
    artifactStore,
    executeDispatcher: async ({ runId }) => {
      dispatches.push(runId);
      return { operationName: `operations/${runId}` };
    },
    database: memory.asFirestore(),
  });

  await assert.rejects(start(), /artifact authentication unavailable/);
  assert.equal(
    memory.read(`companies/${companyId}/codingRuns/${codingAction().runId}`)?.phase,
    "dispatch_failed",
  );

  const retried = await start();
  assert.equal(retried.status, "packaging");
  assert.deepEqual(dispatches, [codingAction().runId]);
  assert.equal(
    memory.read(`companies/${companyId}/codingRuns/${codingAction().runId}`)?.error,
    null,
  );
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

test("publication reconciliation adopts an orphan PR and rejects a conflicting result", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const action = codingAction();
  const runId = action.runId;
  const runPath = `companies/${companyId}/codingRuns/${runId}`;
  memory.seed(runPath, {
    status: "outcome_unknown",
    phase: "outcome_unknown",
    authorization: { approvalId: approvedContext.approvalId },
    github: {
      owner: "tomaash",
      repo: "elixir-play",
      repositoryId: 987654,
      issueContextItemId: contextItemId,
    },
    git: {
      baseBranch: "main",
      sourceBranch: "main",
      baseSha: "a".repeat(40),
      resultSha: "b".repeat(40),
      proposedBranch: action.git.resultBranch,
    },
  });
  memory.seed(`companies/${companyId}/actionApprovals/${approvedContext.approvalId}`, {
    action,
  });
  const reconciled = await reconcileCodingPublication({
    companyId,
    runId,
    actorUid: "admin-1",
    inspectPublication: async () => ({
      branchSha: "b".repeat(40),
      pullRequest: {
        number: 42,
        url: "https://github.com/tomaash/elixir-play/pull/42",
        draft: true,
        state: "open",
        mergedAt: null,
        headSha: "b".repeat(40),
        headBranch: action.git.resultBranch,
        baseBranch: "main",
      },
    }),
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T12:00:00Z")),
  });
  assert.equal(reconciled.status, "succeeded");
  assert.equal(
    (reconciled.publicationResult as Record<string, unknown>).pullRequestNumber,
    42,
  );

  memory.seed(runPath, {
    ...memory.read(runPath),
    status: "outcome_unknown",
    phase: "outcome_unknown",
  });
  const conflicted = await reconcileCodingPublication({
    companyId,
    runId,
    actorUid: "admin-1",
    inspectPublication: async () => ({
      branchSha: "c".repeat(40),
      pullRequest: null,
    }),
    database: memory.asFirestore(),
  });
  assert.equal(conflicted.status, "failed");
  assert.equal((conflicted.error as Record<string, unknown>).code, "publication_conflict");
});

test("GitHub publication inspection uses a read-only token and exact branch/PR identity", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let tokenRequest: Record<string, unknown> | null = null;
  const fetcher = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/access_tokens")) {
      tokenRequest = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        token: "read-token",
        expires_at: "2026-08-01T13:00:00Z",
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/repos/tomaash/elixir-play") {
      return new Response(JSON.stringify({ id: 987654, full_name: "tomaash/elixir-play" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.includes("/git/ref/heads/erik/issue-17-eeeeeeee")) {
      return new Response(JSON.stringify({ object: { sha: "b".repeat(40) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/pulls")) {
      assert.equal(url.searchParams.get("state"), "all");
      assert.equal(url.searchParams.get("head"), "tomaash:erik/issue-17-eeeeeeee");
      return new Response(JSON.stringify([{
        number: 42,
        html_url: "https://github.com/tomaash/elixir-play/pull/42",
        draft: true,
        state: "open",
        merged_at: null,
        head: { sha: "b".repeat(40), ref: "erik/issue-17-eeeeeeee" },
        base: { ref: "main" },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const snapshot = await inspectGitHubPublication({
    configuration: {
      appId: 4447426,
      clientId: "Iv23liy3QUr30tDzuO2F",
      appSlug: "agent-erik-development",
      privateKey,
    },
    installationId: 150346586,
    repositoryId: 987654,
    fullName: "tomaash/elixir-play",
    resultBranch: "erik/issue-17-eeeeeeee",
    baseBranch: "main",
    fetcher,
  });
  assert.equal(snapshot.pullRequest?.number, 42);
  assert.deepEqual(tokenRequest, {
    permissions: {
      contents: "read",
      issues: "read",
      metadata: "read",
      pull_requests: "read",
    },
  });
});

test("publication reconciliation safely republishes a matching orphan branch", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const action = codingAction();
  const runId = action.runId;
  memory.seed(`companies/${companyId}/codingRuns/${runId}`, {
    status: "outcome_unknown",
    phase: "outcome_unknown",
    authorization: { approvalId: approvedContext.approvalId },
    github: { owner: "tomaash", repo: "elixir-play", repositoryId: 987654 },
    git: {
      baseBranch: "main",
      baseSha: "a".repeat(40),
      resultSha: "b".repeat(40),
      proposedBranch: action.git.resultBranch,
    },
  });
  memory.seed(`companies/${companyId}/actionApprovals/${approvedContext.approvalId}`, {
    action,
  });
  let queued = false;
  await reconcileCodingPublication({
    companyId,
    runId,
    actorUid: "admin-1",
    inspectPublication: async () => ({
      branchSha: "b".repeat(40),
      pullRequest: null,
    }),
    queuePublisher: async () => {
      queued = true;
      return getCodingRun({ companyId, runId, database: memory.asFirestore() });
    },
    database: memory.asFirestore(),
  });
  assert.equal(queued, true);
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${runId}`)?.status, "ready_to_publish");
  assert.equal(memory.read(`companies/${companyId}/codingRuns/${runId}`)?.phase, "orphan_branch_recovered");
});

test("cancellation targets the active publisher and closes pre-publication runs", async () => {
  const memory = new MemoryFirestore();
  const action = codingAction();
  const runPath = `companies/${companyId}/codingRuns/${action.runId}`;
  memory.seed(runPath, {
    status: "publishing",
    phase: "publisher_queued",
    cloudRun: {
      dispatcherExecutionName: "dispatcher-old",
      runnerExecutionName: "runner-old",
      publisherExecutionName: "publisher-current",
    },
  });
  const cancelled: string[] = [];
  const result = await cancelCodingRun({
    companyId,
    runId: action.runId,
    actorUid: "admin-1",
    cancelExecution: async (executionName) => { cancelled.push(executionName); },
    database: memory.asFirestore(),
  });
  assert.deepEqual(cancelled, ["publisher-current"]);
  assert.equal(result.status, "cancel_requested");

  memory.seed(runPath, {
    ...memory.read(runPath),
    status: "queued",
    phase: "auth_refresh_queued",
    cloudRun: { authRefreshExecutionName: "erik-grok-auth-current" },
  });
  await cancelCodingRun({
    companyId,
    runId: action.runId,
    actorUid: "admin-1",
    cancelExecution: async (executionName) => { cancelled.push(executionName); },
    database: memory.asFirestore(),
  });
  assert.deepEqual(cancelled, ["publisher-current", "erik-grok-auth-current"]);

  memory.seed(runPath, {
    ...memory.read(runPath),
    status: "ready_to_publish",
    phase: "ready_to_publish",
    cloudRun: {},
  });
  const beforePublish = await cancelCodingRun({
    companyId,
    runId: action.runId,
    actorUid: "admin-1",
    cancelExecution: async () => { throw new Error("must not be called"); },
    database: memory.asFirestore(),
  });
  assert.equal(beforePublish.status, "cancelled");
});

test("a publisher completion remains factual after cancellation was requested", async () => {
  const memory = new MemoryFirestore();
  const action = codingAction();
  const runPath = `companies/${companyId}/codingRuns/${action.runId}`;
  memory.seed(`codingRunRoutes/${action.runId}`, { companyId });
  memory.seed(runPath, {
    status: "cancel_requested",
    phase: "cancel_requested",
    cancelRequestedFromStatus: "publishing",
    authorization: {
      approvalId: approvedContext.approvalId,
      effectDigest: "f".repeat(64),
    },
    git: {
      baseSha: action.git.baseSha,
      resultSha: "b".repeat(40),
      proposedBranch: action.git.resultBranch,
    },
  });
  const callback = await processCodingCallback({
    principalEmail: "erik-coding-dispatcher@odorik-tx-260720-c58d.iam.gserviceaccount.com",
    body: {
      eventId: "publisher-completed-after-cancel",
      runId: action.runId,
      type: "completed",
      status: "succeeded",
      phase: "succeeded",
      message: "Draft pull request opened",
      result: {
        baseSha: action.git.baseSha,
        resultSha: "b".repeat(40),
        branch: action.git.resultBranch,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/tomaash/elixir-play/pull/42",
        draft: true,
        approvalId: approvedContext.approvalId,
        effectDigest: "f".repeat(64),
      },
    },
    database: memory.asFirestore(),
  });
  assert.equal(callback.shouldPublish, false);
  assert.equal(memory.read(runPath)?.status, "succeeded");
  assert.equal(
    (memory.read(runPath)?.publicationResult as Record<string, unknown>).pullRequestNumber,
    42,
  );
});

test("Cloud Run recovery resolves runner and trusted publisher executions to their own jobs", () => {
  assert.match(
    canonicalCodingExecutionName("erik-coding-runner-abc12"),
    /\/jobs\/erik-coding-runner\/executions\/erik-coding-runner-abc12$/,
  );
  assert.match(
    canonicalCodingExecutionName("erik-coding-dispatcher-abc12"),
    /\/jobs\/erik-coding-dispatcher\/executions\/erik-coding-dispatcher-abc12$/,
  );
  assert.match(
    canonicalCodingExecutionName("erik-grok-auth-abc12"),
    /\/jobs\/erik-grok-auth\/executions\/erik-grok-auth-abc12$/,
  );
  assert.throws(() => canonicalCodingExecutionName("untrusted-execution"), /Invalid/);
});

test("PR change requests create a separately approved linked fast-forward attempt", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const action = codingAction();
  const runId = action.runId;
  memory.seed(`companies/${companyId}/codingRuns/${runId}`, {
    status: "succeeded",
    phase: "succeeded",
    authorization: { approvalId: approvedContext.approvalId },
    github: {
      owner: "tomaash",
      repo: "elixir-play",
      repositoryId: 987654,
      issueContextItemId: contextItemId,
    },
    git: {
      baseBranch: "main",
      sourceBranch: "main",
      baseSha: "a".repeat(40),
      resultSha: "b".repeat(40),
      proposedBranch: action.git.resultBranch,
    },
    publicationResult: {
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/tomaash/elixir-play/pull/42",
      branch: action.git.resultBranch,
      draft: true,
    },
  });
  memory.seed(`companies/${companyId}/actionApprovals/${approvedContext.approvalId}`, {
    action,
  });
  const requested = await requestCodingPullRequestChangesApproval({
    companyId,
    actorUid: "admin-1",
    preferredApproverUid: "admin-1",
    runId,
    instructions: "Add a regression test for the parser edge case.",
    configuration: {
      appId: 4447426,
      clientId: "Iv23liy3QUr30tDzuO2F",
      appSlug: "agent-erik-development",
      privateKey: "unused-by-the-injected-inspector",
    },
    inspectPublication: async () => ({
      branchSha: "b".repeat(40),
      pullRequest: {
        number: 42,
        url: "https://github.com/tomaash/elixir-play/pull/42",
        draft: true,
        state: "open",
        mergedAt: null,
        headSha: "b".repeat(40),
        headBranch: action.git.resultBranch,
        baseBranch: "main",
      },
    }),
    database: memory.asFirestore(),
  });
  assert.equal(requested.status, "pending");
  const linked = requested.action as CodingIssueImplementAction;
  assert.equal(linked.linkedAttempt?.kind, "pull_request_changes");
  assert.equal(linked.linkedAttempt?.parentRunId, runId);
  assert.equal(linked.linkedAttempt?.attempt, 2);
  assert.equal(linked.git.sourceBranch, action.git.resultBranch);
  assert.equal(linked.git.baseSha, "b".repeat(40));
  assert.equal(linked.git.resultBranch, action.git.resultBranch);
  assert.equal(linked.publication.existingPullRequestNumber, 42);
  assert.equal(memory.list(`companies/${companyId}/codingRuns`).length, 1);
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

test("reconciliation treats publisher cancellation without a callback as outcome unknown", async () => {
  const memory = new MemoryFirestore();
  memory.seed(`companies/${companyId}`, { displayName: "Explorers" });
  const runId = codingAction().runId;
  const runPath = `companies/${companyId}/codingRuns/${runId}`;
  memory.seed(runPath, {
    status: "cancel_requested",
    phase: "cancel_requested",
    cancelRequestedFromStatus: "publishing",
    cloudRun: { publisherExecutionName: "erik-coding-dispatcher-publish1" },
    createdAt: Timestamp.fromDate(new Date("2026-08-01T10:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-08-01T10:01:00Z")),
  });
  const result = await reconcileCodingRuns({
    artifactStore: new MemoryArtifacts(),
    inspectExecution: async () => ({ terminal: true, outcome: "cancelled" }),
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-08-01T10:02:00Z")),
  });
  assert.deepEqual(result, { inspected: 1, repaired: 1, failures: 0 });
  assert.equal(memory.read(runPath)?.status, "outcome_unknown");
  assert.equal(memory.read(runPath)?.phase, "publication_cancellation_unknown");
});


test("coding retries accept empty instructions and allocate unique attempt numbers", async () => {
  const memory = new MemoryFirestore();
  seedCodingSources(memory);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const configuration = {
    appId: 4447426,
    clientId: "Iv23liy3QUr30tDzuO2F",
    appSlug: "agent-erik-development",
    privateKey,
  };
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
  const rootRunId = codingAction().runId;
  memory.seed(`companies/${companyId}/codingRuns/${rootRunId}`, {
    status: "no_changes",
    phase: "no_changes",
    github: {
      connectionId,
      repoResourceId: resourceId,
      repositoryId: 987654,
      owner: "tomaash",
      repo: "elixir-play",
      issueNumber: 17,
      issueContextItemId: contextItemId,
      issueUrl: "https://github.com/tomaash/elixir-play/issues/17",
    },
    git: {
      baseBranch: "main",
      sourceBranch: "main",
      baseSha: "a".repeat(40),
      proposedBranch: `erik/issue-17-${rootRunId.slice(-8)}`,
    },
  });

  const first = await requestCodingRetryApproval({
    companyId,
    actorUid: "admin-1",
    preferredApproverUid: "admin-1",
    runId: rootRunId,
    configuration,
    fetcher,
    database: memory.asFirestore(),
  });
  assert.equal(first.status, "pending");
  const firstAction = first.action as CodingIssueImplementAction;
  assert.equal(firstAction.linkedAttempt?.kind, "retry");
  assert.equal(firstAction.linkedAttempt?.attempt, 2);
  assert.equal(firstAction.linkedAttempt?.parentRunId, rootRunId);
  assert.match(firstAction.linkedAttempt?.instructions || "", /Retry the previous coding attempt/);

  // Simulate the first retry already finishing without changes, then request again.
  memory.seed(`companies/${companyId}/actionApprovals/${first.id}`, {
    ...first,
    decisionStatus: "approved",
    status: "approved",
    executionStatus: "succeeded",
  });
  memory.seed(`companies/${companyId}/codingRuns/${firstAction.runId}`, {
    status: "no_changes",
    phase: "no_changes",
    github: {
      connectionId,
      repoResourceId: resourceId,
      repositoryId: 987654,
      owner: "tomaash",
      repo: "elixir-play",
      issueNumber: 17,
      issueContextItemId: contextItemId,
      issueUrl: "https://github.com/tomaash/elixir-play/issues/17",
    },
    linkedAttempt: firstAction.linkedAttempt,
    git: {
      baseBranch: "main",
      sourceBranch: "main",
      baseSha: "a".repeat(40),
      proposedBranch: firstAction.git.resultBranch,
    },
  });

  // A second request against the same parent must not fingerprint to the same
  // approval, or operators cannot re-run after a failed/no-change attempt.
  const second = await requestCodingRetryApproval({
    companyId,
    actorUid: "admin-1",
    preferredApproverUid: "admin-1",
    runId: rootRunId,
    instructions: "  ",
    configuration,
    fetcher,
    database: memory.asFirestore(),
  });
  assert.equal(second.status, "pending");
  assert.notEqual(second.id, first.id);
  const secondAction = second.action as CodingIssueImplementAction;
  assert.equal(secondAction.linkedAttempt?.attempt, 3);
  assert.notEqual(secondAction.runId, firstAction.runId);
});
