import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import {
  connectGitHubInstallation,
  fetchGitHubIssueWithComments,
  githubInstallationRoutingPath,
  githubIssueContextItem,
  githubIssueContextItemId,
  githubIssueCapabilityId,
  githubRepositoryResourceId,
  type FetchLike,
  type GitHubAppConfiguration,
  type GitHubIssue,
  type GitHubRepository,
} from "./github.js";

export const githubWebhookEvents = [
  "issues",
  "issue_comment",
  "installation_repositories",
] as const;

type GitHubWebhookEvent = typeof githubWebhookEvents[number];
type HeaderValue = string | undefined;

export type QueuedGitHubWebhookPayload = {
  action: string;
  installation: { id: number };
  repository?: GitHubRepository;
  issue?: GitHubIssue;
};

export class GitHubWebhookRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export class GitHubWebhookDeferredError extends Error {}

const maxWebhookBodyBytes = 750_000;
const deliveryRetentionMs = 7 * 24 * 60 * 60 * 1000;
const deliveryPattern = /^[A-Za-z0-9-]{1,100}$/;

function signatureDigest(body: Buffer, secret: string): Buffer {
  return Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "ascii");
}

export function githubWebhookSignature(body: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyGitHubWebhookSignature(input: {
  body: Buffer;
  signature: HeaderValue;
  secret: string;
}): boolean {
  if (!input.secret || !input.signature?.startsWith("sha256=")) return false;
  const suppliedHex = input.signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = signatureDigest(input.body, input.secret);
  const supplied = Buffer.from(suppliedHex.toLowerCase(), "ascii");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GitHubWebhookRequestError(`Invalid GitHub webhook ${label}`, 400);
  }
  return parsed;
}

function stringValue(value: unknown, label: string, maxLength = 10_000): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new GitHubWebhookRequestError(`Invalid GitHub webhook ${label}`, 400);
  }
  return value;
}

function nullableString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new GitHubWebhookRequestError("Invalid GitHub webhook text", 400);
  }
  return value;
}

function normalizeRepository(value: unknown): GitHubRepository {
  const repository = value as Record<string, unknown> | null;
  if (!repository || typeof repository !== "object") {
    throw new GitHubWebhookRequestError("GitHub webhook repository is required", 400);
  }
  const owner = repository.owner as Record<string, unknown> | null;
  return {
    id: positiveInteger(repository.id, "repository id"),
    name: stringValue(repository.name, "repository name", 200),
    full_name: stringValue(repository.full_name, "repository full name", 500),
    private: repository.private === true,
    default_branch: typeof repository.default_branch === "string"
      ? repository.default_branch.slice(0, 500)
      : "main",
    html_url: stringValue(repository.html_url, "repository URL", 2_000),
    owner: { login: stringValue(owner?.login, "repository owner", 200) },
  };
}

function normalizeIssue(value: unknown): GitHubIssue {
  const issue = value as Record<string, unknown> | null;
  if (!issue || typeof issue !== "object") {
    throw new GitHubWebhookRequestError("GitHub webhook issue is required", 400);
  }
  const user = issue.user as Record<string, unknown> | null;
  const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const normalizedLabels: Array<string | { name: string }> = [];
  for (const label of labels.slice(0, 100)) {
    if (typeof label === "string") normalizedLabels.push(label.slice(0, 500));
    else {
      const name = (label as Record<string, unknown> | null)?.name;
      if (typeof name === "string") normalizedLabels.push({ name: name.slice(0, 500) });
    }
  }
  const state = issue.state === "closed" ? "closed" : "open";
  return {
    id: positiveInteger(issue.id, "issue id"),
    number: positiveInteger(issue.number, "issue number"),
    title: stringValue(issue.title, "issue title", 10_000),
    body: nullableString(issue.body, 500_000),
    state,
    state_reason: nullableString(issue.state_reason, 100),
    html_url: stringValue(issue.html_url, "issue URL", 2_000),
    created_at: stringValue(issue.created_at, "issue created_at", 100),
    updated_at: stringValue(issue.updated_at, "issue updated_at", 100),
    closed_at: nullableString(issue.closed_at, 100),
    comments: Math.max(0, Math.min(1_000, Number(issue.comments) || 0)),
    user: user && typeof user.login === "string" ? { login: user.login.slice(0, 200) } : null,
    assignees: assignees.flatMap((assignee) => {
      const login = (assignee as Record<string, unknown> | null)?.login;
      return typeof login === "string" ? [{ login: login.slice(0, 200) }] : [];
    }).slice(0, 100),
    labels: normalizedLabels,
    ...(issue.pull_request ? { pull_request: {} } : {}),
  };
}

function queuedPayload(event: GitHubWebhookEvent, value: unknown): QueuedGitHubWebhookPayload {
  const payload = value as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") {
    throw new GitHubWebhookRequestError("GitHub webhook body must be an object", 400);
  }
  const installation = payload.installation as Record<string, unknown> | null;
  const normalized: QueuedGitHubWebhookPayload = {
    action: typeof payload.action === "string" ? payload.action.slice(0, 100) : "unknown",
    installation: { id: positiveInteger(installation?.id, "installation id") },
  };
  if (event === "issues" || event === "issue_comment") {
    normalized.repository = normalizeRepository(payload.repository);
    normalized.issue = normalizeIssue(payload.issue);
  }
  return normalized;
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === "6" || code === "already-exists";
}

export async function queueGitHubWebhookDelivery(input: {
  body: Buffer;
  signature: HeaderValue;
  event: HeaderValue;
  deliveryId: HeaderValue;
  secret: string;
  database?: FirebaseFirestore.Firestore;
  now?: Timestamp;
}): Promise<{
  status: "queued" | "duplicate" | "ignored" | "pong";
  deliveryId?: string;
  event?: string;
}> {
  if (input.body.length > maxWebhookBodyBytes) {
    throw new GitHubWebhookRequestError("GitHub webhook body is too large", 413);
  }
  if (!verifyGitHubWebhookSignature({
    body: input.body,
    signature: input.signature,
    secret: input.secret,
  })) {
    throw new GitHubWebhookRequestError("Invalid GitHub webhook signature", 401);
  }
  if (!input.deliveryId || !deliveryPattern.test(input.deliveryId)) {
    throw new GitHubWebhookRequestError("Invalid GitHub delivery id", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body.toString("utf8"));
  } catch {
    throw new GitHubWebhookRequestError("Invalid GitHub webhook JSON", 400);
  }
  if (input.event === "ping") return { status: "pong", event: "ping" };
  if (!(githubWebhookEvents as readonly string[]).includes(input.event || "")) {
    return { status: "ignored", event: input.event || "unknown" };
  }
  const event = input.event as GitHubWebhookEvent;
  const payload = queuedPayload(event, parsed);
  const database = input.database || db;
  const routing = await database.doc(
    githubInstallationRoutingPath(payload.installation.id),
  ).get();
  if (!routing.exists) {
    throw new GitHubWebhookRequestError("GitHub installation is not connected", 404);
  }
  const companyId = String(routing.data()?.companyId || "");
  const connectionId = String(routing.data()?.connectionId || "");
  if (!companyId || !connectionId) {
    throw new GitHubWebhookRequestError("GitHub installation routing is incomplete", 409);
  }
  const now = input.now || Timestamp.now();
  const deliveryRef = database.doc(
    `githubWebhookDeliveries/${sha256Hex(input.deliveryId)}`,
  );
  try {
    await deliveryRef.create({
      deliveryId: input.deliveryId,
      event,
      action: payload.action,
      installationId: payload.installation.id,
      companyId,
      connectionId,
      payload,
      status: "pending",
      attempts: 0,
      queuedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + deliveryRetentionMs),
    });
  } catch (error) {
    if (isAlreadyExists(error)) {
      return { status: "duplicate", deliveryId: input.deliveryId, event };
    }
    throw error;
  }
  return { status: "queued", deliveryId: input.deliveryId, event };
}

async function assertDeliveryRoute(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  installationId: number;
  configuration: GitHubAppConfiguration;
}) {
  const [routing, connection] = await Promise.all([
    input.database.doc(githubInstallationRoutingPath(input.installationId)).get(),
    input.database.doc(
      `companies/${input.companyId}/connections/${input.connectionId}`,
    ).get(),
  ]);
  if (
    !routing.exists
    || routing.data()?.companyId !== input.companyId
    || routing.data()?.connectionId !== input.connectionId
    || Number(routing.data()?.appId) !== input.configuration.appId
    || !connection.exists
    || connection.data()?.connectorId !== "github"
    || Number(connection.data()?.installationId) !== input.installationId
  ) {
    throw new Error("GitHub webhook tenant routing check failed");
  }
  return connection.ref;
}

async function recordWebhookOutcome(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  deliveryId: string;
  event: string;
  action: string;
  outcome: string;
  observedAt: Timestamp;
}): Promise<void> {
  const connectionRef = input.database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}`,
  );
  const batch = input.database.batch();
  batch.set(connectionRef, {
    webhook: {
      status: "active",
      lastDeliveryAt: input.observedAt,
      lastEvent: input.event,
      lastAction: input.action,
      lastDeliveryId: input.deliveryId,
      lastOutcome: input.outcome,
      lastError: null,
    },
    updatedAt: input.observedAt,
  }, { merge: true });
  batch.set(connectionRef.collection("capabilities").doc("issues"), {
    stats: { lastObservedAt: input.observedAt, lastError: null },
    updatedAt: input.observedAt,
  }, { merge: true });
  batch.set(
    input.database.doc(
      `companies/${input.companyId}/auditEvents/github_webhook_${sha256Hex(input.deliveryId)}`,
    ),
    {
      eventType: "source.github_webhook_processed",
      actorUid: "github-webhook",
      connectionId: input.connectionId,
      connectorId: "github",
      deliveryId: input.deliveryId,
      githubEvent: input.event,
      action: input.action,
      outcome: input.outcome,
      occurredAt: input.observedAt,
      createdAt: input.observedAt,
    },
    { merge: false },
  );
  await batch.commit();
}

async function updateResourceItemCount(input: {
  database: FirebaseFirestore.Firestore;
  companyId: string;
  connectionId: string;
  resourceRef: FirebaseFirestore.DocumentReference;
  observedAt: Timestamp;
}): Promise<void> {
  const items = await input.database.collection(`companies/${input.companyId}/contextItems`)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resourceRef.id)
    .get();
  await input.resourceRef.set({
    itemCount: items.size,
    lastObservedAt: input.observedAt,
    updatedAt: input.observedAt,
  }, { merge: true });
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function commitWebhookContextMutation(input: {
  database: FirebaseFirestore.Firestore;
  connectionRef: FirebaseFirestore.DocumentReference;
  resourceRef: FirebaseFirestore.DocumentReference;
  contextRef: FirebaseFirestore.DocumentReference;
  observedAt: Timestamp;
  value?: Record<string, unknown>;
}): Promise<boolean> {
  return input.database.runTransaction(async (transaction) => {
    const [connection, resource] = await Promise.all([
      transaction.get(input.connectionRef),
      transaction.get(input.resourceRef),
    ]);
    if (
      !connection.exists
      || !["active", "attention"].includes(String(connection.data()?.status))
      || !resource.exists
      || resource.data()?.capabilityId !== githubIssueCapabilityId
      || resource.data()?.status !== "enabled"
    ) return false;
    const leaseExpiresAt = timestampMillis(resource.data()?.syncLease?.expiresAt);
    if (leaseExpiresAt !== null && leaseExpiresAt > input.observedAt.toMillis()) {
      throw new GitHubWebhookDeferredError(
        "GitHub webhook deferred while repository reconciliation is active",
      );
    }
    if (input.value) transaction.set(input.contextRef, input.value, { merge: false });
    else transaction.delete(input.contextRef);
    return true;
  });
}

export async function processGitHubWebhookDelivery(input: {
  deliveryId: string;
  event: GitHubWebhookEvent;
  action: string;
  companyId: string;
  connectionId: string;
  installationId: number;
  payload: QueuedGitHubWebhookPayload;
  configuration: GitHubAppConfiguration;
  fetcher?: FetchLike;
  database?: FirebaseFirestore.Firestore;
  observedAt?: Timestamp;
}): Promise<{ outcome: string; issueContextItemId?: string }> {
  const database = input.database || db;
  const observedAt = input.observedAt || Timestamp.now();
  await assertDeliveryRoute({ ...input, database });

  let outcome: string;
  let observedIssueContextItemId: string | undefined;
  if (input.event === "installation_repositories") {
    await connectGitHubInstallation({
      companyId: input.companyId,
      actorUid: "github-webhook",
      installationId: input.installationId,
      configuration: input.configuration,
      fetcher: input.fetcher,
      database,
    });
    outcome = "installation_refreshed";
  } else {
    const repository = input.payload.repository;
    const payloadIssue = input.payload.issue;
    if (!repository || !payloadIssue) throw new Error("GitHub issue webhook payload is incomplete");
    const connectionRef = database.doc(
      `companies/${input.companyId}/connections/${input.connectionId}`,
    );
    const resourceRef = connectionRef.collection("resources")
      .doc(githubRepositoryResourceId(repository.id));
    const resource = await resourceRef.get();
    if (
      !resource.exists
      || resource.data()?.capabilityId !== githubIssueCapabilityId
      || String(resource.data()?.externalId) !== String(repository.id)
      || resource.data()?.status !== "enabled"
    ) {
      outcome = "ignored_unselected_repository";
    } else if (payloadIssue.pull_request) {
      outcome = "ignored_pull_request";
    } else {
      const contextItemId = githubIssueContextItemId(
          input.connectionId,
          repository.id,
          payloadIssue.id,
        );
      const contextRef = database.doc(
        `companies/${input.companyId}/contextItems/${contextItemId}`,
      );
      if (input.event === "issues" && input.action === "deleted") {
        const committed = await commitWebhookContextMutation({
          database,
          connectionRef,
          resourceRef,
          contextRef,
          observedAt,
        });
        outcome = committed ? "issue_deleted" : "ignored_inactive_repository";
      } else {
        const canonical = await fetchGitHubIssueWithComments({
          configuration: input.configuration,
          installationId: input.installationId,
          repository,
          issueNumber: payloadIssue.number,
          fetcher: input.fetcher,
        });
        if (canonical.issue.pull_request) {
          outcome = "ignored_pull_request";
        } else {
          const committed = await commitWebhookContextMutation({
            database,
            connectionRef,
            resourceRef,
            contextRef,
            observedAt,
            value: githubIssueContextItem({
              companyId: input.companyId,
              connectionId: input.connectionId,
              resourceId: resource.id,
              repository,
              issue: canonical.issue,
              comments: canonical.comments,
              observedAt,
            }),
          });
          outcome = committed ? "issue_upserted" : "ignored_inactive_repository";
          if (committed) observedIssueContextItemId = contextItemId;
        }
      }
      if (!outcome.startsWith("ignored_inactive_")) {
        await updateResourceItemCount({
          database,
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceRef,
          observedAt,
        });
      }
    }
  }
  await recordWebhookOutcome({
    database,
    companyId: input.companyId,
    connectionId: input.connectionId,
    deliveryId: input.deliveryId,
    event: input.event,
    action: input.action,
    outcome,
    observedAt,
  });
  return {
    outcome,
    ...(observedIssueContextItemId ? { issueContextItemId: observedIssueContextItemId } : {}),
  };
}

export async function recordGitHubWebhookFailure(input: {
  companyId: string;
  connectionId: string;
  deliveryId: string;
  event: string;
  action: string;
  error: unknown;
  database?: FirebaseFirestore.Firestore;
}): Promise<void> {
  const database = input.database || db;
  const message = (input.error instanceof Error ? input.error.message : String(input.error))
    .slice(0, 1_000);
  await database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}`,
  ).set({
    webhook: {
      status: "attention",
      lastDeliveryAt: FieldValue.serverTimestamp(),
      lastEvent: input.event,
      lastAction: input.action,
      lastDeliveryId: input.deliveryId,
      lastOutcome: "failed",
      lastError: message,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}
