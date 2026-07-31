import { createSign } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";

export const githubIssueCapabilityId = "context.github.issue.read" as const;
export const githubRequiredPermissions = {
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
} as const;

export type GitHubAppConfiguration = {
  appId: number;
  clientId: string;
  appSlug: string;
  privateKey: string;
};

export type GitHubAccount = {
  id: number;
  login: string;
  type: string;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string };
};

type GitHubInstallation = {
  id: number;
  account: GitHubAccount;
  app_id: number;
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  suspended_at?: string | null;
};

type InstallationTokenResponse = {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repository_selection: "all" | "selected";
};

export type GitHubInstallationSnapshot = {
  installationId: number;
  account: GitHubAccount;
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  repositories: GitHubRepository[];
  token: string;
  tokenExpiresAt: string;
};

export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  user: { login: string } | null;
  assignees?: Array<{ login: string }>;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
};

export type GitHubComment = {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
};

export type FetchLike = typeof fetch;

const githubApiVersion = "2026-03-10";
const maxIssuePagesPerRepository = 10;
const maxCommentPagesPerIssue = 10;
const maxContextTextCharacters = 500_000;

export function githubConfigurationFromEnvironment(
  privateKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppConfiguration {
  const appId = Number(environment.GITHUB_APP_ID || "4447426");
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error("GITHUB_APP_ID must be a positive integer");
  }
  return {
    appId,
    clientId: environment.GITHUB_CLIENT_ID || "Iv23liy3QUr30tDzuO2F",
    appSlug: environment.GITHUB_APP_SLUG || "agent-erik-development",
    privateKey,
  };
}

export function configuredGitHubInstallationId(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const installationId = Number(
    environment.GITHUB_DEVELOPMENT_INSTALLATION_ID || "150346586",
  );
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("GITHUB_DEVELOPMENT_INSTALLATION_ID must be a positive integer");
  }
  return installationId;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function githubAppJwt(
  configuration: Pick<GitHubAppConfiguration, "clientId" | "privateKey">,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const unsigned = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: configuration.clientId,
    }),
  ].join(".");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(configuration.privateKey, "base64url")}`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agent-erik-github-connector",
    "x-github-api-version": githubApiVersion,
  };
}

async function githubRequest<T>(
  fetcher: FetchLike,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${body.message || "unknown error"}`);
  }
  return body;
}

function assertReadOnlyPermissions(permissions: Record<string, string>): void {
  for (const [permission, level] of Object.entries(permissions)) {
    if (!["read", "none"].includes(level)) {
      throw new Error(`GitHub App permission ${permission} is not read-only`);
    }
  }
  for (const [permission, expected] of Object.entries(githubRequiredPermissions)) {
    if (permissions[permission] !== expected) {
      throw new Error(`GitHub App permission ${permission} must be ${expected}`);
    }
  }
}

export async function inspectGitHubInstallation(input: {
  configuration: GitHubAppConfiguration;
  installationId: number;
  fetcher?: FetchLike;
}): Promise<GitHubInstallationSnapshot> {
  const fetcher = input.fetcher || fetch;
  const jwt = githubAppJwt(input.configuration);
  const app = await githubRequest<{ id: number; slug: string }>(fetcher, "/app", jwt);
  if (app.id !== input.configuration.appId || app.slug !== input.configuration.appSlug) {
    throw new Error("GitHub App identity does not match configured identifiers");
  }
  const installation = await githubRequest<GitHubInstallation>(
    fetcher,
    `/app/installations/${input.installationId}`,
    jwt,
  );
  if (installation.app_id !== input.configuration.appId || installation.id !== input.installationId) {
    throw new Error("GitHub installation does not belong to the configured App");
  }
  if (installation.suspended_at) throw new Error("GitHub App installation is suspended");
  assertReadOnlyPermissions(installation.permissions);

  const tokenResult = await githubRequest<InstallationTokenResponse>(
    fetcher,
    `/app/installations/${input.installationId}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({ permissions: githubRequiredPermissions }),
    },
  );
  assertReadOnlyPermissions(tokenResult.permissions);

  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest<{ repositories: GitHubRepository[] }>(
      fetcher,
      `/installation/repositories?per_page=100&page=${page}`,
      tokenResult.token,
    );
    repositories.push(...response.repositories);
    if (response.repositories.length < 100) break;
  }
  return {
    installationId: installation.id,
    account: installation.account,
    repositorySelection: installation.repository_selection,
    permissions: tokenResult.permissions,
    repositories,
    token: tokenResult.token,
    tokenExpiresAt: tokenResult.expires_at,
  };
}

export function githubRepositoryResourceId(repositoryId: number): string {
  return `repo_${sha256Hex(String(repositoryId)).slice(0, 24)}`;
}

export function githubInstallationRoutingPath(installationId: number): string {
  return `githubInstallations/${installationId}`;
}

export function githubIssueContextItemId(
  connectionId: string,
  repositoryId: number,
  issueId: number,
): string {
  return `github_issue_${sha256Hex(`${connectionId}:${repositoryId}:${issueId}`).slice(0, 32)}`;
}

function labelNames(labels: GitHubIssue["labels"]): string[] {
  return (labels || []).map((label) => (
    typeof label === "string" ? label : String(label.name || "")
  )).filter(Boolean);
}

function boundedText(value: string): string {
  if (value.length <= maxContextTextCharacters) return value;
  return `${value.slice(0, maxContextTextCharacters)}\n\n[Content truncated by Agent Erik]`;
}

export function githubIssueContextItem(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  repository: GitHubRepository;
  issue: GitHubIssue;
  comments: GitHubComment[];
  observedAt?: Timestamp;
}): Record<string, unknown> {
  const labels = labelNames(input.issue.labels);
  const participants = new Set<string>();
  if (input.issue.user?.login) participants.add(input.issue.user.login);
  for (const assignee of input.issue.assignees || []) participants.add(assignee.login);
  for (const comment of input.comments) if (comment.user?.login) participants.add(comment.user.login);
  const commentText = input.comments.map((comment) => [
    `Comment by ${comment.user?.login || "unknown"} at ${comment.created_at}:`,
    comment.body || "",
    comment.html_url,
  ].join("\n")).join("\n\n");
  const text = boundedText([
    `Repository: ${input.repository.full_name}`,
    `Issue: #${input.issue.number}`,
    `State: ${input.issue.state}${input.issue.state_reason ? ` (${input.issue.state_reason})` : ""}`,
    labels.length ? `Labels: ${labels.join(", ")}` : undefined,
    input.issue.assignees?.length
      ? `Assignees: ${input.issue.assignees.map((assignee) => assignee.login).join(", ")}`
      : undefined,
    "",
    input.issue.body || "",
    commentText ? `\nComments:\n${commentText}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n"));
  const checksum = sha256Hex(JSON.stringify({ issue: input.issue, comments: input.comments }));
  return {
    companyId: input.companyId,
    kind: "github.issue",
    source: {
      providerId: "github",
      capabilityId: githubIssueCapabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: String(input.issue.id),
      version: input.issue.updated_at || checksum.slice(0, 16),
    },
    title: `[${input.repository.full_name} #${input.issue.number}] ${input.issue.title}`,
    text,
    occurredAt: input.issue.created_at,
    observedAt: input.observedAt || Timestamp.now(),
    artifactRefs: [input.issue.html_url],
    participantRefs: [...participants],
    access: { visibility: "company" },
    metadata: {
      sourceUrl: input.issue.html_url,
      repository: input.repository.full_name,
      repositoryId: input.repository.id,
      issueId: input.issue.id,
      issueNumber: input.issue.number,
      state: input.issue.state,
      stateReason: input.issue.state_reason || null,
      labels,
      author: input.issue.user?.login || null,
      assignees: (input.issue.assignees || []).map((assignee) => assignee.login),
      commentCount: input.comments.length,
      closedAt: input.issue.closed_at,
    },
    provenance: {
      rawRef: `github/${input.repository.full_name}/issues/${input.issue.number}`,
      checksum,
      ingestionVersion: "github-issues-v1",
    },
    indexingEnabled: true,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function connectionDocument(
  companyId: string,
  connectionId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.doc(`companies/${companyId}/connections/${connectionId}`);
}

async function deleteContextItemsForResource(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  database: FirebaseFirestore.Firestore;
}): Promise<number> {
  const items = await input.database.collection(`companies/${input.companyId}/contextItems`)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resourceId)
    .get();
  for (let offset = 0; offset < items.docs.length; offset += 400) {
    const batch = input.database.batch();
    for (const item of items.docs.slice(offset, offset + 400)) batch.delete(item.ref);
    await batch.commit();
  }
  return items.size;
}

export async function connectGitHubInstallation(input: {
  companyId: string;
  actorUid: string;
  installationId: number;
  configuration: GitHubAppConfiguration;
  fetcher?: FetchLike;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ connectionId: string; repositories: number }> {
  const database = input.database || db;
  const snapshot = await inspectGitHubInstallation({
    configuration: input.configuration,
    installationId: input.installationId,
    fetcher: input.fetcher,
  });
  const connectionId = `github_${snapshot.installationId}`;
  const connectionRef = connectionDocument(input.companyId, connectionId, database);
  const routingRef = database.doc(githubInstallationRoutingPath(snapshot.installationId));
  const [existingConnection, existingRouting] = await Promise.all([
    connectionRef.get(),
    routingRef.get(),
  ]);
  if (
    existingRouting.exists
    && (
      existingRouting.data()?.companyId !== input.companyId
      || existingRouting.data()?.connectionId !== connectionId
      || Number(existingRouting.data()?.appId) !== input.configuration.appId
    )
  ) {
    throw new Error("GitHub installation is already connected to another company");
  }
  const existingResources = await connectionRef.collection("resources").get();
  const resourcesByExternalId = new Map(existingResources.docs.map(
    (resource) => [String(resource.data().externalId), resource],
  ));
  const now = Timestamp.now();
  const permissionLabels = Object.entries(snapshot.permissions)
    .map(([name, level]) => `${name}:${level}`)
    .sort();
  const previousStats = existingConnection.data()?.stats || {};
  const batch = database.batch();
  batch.set(connectionRef, {
    schemaVersion: 2,
    companyId: input.companyId,
    connectorId: "github",
    providerId: "github",
    providerAccountId: String(snapshot.account.id),
    tenantId: snapshot.account.login,
    displayName: "GitHub",
    accountLabel: snapshot.account.login,
    status: "active",
    installationId: snapshot.installationId,
    repositorySelection: snapshot.repositorySelection,
    auth: {
      kind: "github_app",
      credentialMode: "shared_secret",
      scopes: permissionLabels,
    },
    stats: { ...previousStats, lastError: null },
    webhook: existingConnection.data()?.webhook || {
      status: "pending",
      lastDeliveryAt: null,
      lastEvent: null,
      lastAction: null,
      lastError: null,
    },
    reauthorizationRequired: false,
    createdBy: existingConnection.exists
      ? existingConnection.data()?.createdBy || input.actorUid
      : input.actorUid,
    createdAt: existingConnection.exists
      ? existingConnection.data()?.createdAt || now
      : now,
    updatedBy: input.actorUid,
    updatedAt: now,
  }, { merge: true });
  batch.set(routingRef, {
    installationId: snapshot.installationId,
    appId: input.configuration.appId,
    companyId: input.companyId,
    connectionId,
    accountId: snapshot.account.id,
    accountLogin: snapshot.account.login,
    createdAt: existingRouting.data()?.createdAt || now,
    updatedAt: now,
  }, { merge: true });
  batch.set(connectionRef.collection("capabilities").doc("issues"), {
    capabilityId: githubIssueCapabilityId,
    serviceId: "issues",
    status: "active",
    grantedScopes: permissionLabels,
    stats: { itemCount: Number(previousStats.itemCount || 0), lastError: null },
    createdAt: now,
    updatedAt: now,
  }, { merge: true });

  const accessibleRepositoryIds = new Set<string>();
  for (const repository of snapshot.repositories) {
    const externalId = String(repository.id);
    accessibleRepositoryIds.add(externalId);
    const existing = resourcesByExternalId.get(externalId);
    const resourceRef = connectionRef.collection("resources")
      .doc(githubRepositoryResourceId(repository.id));
    batch.set(resourceRef, {
      connectionId,
      capabilityId: githubIssueCapabilityId,
      resourceType: "repository",
      externalId,
      displayName: repository.full_name,
      providerUrl: repository.html_url,
      defaultBranch: repository.default_branch,
      private: repository.private,
      // GitHub installation selection and Erik context selection are separate.
      // New repositories are never imported until an Erik admin enables them.
      status: existing?.data().status === "enabled" ? "enabled" : "disabled",
      itemCount: Number(existing?.data().itemCount || 0),
      createdAt: existing?.data().createdAt || now,
      updatedAt: now,
    }, { merge: true });
  }
  const removedResources = existingResources.docs.filter(
    (resource) => !accessibleRepositoryIds.has(String(resource.data().externalId)),
  );
  for (const resource of removedResources) batch.delete(resource.ref);
  batch.set(database.collection(`companies/${input.companyId}/auditEvents`).doc(), {
    eventType: existingConnection.exists
      ? "source.github_connection_refreshed"
      : "source.github_connection_created",
    actorUid: input.actorUid,
    connectionId,
    connectorId: "github",
    installationId: snapshot.installationId,
    repositoryCount: snapshot.repositories.length,
    occurredAt: now,
    createdAt: now,
  });
  await batch.commit();
  for (const resource of removedResources) {
    await deleteContextItemsForResource({
      companyId: input.companyId,
      connectionId,
      resourceId: resource.id,
      database,
    });
  }
  return { connectionId, repositories: snapshot.repositories.length };
}

function repositoryApiPath(repository: GitHubRepository): string {
  const [owner, name, ...extra] = repository.full_name.split("/");
  if (!owner || !name || extra.length > 0) throw new Error("Invalid GitHub repository name");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export async function githubInstallationToken(input: {
  configuration: GitHubAppConfiguration;
  installationId: number;
  fetcher?: FetchLike;
}): Promise<{ token: string; expiresAt: string }> {
  const tokenResult = await githubRequest<InstallationTokenResponse>(
    input.fetcher || fetch,
    `/app/installations/${input.installationId}/access_tokens`,
    githubAppJwt(input.configuration),
    {
      method: "POST",
      body: JSON.stringify({ permissions: githubRequiredPermissions }),
    },
  );
  assertReadOnlyPermissions(tokenResult.permissions);
  return { token: tokenResult.token, expiresAt: tokenResult.expires_at };
}

export async function fetchGitHubIssueWithComments(input: {
  configuration: GitHubAppConfiguration;
  installationId: number;
  repository: GitHubRepository;
  issueNumber: number;
  fetcher?: FetchLike;
}): Promise<{ issue: GitHubIssue; comments: GitHubComment[] }> {
  const fetcher = input.fetcher || fetch;
  const installationToken = await githubInstallationToken({
    configuration: input.configuration,
    installationId: input.installationId,
    fetcher,
  });
  const repositoryPath = repositoryApiPath(input.repository);
  const issue = await githubRequest<GitHubIssue>(
    fetcher,
    `${repositoryPath}/issues/${input.issueNumber}`,
    installationToken.token,
  );
  const comments: GitHubComment[] = [];
  for (
    let commentPage = 1;
    issue.comments > 0 && commentPage <= maxCommentPagesPerIssue;
    commentPage += 1
  ) {
    const pageComments = await githubRequest<GitHubComment[]>(
      fetcher,
      `${repositoryPath}/issues/${input.issueNumber}/comments?per_page=100&page=${commentPage}`,
      installationToken.token,
    );
    comments.push(...pageComments);
    if (pageComments.length < 100) break;
  }
  return { issue, comments };
}

async function fetchRepositoryIssues(input: {
  token: string;
  repository: GitHubRepository;
  fetcher?: FetchLike;
}): Promise<Array<{ issue: GitHubIssue; comments: GitHubComment[] }>> {
  const fetcher = input.fetcher || fetch;
  const results: Array<{ issue: GitHubIssue; comments: GitHubComment[] }> = [];
  const repositoryPath = repositoryApiPath(input.repository);
  for (let page = 1; page <= maxIssuePagesPerRepository; page += 1) {
    const issues = await githubRequest<GitHubIssue[]>(
      fetcher,
      `${repositoryPath}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      input.token,
    );
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const comments: GitHubComment[] = [];
      for (
        let commentPage = 1;
        issue.comments > 0 && commentPage <= maxCommentPagesPerIssue;
        commentPage += 1
      ) {
        const pageComments = await githubRequest<GitHubComment[]>(
          fetcher,
          `${repositoryPath}/issues/${issue.number}/comments?per_page=100&page=${commentPage}`,
          input.token,
        );
        comments.push(...pageComments);
        if (pageComments.length < 100) break;
      }
      results.push({ issue, comments });
    }
    if (issues.length < 100) break;
  }
  return results;
}

export async function syncGitHubConnection(input: {
  companyId: string;
  connectionId: string;
  configuration: GitHubAppConfiguration;
  fetcher?: FetchLike;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ repositories: number; issues: number }> {
  const database = input.database || db;
  const connectionRef = connectionDocument(input.companyId, input.connectionId, database);
  const connection = await connectionRef.get();
  const installationId = Number(connection.data()?.installationId);
  if (
    !connection.exists
    || connection.data()?.connectorId !== "github"
    || !Number.isSafeInteger(installationId)
  ) {
    throw new Error("GitHub connection not found");
  }
  const installation = await inspectGitHubInstallation({
    configuration: input.configuration,
    installationId,
    fetcher: input.fetcher,
  });
  const repositoryById = new Map(
    installation.repositories.map((repository) => [String(repository.id), repository]),
  );
  const resources = await connectionRef.collection("resources")
    .where("capabilityId", "==", githubIssueCapabilityId)
    .where("status", "==", "enabled")
    .get();
  let issueCount = 0;
  const observedAt = Timestamp.now();
  try {
    for (const resource of resources.docs) {
      const repository = repositoryById.get(String(resource.data().externalId));
      if (!repository) throw new Error("An enabled GitHub repository is no longer accessible");
      const issues = await fetchRepositoryIssues({
        token: installation.token,
        repository,
        fetcher: input.fetcher,
      });
      const observedContextIds = new Set(issues.map((entry) => githubIssueContextItemId(
        input.connectionId,
        repository.id,
        entry.issue.id,
      )));
      for (let offset = 0; offset < issues.length; offset += 350) {
        const batch = database.batch();
        for (const entry of issues.slice(offset, offset + 350)) {
          batch.set(
            database.doc(
              `companies/${input.companyId}/contextItems/${githubIssueContextItemId(
                input.connectionId,
                repository.id,
                entry.issue.id,
              )}`,
            ),
            githubIssueContextItem({
              companyId: input.companyId,
              connectionId: input.connectionId,
              resourceId: resource.id,
              repository,
              issue: entry.issue,
              comments: entry.comments,
              observedAt,
            }),
            { merge: false },
          );
        }
        await batch.commit();
      }
      const existingItems = await database.collection(`companies/${input.companyId}/contextItems`)
        .where("source.connectionId", "==", input.connectionId)
        .where("source.resourceId", "==", resource.id)
        .get();
      const staleItems = existingItems.docs.filter((item) => !observedContextIds.has(item.id));
      for (let offset = 0; offset < staleItems.length; offset += 400) {
        const batch = database.batch();
        for (const item of staleItems.slice(offset, offset + 400)) batch.delete(item.ref);
        await batch.commit();
      }
      issueCount += issues.length;
      await resource.ref.set({
        itemCount: issues.length,
        lastObservedAt: observedAt,
        updatedAt: observedAt,
      }, { merge: true });
    }
    await connectionRef.set({
      status: "active",
      stats: {
        itemCount: issueCount,
        lastSyncAt: observedAt,
        lastObservedAt: observedAt,
        lastError: null,
      },
      updatedAt: observedAt,
    }, { merge: true });
    await connectionRef.collection("capabilities").doc("issues").set({
      status: "active",
      stats: {
        itemCount: issueCount,
        lastSyncAt: observedAt,
        lastObservedAt: observedAt,
        lastError: null,
      },
      updatedAt: observedAt,
    }, { merge: true });
    return { repositories: resources.size, issues: issueCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await connectionRef.set({
      status: "attention",
      stats: { lastError: message.slice(0, 1000) },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

export async function syncAllGitHubConnections(input: {
  configuration: GitHubAppConfiguration;
  fetcher?: FetchLike;
  database?: FirebaseFirestore.Firestore;
}): Promise<Array<{ companyId: string; connectionId: string; ok: boolean; error?: string }>> {
  const database = input.database || db;
  const companies = await database.collection("companies").get();
  const results: Array<{
    companyId: string;
    connectionId: string;
    ok: boolean;
    error?: string;
  }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "github")
      .where("status", "in", ["active", "attention"])
      .get();
    for (const connection of connections.docs) {
      try {
        await syncGitHubConnection({
          companyId: company.id,
          connectionId: connection.id,
          configuration: input.configuration,
          fetcher: input.fetcher,
          database,
        });
        results.push({ companyId: company.id, connectionId: connection.id, ok: true });
      } catch (error) {
        results.push({
          companyId: company.id,
          connectionId: connection.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}
