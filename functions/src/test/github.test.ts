import assert from "node:assert/strict";
import {
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";
import {
  connectGitHubInstallation,
  configuredGitHubInstallationId,
  githubAppJwt,
  githubConfigurationFromEnvironment,
  githubIssueContextItemId,
  githubRepositoryResourceId,
  inspectGitHubInstallation,
  syncGitHubConnection,
  type GitHubAppConfiguration,
  type GitHubIssue,
  type GitHubRepository,
} from "../connectors/github.js";
import { MemoryFirestore } from "./firestore-harness.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const configuration: GitHubAppConfiguration = {
  appId: 4447426,
  clientId: "Iv23liy3QUr30tDzuO2F",
  appSlug: "agent-erik-development",
  privateKey,
};
const installationId = 150346586;
const permissions = {
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
};
const repository: GitHubRepository = {
  id: 987654,
  name: "elixir-play",
  full_name: "tomaash/elixir-play",
  private: false,
  default_branch: "main",
  html_url: "https://github.com/tomaash/elixir-play",
  owner: { login: "tomaash" },
};

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFixtureFetcher(input?: {
  installationPermissions?: Record<string, string>;
  requests?: Array<{ url: string; method: string; authorization: string | null; body: string }>;
}): typeof fetch {
  return (async (requestInput: string | URL | Request, init?: RequestInit) => {
    const url = String(requestInput);
    const parsed = new URL(url);
    const method = init?.method || "GET";
    input?.requests?.push({
      url,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: String(init?.body || ""),
    });
    if (parsed.pathname === "/app") {
      return jsonResponse({ id: configuration.appId, slug: configuration.appSlug });
    }
    if (parsed.pathname === `/app/installations/${installationId}`) {
      return jsonResponse({
        id: installationId,
        app_id: configuration.appId,
        account: { id: 12345, login: "tomaash", type: "User" },
        repository_selection: "selected",
        permissions: input?.installationPermissions || permissions,
        suspended_at: null,
      });
    }
    if (parsed.pathname === `/app/installations/${installationId}/access_tokens`) {
      return jsonResponse({
        token: "short-lived-installation-token",
        expires_at: "2026-07-31T12:00:00Z",
        permissions,
        repository_selection: "selected",
      });
    }
    if (parsed.pathname === "/installation/repositories") {
      return jsonResponse({ repositories: [repository] });
    }
    if (parsed.pathname === "/repos/tomaash/elixir-play/issues/17/comments") {
      return jsonResponse([{
        id: 8001,
        body: "Confirmed on the current main branch.",
        html_url: "https://github.com/tomaash/elixir-play/issues/17#issuecomment-8001",
        created_at: "2026-07-30T11:00:00Z",
        updated_at: "2026-07-30T11:00:00Z",
        user: { login: "reviewer" },
      }]);
    }
    if (parsed.pathname === "/repos/tomaash/elixir-play/issues") {
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
        assignees: [{ login: "maintainer" }],
        labels: [{ name: "bug" }],
      };
      return jsonResponse([
        issue,
        { ...issue, id: 7002, number: 18, pull_request: {} },
      ]);
    }
    return jsonResponse({ message: `Unexpected fixture request ${parsed.pathname}` }, 404);
  }) as typeof fetch;
}

test("GitHub App JWT uses the public client ID and has a valid short-lived signature", () => {
  const jwt = githubAppJwt(configuration, 1_800_000_000);
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.deepEqual(decodeJwtPart(headerPart!), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeJwtPart(payloadPart!), {
    iat: 1_799_999_940,
    exp: 1_800_000_540,
    iss: configuration.clientId,
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signaturePart!, "base64url")), true);
});

test("configured GitHub identifiers are validated and contain no private credential", () => {
  assert.deepEqual(githubConfigurationFromEnvironment("pem", {}), {
    appId: 4447426,
    clientId: "Iv23liy3QUr30tDzuO2F",
    appSlug: "agent-erik-development",
    privateKey: "pem",
  });
  assert.equal(configuredGitHubInstallationId({}), installationId);
  assert.throws(
    () => configuredGitHubInstallationId({ GITHUB_DEVELOPMENT_INSTALLATION_ID: "nope" }),
    /positive integer/,
  );
});

test("installation inspection requests only read permissions and rejects write grants", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
  const snapshot = await inspectGitHubInstallation({
    configuration,
    installationId,
    fetcher: githubFixtureFetcher({ requests }),
  });
  assert.equal(snapshot.account.login, "tomaash");
  assert.deepEqual(snapshot.repositories.map((entry) => entry.full_name), ["tomaash/elixir-play"]);
  const tokenRequest = requests.find((request) => request.url.includes("/access_tokens"));
  assert.equal(tokenRequest?.method, "POST");
  assert.deepEqual(JSON.parse(tokenRequest?.body || "{}"), { permissions });
  assert.ok(requests.slice(0, 3).every((request) => request.authorization?.startsWith("Bearer eyJ")));
  assert.equal(requests.at(-1)?.authorization, "Bearer short-lived-installation-token");

  await assert.rejects(
    inspectGitHubInstallation({
      configuration,
      installationId,
      fetcher: githubFixtureFetcher({
        installationPermissions: { ...permissions, issues: "write" },
      }),
    }),
    /not read-only/,
  );
});

test("GitHub connection preserves explicit selection, removes stale context, and syncs issues", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionId = `github_${installationId}`;
  const connectionPath = `companies/explorers/connections/${connectionId}`;
  const resourceId = githubRepositoryResourceId(repository.id);
  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "github",
    status: "active",
    createdBy: "admin-original",
    createdAt: "2026-07-30T00:00:00Z",
  });
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    externalId: String(repository.id),
    displayName: repository.full_name,
    status: "enabled",
    itemCount: 4,
    createdAt: "2026-07-30T00:00:00Z",
  });
  memory.seed(`${connectionPath}/resources/stale-repo`, {
    externalId: "111",
    displayName: "tomaash/removed",
    status: "enabled",
  });
  memory.seed("companies/explorers/contextItems/stale-removed-repo", {
    source: { connectionId, resourceId: "stale-repo" },
    indexingEnabled: true,
  });

  assert.deepEqual(await connectGitHubInstallation({
    companyId: "explorers",
    actorUid: "admin-current",
    installationId,
    configuration,
    fetcher: githubFixtureFetcher(),
    database,
  }), { connectionId, repositories: 1 });
  assert.equal(memory.read(`${connectionPath}/resources/${resourceId}`)?.status, "enabled");
  assert.equal(memory.read(`${connectionPath}/resources/stale-repo`), undefined);
  assert.equal(memory.read("companies/explorers/contextItems/stale-removed-repo"), undefined);
  assert.equal(memory.read(connectionPath)?.createdBy, "admin-original");
  assert.deepEqual(memory.read(connectionPath)?.auth, {
    kind: "github_app",
    credentialMode: "shared_secret",
    scopes: ["contents:read", "issues:read", "metadata:read", "pull_requests:read"],
  });

  memory.seed("companies/explorers/contextItems/stale-current-repo", {
    source: { connectionId, resourceId },
    indexingEnabled: true,
  });
  assert.deepEqual(await syncGitHubConnection({
    companyId: "explorers",
    connectionId,
    configuration,
    fetcher: githubFixtureFetcher(),
    database,
  }), { repositories: 1, issues: 1 });
  assert.equal(memory.read("companies/explorers/contextItems/stale-current-repo"), undefined);
  const contextId = githubIssueContextItemId(connectionId, repository.id, 7001);
  const context = memory.read(`companies/explorers/contextItems/${contextId}`);
  assert.equal(context?.title, "[tomaash/elixir-play #17] Keep the parser total");
  assert.equal(context?.indexingEnabled, true);
  assert.deepEqual(context?.source, {
    providerId: "github",
    capabilityId: "context.github.issue.read",
    connectionId,
    resourceId,
    externalId: "7001",
    version: "2026-07-30T11:00:00Z",
  });
  assert.match(String(context?.text), /Confirmed on the current main branch/);
  assert.doesNotMatch(JSON.stringify(memory.entries()), /short-lived-installation-token|BEGIN PRIVATE KEY/);
});
