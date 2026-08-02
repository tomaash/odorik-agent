import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  driveContextItemId,
  folderResourceId,
  replayGoogleDriveSyncRun,
  retryDueGoogleDriveSyncRuns,
  syncGoogleDriveConnection,
} from "../connectors/google-drive.js";
import { encryptCredentials } from "../connectors/credentials.js";
import { driveScopes } from "../connectors/registry.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "explorers";
const connectionId = "google-drive-a";
const connectionPath = `companies/${companyId}/connections/${connectionId}`;
const credentialKey = Buffer.alloc(32, 9).toString("base64");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(folderIds: string[]) {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  let now = Timestamp.fromDate(new Date("2026-08-02T10:00:00.000Z"));
  memory.seed(connectionPath, {
    companyId,
    connectorId: "google_workspace",
    status: "active",
    credentialCiphertext: encryptCredentials({
      accessToken: "drive-access-token",
      refreshToken: "drive-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: driveScopes.join(" "),
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/drive`, {
    capabilityId: "context.document.read",
    serviceId: "drive",
    status: "active",
    grantedScopes: driveScopes,
    stats: {},
  });
  for (const folderId of folderIds) {
    memory.seed(`${connectionPath}/resources/${folderResourceId(folderId)}`, {
      connectionId,
      capabilityId: "context.document.read",
      resourceType: "folder",
      externalId: folderId,
      displayName: folderId,
      status: "enabled",
      itemCount: 0,
    });
  }
  return {
    memory,
    database,
    now: () => now,
    advance(milliseconds: number) {
      now = Timestamp.fromMillis(now.toMillis() + milliseconds);
    },
  };
}

test("Drive isolates a transient folder failure and retries only that resource", async () => {
  const context = fixture(["folder-a", "folder-b"]);
  const folderAResourceId = folderResourceId("folder-a");
  const folderBResourceId = folderResourceId("folder-b");
  context.memory.seed(`companies/${companyId}/contextItems/stale-drive-item`, {
    source: { connectionId, resourceId: folderAResourceId },
    title: "Removed file",
  });
  let folderBUnavailable = true;
  const requests: string[] = [];
  const fetcher = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("folder-a")) {
      return jsonResponse({
        files: [{
          id: "file-a",
          name: "alpha.txt",
          mimeType: "text/plain",
          modifiedTime: "2026-08-02T09:00:00.000Z",
          webViewLink: "https://drive.google.com/file-a",
        }],
      });
    }
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("folder-b")) {
      if (folderBUnavailable) return jsonResponse({ error: { message: "temporary" } }, 503);
      return jsonResponse({
        files: [{
          id: "file-b",
          name: "bravo.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-08-02T09:30:00.000Z",
        }],
      });
    }
    if (url.pathname.endsWith("/file-a") && url.searchParams.get("alt") === "media") {
      return new Response("Alpha body", { status: 200 });
    }
    if (url.pathname.endsWith("/file-b") && url.searchParams.get("alt") === "media") {
      return new Response("Bravo body", { status: 200 });
    }
    return jsonResponse({ error: { message: `Unexpected ${url.pathname}` } }, 404);
  }) as typeof fetch;

  const first = await syncGoogleDriveConnection({
    companyId,
    connectionId,
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    trigger: "manual",
    requestedBy: "admin-1",
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(first.status, "retry_scheduled");
  assert.deepEqual(
    context.memory.read(`${connectionPath}/syncRuns/${first.runId}`)?.failedResourceIds,
    [folderBResourceId],
  );
  assert.ok(context.memory.read(
    `companies/${companyId}/contextItems/${driveContextItemId(connectionId, "folder-a", "file-a")}`,
  ));
  assert.equal(context.memory.read("companies/explorers/contextItems/stale-drive-item"), undefined);
  assert.equal(
    (context.memory.read(`${connectionPath}/resources/${folderAResourceId}`)?.sync as Record<string, unknown>)?.health,
    "fresh",
  );
  assert.equal(
    (context.memory.read(`${connectionPath}/resources/${folderBResourceId}`)?.sync as Record<string, unknown>)?.health,
    "retrying",
  );

  folderBUnavailable = false;
  context.advance(60_001);
  const recovered = await retryDueGoogleDriveSyncRuns({
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "succeeded");
  assert.ok(context.memory.read(
    `companies/${companyId}/contextItems/${driveContextItemId(connectionId, "folder-b", "file-b")}`,
  ));
  const attempts = context.memory.list(`${connectionPath}/syncRuns/${first.runId}/resourceAttempts`);
  assert.equal(attempts.filter((attempt) => attempt.resourceId === folderAResourceId).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.resourceId === folderBResourceId).length, 2);

  const idempotent = await syncGoogleDriveConnection({
    companyId,
    connectionId,
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(idempotent.status, "succeeded");
  assert.equal(idempotent.changes, 0);
  assert.ok(requests.some((request) => request.includes("folder-a")));
});

test("Drive permanent extraction failure becomes replayable attention", async () => {
  const context = fixture(["folder-docs"]);
  let exportFails = true;
  const fetcher = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    if (url.pathname === "/drive/v3/files") {
      return jsonResponse({
        files: [{
          id: "doc-a",
          name: "Runbook",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-08-02T09:00:00.000Z",
        }],
      });
    }
    if (url.pathname.endsWith("/doc-a/export")) {
      return exportFails
        ? jsonResponse({ error: { message: "forbidden" } }, 403)
        : new Response("Recovered runbook", { status: 200 });
    }
    return jsonResponse({ error: { message: "unexpected" } }, 404);
  }) as typeof fetch;

  const failed = await syncGoogleDriveConnection({
    companyId,
    connectionId,
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(failed.status, "attention");
  assert.equal(context.memory.read(`${connectionPath}/capabilities/drive`)?.status, "attention");

  exportFails = false;
  const replayed = await replayGoogleDriveSyncRun({
    companyId,
    connectionId,
    runId: failed.runId,
    actorUid: "admin-1",
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(replayed.status, "succeeded");
  assert.equal(
    context.memory.read(`${connectionPath}/syncRuns/${replayed.runId}`)?.replayOfRunId,
    failed.runId,
  );
});
