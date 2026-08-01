import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  githubWebhookSignature,
  processGitHubWebhookDelivery,
  queueGitHubWebhookDelivery,
  verifyGitHubWebhookSignature,
  type QueuedGitHubWebhookPayload,
} from "../connectors/github-webhook.js";
import {
  githubInstallationRoutingPath,
  githubIssueContextItemId,
  githubRepositoryResourceId,
  type GitHubAppConfiguration,
  type GitHubIssue,
  type GitHubRepository,
} from "../connectors/github.js";
import { MemoryFirestore } from "./firestore-harness.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const configuration: GitHubAppConfiguration = {
  appId: 4447426,
  clientId: "Iv23liy3QUr30tDzuO2F",
  appSlug: "agent-erik-development",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const installationId = 150346586;
const connectionId = `github_${installationId}`;
const repository: GitHubRepository = {
  id: 987654,
  name: "elixir-play",
  full_name: "tomaash/elixir-play",
  private: false,
  default_branch: "main",
  html_url: "https://github.com/tomaash/elixir-play",
  owner: { login: "tomaash" },
};
const issue: GitHubIssue = {
  id: 7001,
  number: 17,
  title: "Keep the parser total",
  body: "The parser throws on an empty token stream.",
  state: "open",
  html_url: "https://github.com/tomaash/elixir-play/issues/17",
  created_at: "2026-07-29T10:00:00Z",
  updated_at: "2026-07-30T11:00:00Z",
  closed_at: null,
  comments: 1,
  user: { login: "tomaash" },
  assignees: [],
  labels: [{ name: "bug" }],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function canonicalIssueFetcher(requests: string[] = []): typeof fetch {
  return (async (requestInput: string | URL | Request) => {
    const url = String(requestInput);
    const parsed = new URL(url);
    requests.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === `/app/installations/${installationId}/access_tokens`) {
      return jsonResponse({
        token: "short-lived-token",
        expires_at: "2026-07-31T12:00:00Z",
        permissions: {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
        repository_selection: "selected",
      });
    }
    if (parsed.pathname === "/repos/tomaash/elixir-play/issues/17") {
      return jsonResponse(issue);
    }
    if (parsed.pathname === "/repos/tomaash/elixir-play/issues/17/comments") {
      return jsonResponse([{
        id: 9001,
        body: "Confirmed on main.",
        html_url: "https://github.com/tomaash/elixir-play/issues/17#issuecomment-9001",
        created_at: "2026-07-30T11:30:00Z",
        updated_at: "2026-07-30T11:30:00Z",
        user: { login: "reviewer" },
      }]);
    }
    return jsonResponse({ message: `Unexpected ${parsed.pathname}` }, 404);
  }) as typeof fetch;
}

function webhookPayload(overrides: Partial<QueuedGitHubWebhookPayload> = {}): QueuedGitHubWebhookPayload {
  return {
    action: "opened",
    installation: { id: installationId },
    repository,
    issue,
    ...overrides,
  };
}

function seedConnection(memory: MemoryFirestore, enabled = true): string {
  const connectionPath = `companies/explorers/connections/${connectionId}`;
  memory.seed(githubInstallationRoutingPath(installationId), {
    installationId,
    appId: configuration.appId,
    companyId: "explorers",
    connectionId,
  });
  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "github",
    installationId,
    status: "active",
  });
  memory.seed(`${connectionPath}/capabilities/issues`, {
    capabilityId: "context.github.issue.read",
    status: "active",
  });
  const resourceId = githubRepositoryResourceId(repository.id);
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    connectionId,
    capabilityId: "context.github.issue.read",
    resourceType: "repository",
    externalId: String(repository.id),
    displayName: repository.full_name,
    status: enabled ? "enabled" : "disabled",
    itemCount: 0,
  });
  return resourceId;
}

test("GitHub webhook HMAC matches GitHub's published SHA-256 fixture", () => {
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from("Hello, World!", "utf8");
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(githubWebhookSignature(body, secret), signature);
  assert.equal(verifyGitHubWebhookSignature({ body, signature, secret }), true);
  assert.equal(verifyGitHubWebhookSignature({ body, signature: `${signature}0`, secret }), false);
  assert.equal(verifyGitHubWebhookSignature({ body, signature: undefined, secret }), false);
});

test("signed deliveries are tenant-routed, minimized, and deduplicated", async () => {
  const memory = new MemoryFirestore();
  seedConnection(memory);
  const body = Buffer.from(JSON.stringify({
    action: "opened",
    installation: { id: installationId, access_tokens_url: "must-not-persist" },
    repository: { ...repository, clone_url: "must-not-persist" },
    issue: { ...issue, extra_private_field: "must-not-persist" },
    sender: { login: "must-not-persist" },
  }));
  const secret = "test-webhook-secret";
  const request = {
    body,
    signature: githubWebhookSignature(body, secret),
    event: "issues",
    deliveryId: "12345678-1234-1234-1234-123456789abc",
    secret,
    database: memory.asFirestore(),
    now: Timestamp.fromDate(new Date("2026-07-31T12:00:00Z")),
  };
  assert.deepEqual(await queueGitHubWebhookDelivery(request), {
    status: "queued",
    deliveryId: request.deliveryId,
    event: "issues",
  });
  assert.deepEqual(await queueGitHubWebhookDelivery(request), {
    status: "duplicate",
    deliveryId: request.deliveryId,
    event: "issues",
  });
  const deliveries = memory.list("githubWebhookDeliveries");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.companyId, "explorers");
  const serialized = JSON.stringify(deliveries[0]);
  assert.doesNotMatch(serialized, /must-not-persist/);
  assert.doesNotMatch(serialized, /test-webhook-secret/);

  await assert.rejects(
    queueGitHubWebhookDelivery({ ...request, signature: "sha256=".padEnd(71, "0") }),
    (error: unknown) => (
      error instanceof Error
      && "statusCode" in error
      && error.statusCode === 401
    ),
  );
});

test("a valid signature cannot route an installation across company boundaries", async () => {
  const memory = new MemoryFirestore();
  const body = Buffer.from(JSON.stringify({
    action: "opened",
    installation: { id: installationId },
    repository,
    issue,
  }));
  const secret = "test-webhook-secret";
  await assert.rejects(
    queueGitHubWebhookDelivery({
      body,
      signature: githubWebhookSignature(body, secret),
      event: "issues",
      deliveryId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      secret,
      database: memory.asFirestore(),
    }),
    (error: unknown) => (
      error instanceof Error
      && "statusCode" in error
      && error.statusCode === 404
    ),
  );
  assert.equal(memory.list("githubWebhookDeliveries").length, 0);
});

test("selected repository events fetch canonical comments and update context idempotently", async () => {
  const memory = new MemoryFirestore();
  const resourceId = seedConnection(memory);
  const requests: string[] = [];
  const input = {
    deliveryId: "delivery-selected-1",
    event: "issue_comment" as const,
    action: "created",
    companyId: "explorers",
    connectionId,
    installationId,
    payload: webhookPayload({ action: "created" }),
    configuration,
    fetcher: canonicalIssueFetcher(requests),
    database: memory.asFirestore(),
    observedAt: Timestamp.fromDate(new Date("2026-07-31T12:30:00Z")),
  };
  const expected = {
    outcome: "issue_upserted",
    issueContextItemId: githubIssueContextItemId(connectionId, repository.id, issue.id),
  };
  assert.deepEqual(await processGitHubWebhookDelivery(input), expected);
  assert.deepEqual(await processGitHubWebhookDelivery(input), expected);

  const contextId = githubIssueContextItemId(connectionId, repository.id, issue.id);
  const context = memory.read(`companies/explorers/contextItems/${contextId}`);
  assert.equal(context?.companyId, "explorers");
  assert.equal(context?.indexingEnabled, true);
  assert.match(String(context?.text), /Confirmed on main/);
  assert.equal(
    memory.read(`companies/explorers/connections/${connectionId}/resources/${resourceId}`)?.itemCount,
    1,
  );
  assert.equal(memory.list("companies/explorers/auditEvents").length, 1);
  assert.equal(
    (memory.read(`companies/explorers/connections/${connectionId}`)?.webhook as Record<string, unknown>)
      ?.status,
    "active",
  );
  assert.ok(requests.some((request) => request.endsWith("/access_tokens")));
  assert.ok(requests.some((request) => request.includes("/issues/17/comments")));
  assert.doesNotMatch(JSON.stringify(memory.entries()), /short-lived-token|BEGIN PRIVATE KEY/);
});

test("unselected repository deliveries are acknowledged without provider access", async () => {
  const memory = new MemoryFirestore();
  seedConnection(memory, false);
  const result = await processGitHubWebhookDelivery({
    deliveryId: "delivery-disabled-1",
    event: "issues",
    action: "opened",
    companyId: "explorers",
    connectionId,
    installationId,
    payload: webhookPayload(),
    configuration,
    fetcher: (async () => {
      throw new Error("provider must not be called");
    }) as typeof fetch,
    database: memory.asFirestore(),
  });
  assert.deepEqual(result, { outcome: "ignored_unselected_repository" });
  assert.equal(memory.list("companies/explorers/contextItems").length, 0);
});

test("deleted issue deliveries remove context without a provider round trip", async () => {
  const memory = new MemoryFirestore();
  const resourceId = seedConnection(memory);
  const contextId = githubIssueContextItemId(connectionId, repository.id, issue.id);
  memory.seed(`companies/explorers/contextItems/${contextId}`, {
    companyId: "explorers",
    source: { connectionId, resourceId },
    indexingEnabled: true,
  });
  const result = await processGitHubWebhookDelivery({
    deliveryId: "delivery-deleted-1",
    event: "issues",
    action: "deleted",
    companyId: "explorers",
    connectionId,
    installationId,
    payload: webhookPayload({ action: "deleted" }),
    configuration,
    fetcher: (async () => {
      throw new Error("provider must not be called");
    }) as typeof fetch,
    database: memory.asFirestore(),
  });
  assert.deepEqual(result, { outcome: "issue_deleted" });
  assert.equal(memory.read(`companies/explorers/contextItems/${contextId}`), undefined);
});

test("processing fails closed when the queued tenant route is tampered with", async () => {
  const memory = new MemoryFirestore();
  seedConnection(memory);
  await assert.rejects(
    processGitHubWebhookDelivery({
      deliveryId: "delivery-route-1",
      event: "issues",
      action: "opened",
      companyId: "another-company",
      connectionId,
      installationId,
      payload: webhookPayload(),
      configuration,
      fetcher: canonicalIssueFetcher(),
      database: memory.asFirestore(),
    }),
    /tenant routing check failed/,
  );
  assert.equal(memory.list("companies/another-company/contextItems").length, 0);
});
