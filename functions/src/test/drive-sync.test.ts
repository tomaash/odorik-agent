import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  driveContextItemId,
  driveFileContent,
  folderResourceId,
  replayGoogleDriveSyncRun,
  retryDueGoogleDriveSyncRuns,
  selectGoogleDriveFolders,
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

function singlePagePdf(text: string): Uint8Array {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
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
      selectionDepth: 0,
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

test("Drive recursively traverses roots while selected descendants form audience boundaries", async () => {
  const context = fixture(["root", "child"]);
  const rootResourceId = folderResourceId("root");
  const childResourceId = folderResourceId("child");
  context.memory.patch(`${connectionPath}/resources/${rootResourceId}`, {
    audience: { visibility: "company" },
    audienceRevision: 2,
    selectionDepth: 0,
  });
  context.memory.patch(`${connectionPath}/resources/${childResourceId}`, {
    audience: { visibility: "restricted", memberIds: ["member-a"] },
    audienceRevision: 7,
    selectionDepth: 1,
  });
  const listedFolders: string[] = [];
  const fetcher = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    if (url.pathname === "/drive/v3/files") {
      const query = url.searchParams.get("q") || "";
      const folderId = ["root", "child", "grand"].find((id) => query.includes(`'${id}'`));
      if (!folderId) return jsonResponse({ error: { message: "unexpected folder" } }, 404);
      listedFolders.push(folderId);
      if (folderId === "root") return jsonResponse({ files: [{
        id: "root-file",
        name: "root.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-08-02T09:00:00.000Z",
      }, {
        id: "child",
        name: "Child",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      }] });
      if (folderId === "child") return jsonResponse({ files: [{
        id: "child-file",
        name: "child.md",
        mimeType: "text/markdown",
        modifiedTime: "2026-08-02T09:10:00.000Z",
      }, {
        id: "grand",
        name: "Grandchild",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["child"],
      }] });
      return jsonResponse({ files: [{
        id: "grand-file",
        name: "grand.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-08-02T09:20:00.000Z",
      }] });
    }
    const fileId = ["root-file", "child-file", "grand-file"].find(
      (id) => url.pathname.endsWith(`/${id}`),
    );
    if (fileId && url.searchParams.get("alt") === "media") {
      return new Response(`${fileId} body`, { status: 200 });
    }
    return jsonResponse({ error: { message: "unexpected request" } }, 404);
  }) as typeof fetch;

  const result = await syncGoogleDriveConnection({
    companyId,
    connectionId,
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    database: context.database,
    fetcher,
    now: context.now,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.changes, 3);
  assert.deepEqual(listedFolders, ["root", "child", "grand"]);
  const rootItem = context.memory.read(
    `companies/${companyId}/contextItems/${driveContextItemId(connectionId, "root-file")}`,
  ) || {};
  const childItem = context.memory.read(
    `companies/${companyId}/contextItems/${driveContextItemId(connectionId, "child-file")}`,
  ) || {};
  const grandItem = context.memory.read(
    `companies/${companyId}/contextItems/${driveContextItemId(connectionId, "grand-file")}`,
  ) || {};
  assert.equal((rootItem.source as Record<string, unknown>).resourceId, rootResourceId);
  assert.deepEqual(rootItem.access, { visibility: "company" });
  for (const item of [childItem, grandItem]) {
    assert.equal((item.source as Record<string, unknown>).resourceId, childResourceId);
    assert.deepEqual(item.access, { visibility: "restricted", memberIds: ["member-a"] });
    assert.equal(item.accessRevision, 7);
  }
  assert.equal(context.memory.read(`${connectionPath}/resources/${rootResourceId}`)?.itemCount, 1);
  assert.equal(context.memory.read(`${connectionPath}/resources/${childResourceId}`)?.itemCount, 2);
});

test("Drive requires confirmation before a deselected child inherits broader ancestor access", async () => {
  const context = fixture(["root", "child"]);
  const rootResourceId = folderResourceId("root");
  const childResourceId = folderResourceId("child");
  context.memory.patch(`${connectionPath}/resources/${rootResourceId}`, {
    audience: { visibility: "company" },
    audienceRevision: 2,
    selectionDepth: 0,
  });
  context.memory.patch(`${connectionPath}/resources/${childResourceId}`, {
    audience: { visibility: "restricted", memberIds: ["member-a"] },
    audienceRevision: 5,
    selectionDepth: 1,
  });
  const fetcher = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    if (url.pathname === "/drive/v3/files") {
      const query = url.searchParams.get("q") || "";
      if (query.startsWith("mimeType =")) return jsonResponse({ files: [{
        id: "root",
        name: "Root",
        mimeType: "application/vnd.google-apps.folder",
      }, {
        id: "child",
        name: "Child",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      }] });
      if (query.includes("'root'")) return jsonResponse({ files: [{
        id: "child",
        name: "Child",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      }] });
      if (query.includes("'child'")) return jsonResponse({ files: [] });
    }
    return jsonResponse({ error: { message: "unexpected request" } }, 404);
  }) as typeof fetch;
  const selection = {
    companyId,
    connectionId,
    folderIds: ["root"],
    clientId: "google-client",
    clientSecret: "google-secret",
    credentialKey,
    actorUid: "admin-1",
    database: context.database,
    fetcher,
    now: context.now,
  };
  await assert.rejects(
    selectGoogleDriveFolders(selection),
    (error: unknown) => (
      error instanceof Error
      && (error as { code?: string }).code === "DRIVE_SELECTION_BROADENING_REQUIRES_CONFIRMATION"
    ),
  );
  assert.ok(context.memory.read(`${connectionPath}/resources/${childResourceId}`));
  const selected = await selectGoogleDriveFolders({ ...selection, confirmBroadening: true });
  assert.deepEqual(selected.filter((folder) => folder.selected).map((folder) => folder.id), ["root"]);
  assert.equal(context.memory.read(`${connectionPath}/resources/${childResourceId}`), undefined);
});

test("Drive converts text PDFs to semantic Markdown with pdf2md", async () => {
  const pdf = singlePagePdf("C5 PDF handover context");
  const pdfBody = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  const extracted = await driveFileContent({
    id: "pdf-a",
    name: "handover.pdf",
    mimeType: "application/pdf",
    size: String(pdf.byteLength),
  }, "drive-access-token", (async () => new Response(pdfBody, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  })) as typeof fetch);
  assert.equal(extracted.format, "markdown");
  assert.equal(extracted.extraction.method, "pdf2md");
  assert.equal(extracted.extraction.pageCount, 1);
  assert.match(extracted.text, /C5 PDF handover context/);
  assert.doesNotMatch(extracted.text, /data:image|base64,/i);
});

test("Drive labels policy-limited PDFs as metadata-only without downloading them", async () => {
  let downloads = 0;
  const extracted = await driveFileContent({
    id: "pdf-large",
    name: "archive.pdf",
    mimeType: "application/pdf",
    size: String(15 * 1024 * 1024 + 1),
  }, "drive-access-token", (async () => {
    downloads += 1;
    return new Response("not expected", { status: 200 });
  }) as typeof fetch);
  assert.equal(downloads, 0);
  assert.equal(extracted.format, "metadata");
  assert.equal(extracted.extraction.status, "metadata_only");
  assert.deepEqual(extracted.extraction.warnings, ["policy_limited"]);
  assert.match(extracted.text, /Metadata only/);
});

test("Drive treats malformed in-policy PDFs as actionable extraction failures", async () => {
  await assert.rejects(
    driveFileContent({
      id: "pdf-bad",
      name: "broken.pdf",
      mimeType: "application/pdf",
      size: "14",
    }, "drive-access-token", (async () => new Response("not a real pdf", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch),
    (error: unknown) => (
      error instanceof Error
      && (error as { code?: string }).code === "DRIVE_CONTENT_EXTRACTION_FAILED"
    ),
  );
});
