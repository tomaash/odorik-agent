import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedGoogleCapability,
  requireGoogleSuccess,
} from "./google-oauth.js";
import { driveScopes } from "./registry.js";
import {
  commitConnectorSyncWrites,
  connectorSyncRunResultFromData,
  createConnectorSyncRun,
  executeConnectorSyncRun,
  listDueConnectorSyncRuns,
  replayableConnectorSyncResources,
  type ConnectorSyncDependencies,
  type ConnectorSyncExecutionResource,
  type ConnectorSyncResourceCompletion,
  type ConnectorSyncRunResult,
  type ConnectorSyncTrigger,
} from "./sync-runtime.js";

export { driveScopes };
const driveCapabilityId = "context.document.read" as const;
const driveDisplayName = "Google Drive";

export type DriveFileEntry = {
  id?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  parents?: string[];
  shared?: boolean;
  webViewLink?: string;
  webContentLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
};

type DriveFileListResponse = {
  files?: DriveFileEntry[];
  nextPageToken?: string;
};

export type SelectableFolder = {
  id: string;
  parentId: string | null;
  displayName: string;
  description: string | null;
  shared: boolean;
  selected: boolean;
};

/** Bounded searchable text retained per document. */
const maxDocumentTextLength = 50_000;
type FetchLike = typeof fetch;

export function folderResourceId(folderId: string): string {
  return `folder_${sha256Hex(folderId).slice(0, 24)}`;
}

export function driveContextItemId(
  connectionId: string,
  folderId: string,
  fileId: string,
): string {
  return `drive_${sha256Hex(`${connectionId}:${folderId}:${fileId}`).slice(0, 32)}`;
}

export function driveFolderFilesQuery(
  folderId: string,
  pageToken?: string,
): URLSearchParams {
  return new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, description, webViewLink, createdTime, modifiedTime, md5Checksum, size)",
    pageSize: "50",
    ...(pageToken ? { pageToken } : {}),
  });
}

export function importableDriveFiles(
  files: DriveFileEntry[],
): Array<DriveFileEntry & { id: string; name: string }> {
  return files.filter(
    (file): file is DriveFileEntry & { id: string; name: string } =>
      Boolean(file.id && file.name)
      // The current contract imports direct files only. Subfolders are
      // independently selectable resources rather than implicit recursion.
      && file.mimeType !== "application/vnd.google-apps.folder",
  );
}

export function driveContextItem(input: {
  companyId: string;
  connectionId: string;
  folderId: string;
  file: DriveFileEntry & { id: string; name: string };
  contentText: string;
  observedAt: Timestamp;
}): Record<string, unknown> {
  return {
    companyId: input.companyId,
    kind: "document",
    source: {
      providerId: "google",
      capabilityId: driveCapabilityId,
      connectionId: input.connectionId,
      resourceId: folderResourceId(input.folderId),
      externalId: input.file.id,
      version: input.file.md5Checksum || input.file.modifiedTime || "v1",
    },
    title: input.file.name,
    text: input.contentText.slice(0, maxDocumentTextLength),
    artifactRefs: input.file.webViewLink ? [input.file.webViewLink] : [],
    participantRefs: [],
    access: { visibility: "company" },
    provenance: {
      checksum: sha256Hex(input.contentText),
      ingestionVersion: "google-drive-v1",
      modifiedTime: input.file.modifiedTime || null,
    },
    observedAt: input.observedAt.toDate().toISOString(),
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  };
}

function contextItems(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.collection(companyCollectionPath(companyId, "contextItems"));
}

async function driveFiles(
  accessToken: string,
  query: URLSearchParams,
  fetcher: FetchLike = fetch,
): Promise<DriveFileListResponse> {
  const response = await fetcher(
    `https://www.googleapis.com/drive/v3/files?${query.toString()}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => ({})) as DriveFileListResponse;
  return requireGoogleSuccess(
    driveDisplayName,
    response,
    body,
  );
}

async function authorizedDriveConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}) {
  return authorizedGoogleCapability(driveCapabilityId, input);
}

export async function fetchDriveFolders(
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<DriveFileEntry[]> {
  const folders: DriveFileEntry[] = [];
  let pageToken: string | undefined;
  do {
    const body = await driveFiles(accessToken, new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "nextPageToken, files(id, name, parents, description, shared, createdTime, modifiedTime)",
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    }), fetcher);
    folders.push(...(body.files || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return folders;
}

export async function listGoogleDriveFolders(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
}): Promise<SelectableFolder[]> {
  const { accessToken, connection } = await authorizedDriveConnection(input);
  const folders = await fetchDriveFolders(accessToken, input.fetcher);
  const resourceSnapshots = await connection.ref.collection("resources")
    .where("capabilityId", "==", driveCapabilityId)
    .get();
  const selectedMap = new Map<string, boolean>();
  for (const resource of resourceSnapshots.docs) {
    const data = resource.data();
    if (data.resourceType === "folder") {
      selectedMap.set(String(data.externalId), data.status === "enabled");
    }
  }

  const visibleFolderIds = new Set(
    folders.flatMap((folder) => folder.id ? [folder.id] : []),
  );

  return folders
    .filter((folder): folder is DriveFileEntry & { id: string; name: string } =>
      Boolean(folder.id && folder.name))
    .map((folder) => ({
      id: folder.id,
      parentId: folder.parents?.find((parentId) => visibleFolderIds.has(parentId)) || null,
      displayName: folder.name,
      description: folder.description || null,
      shared: Boolean(folder.shared),
      selected: selectedMap.get(folder.id) === true,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function selectGoogleDriveFolders(input: {
  companyId: string;
  connectionId: string;
  folderIds: string[];
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  actorUid?: string;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: () => Timestamp;
}): Promise<SelectableFolder[]> {
  const database = input.database || db;
  const { accessToken, connection } = await authorizedDriveConnection(input);
  const folders = await fetchDriveFolders(accessToken, input.fetcher);
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const selectedSet = new Set(input.folderIds);
  if ([...selectedSet].some((folderId) => !folderMap.has(folderId))) {
    throw new Error("One or more selected folders are no longer accessible");
  }

  const resourceCollection = connection.ref.collection("resources");
  const existingResources = await resourceCollection
    .where("capabilityId", "==", driveCapabilityId)
    .get();
  const existingMap = new Map(
    existingResources.docs
      .filter((resource) => resource.data().resourceType === "folder")
      .map((resource) => [String(resource.data().externalId), resource]),
  );

  const now = input.now?.() || Timestamp.now();
  const batch = database.batch();

  for (const folderId of selectedSet) {
    const folder = folderMap.get(folderId)!;
    const displayName = folder.name || `Folder ${folderId}`;
    const resourceRef = resourceCollection.doc(folderResourceId(folderId));
    const existing = existingMap.get(folderId);
    if (!existing) {
      batch.set(resourceRef, {
        connectionId: input.connectionId,
        capabilityId: driveCapabilityId,
        resourceType: "folder",
        externalId: folderId,
        displayName,
        status: "enabled",
        itemCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else if (existing.data().status !== "enabled") {
      batch.update(existing.ref, { status: "enabled", updatedAt: now });
    }
  }

  // Deselecting a folder removes its resource and every context item it
  // produced, so the Qdrant deletion trigger drops the derived chunks too.
  for (const [folderId, resource] of existingMap.entries()) {
    if (selectedSet.has(folderId)) continue;
    batch.delete(resource.ref);
    const items = await contextItems(input.companyId, database)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id)
      .get();
    for (const item of items.docs) batch.delete(item.ref);
  }

  await batch.commit();
  await syncGoogleDriveConnection({
    ...input,
    trigger: "selection",
    requestedBy: input.actorUid || null,
  });
  return listGoogleDriveFolders(input);
}

/** Read one file's searchable text, falling back to a metadata summary. */
async function driveFileText(
  file: DriveFileEntry & { id: string; name: string },
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const metadataSummary = [
    `File: ${file.name}`,
    `Type: ${file.mimeType || "unknown"}`,
    `Description: ${file.description || "N/A"}`,
  ].join("\n");
  const isPlainText = file.mimeType?.startsWith("text/")
    || [".md", ".txt", ".json", ".csv"].some((suffix) => file.name.endsWith(suffix));
  if (file.mimeType === "application/vnd.google-apps.document") {
    const exported = await fetcher(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!exported.ok) {
      throw new Error(`Google Drive document export failed (${exported.status})`);
    }
    return exported.text();
  }
  if (isPlainText) {
    const downloaded = await fetcher(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!downloaded.ok) {
      throw new Error(`Google Drive file download failed (${downloaded.status})`);
    }
    return downloaded.text();
  }
  return metadataSummary;
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

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function driveContextMatches(
  existing: FirebaseFirestore.DocumentData | undefined,
  next: Record<string, unknown>,
): boolean {
  const existingSource = nestedRecord(existing?.source);
  const nextSource = nestedRecord(next.source);
  const existingProvenance = nestedRecord(existing?.provenance);
  const nextProvenance = nestedRecord(next.provenance);
  return existingSource.version === nextSource.version
    && existingProvenance.checksum === nextProvenance.checksum
    && existing?.title === next.title;
}

async function syncDriveFolderResource(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: import("./sync-runtime.js").ConnectorSyncLease;
  dependencies: ConnectorSyncDependencies;
  fetcher?: FetchLike;
}): Promise<ConnectorSyncResourceCompletion> {
  let pageToken: string | undefined;
  let changes = 0;
  const folderId = String(input.resource.data.externalId);
  const now = input.dependencies.now?.() || Timestamp.now();
  const existing = await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .get();
  const existingById = new Map(existing.docs.map((item) => [item.id, item]));
  const observedContextIds = new Set<string>();
  const lastChangeMillis = timestampMillis(
    nestedRecord(input.resource.data.sync).lastChangeObservedAt,
  );

  do {
    const body = await driveFiles(
      input.accessToken,
      driveFolderFilesQuery(folderId, pageToken),
      input.fetcher,
    );

    const files = importableDriveFiles(body.files || []);
    const writes: Array<{
      ref: FirebaseFirestore.DocumentReference;
      value: Record<string, unknown>;
    }> = [];
    for (const file of files) {
      const itemId = driveContextItemId(input.connectionId, folderId, file.id);
      observedContextIds.add(itemId);
      const itemRef = input.dependencies.database.doc(companyDocumentPath(
        input.companyId,
        "contextItems",
        itemId,
      ));
      const prior = existingById.get(itemId)?.data();
      const providerVersion = file.md5Checksum || file.modifiedTime || "v1";
      const priorVersion = nestedRecord(prior?.source).version;
      if (prior && priorVersion === providerVersion) {
        const modifiedMillis = timestampMillis(file.modifiedTime);
        if (
          modifiedMillis !== null
          && (lastChangeMillis === null || modifiedMillis > lastChangeMillis)
        ) changes += 1;
        continue;
      }
      const contentText = await driveFileText(file, input.accessToken, input.fetcher);
      const value = driveContextItem({
        companyId: input.companyId,
        connectionId: input.connectionId,
        folderId,
        file,
        contentText,
        observedAt: now,
      });
      if (!driveContextMatches(prior, value)) {
        writes.push({ ref: itemRef, value });
        changes += 1;
      }
    }
    for (let offset = 0; offset < writes.length; offset += 350) {
      const pageWrites = writes.slice(offset, offset + 350);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => {
          for (const write of pageWrites) {
            transaction.set(write.ref, write.value, { merge: false });
          }
        },
      }, input.dependencies);
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  const staleItems = existing.docs.filter((item) => !observedContextIds.has(item.id));
  for (let offset = 0; offset < staleItems.length; offset += 400) {
    const pageDeletes = staleItems.slice(offset, offset + 400);
    await commitConnectorSyncWrites({
      companyId: input.companyId,
      connectionId: input.connectionId,
      resourceId: input.resource.id,
      lease: input.lease,
      apply: (transaction) => {
        for (const item of pageDeletes) transaction.delete(item.ref);
      },
    }, input.dependencies);
  }
  changes += staleItems.length;

  return {
    changes,
    itemCount: observedContextIds.size,
    cursorAfter: null,
    cursorMode: "full",
  };
}

type DriveSyncInput = {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  trigger?: ConnectorSyncTrigger;
  requestedBy?: string | null;
  resourceIds?: string[];
  replayOfRunId?: string | null;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: () => Timestamp;
};

export type DriveSyncResult = ConnectorSyncRunResult & {
  folders: number;
  totalSynced: number;
};

function driveRunResult(
  runId: string,
  data: FirebaseFirestore.DocumentData,
): DriveSyncResult {
  const result = connectorSyncRunResultFromData(runId, data);
  return { ...result, folders: result.resources, totalSynced: result.changes };
}

async function executeGoogleDriveSyncRun(
  input: DriveSyncInput & { runId: string },
): Promise<DriveSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const completed = await executeConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: driveCapabilityId,
    serviceId: "drive",
    prepare: () => authorizedDriveConnection(input),
    listResources: async ({ connection }) => {
      const snapshot = await connection.ref.collection("resources")
        .where("capabilityId", "==", driveCapabilityId)
        .where("status", "==", "enabled")
        .get();
      return snapshot.docs.map((resource) => ({ id: resource.id, data: resource.data() }));
    },
    cursorMode: () => "full",
    synchronizeResource: ({ preparation, resource, lease, dependencies: runDependencies }) => (
      syncDriveFolderResource({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resource,
        accessToken: preparation.accessToken,
        lease,
        dependencies: runDependencies,
        fetcher: input.fetcher,
      })
    ),
  }, dependencies);
  return { ...completed, folders: completed.resources, totalSynced: completed.changes };
}

export async function syncGoogleDriveConnection(
  input: DriveSyncInput,
): Promise<DriveSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const connection = database.doc(companyDocumentPath(
    input.companyId,
    "connections",
    input.connectionId,
  ));
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", driveCapabilityId)
    .where("status", "==", "enabled")
    .get();
  const selectedResourceIds = input.resourceIds?.filter(
    (resourceId) => resources.docs.some((resource) => resource.id === resourceId),
  ) || resources.docs.map((resource) => resource.id);
  const created = await createConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId: driveCapabilityId,
    serviceId: "drive",
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy,
    resourceIds: selectedResourceIds,
    replayOfRunId: input.replayOfRunId,
  }, dependencies);
  if (!created.created || created.deferred) {
    const current = await connection.collection("syncRuns").doc(created.runId).get();
    return driveRunResult(created.runId, current.data() || {});
  }
  return executeGoogleDriveSyncRun({ ...input, runId: created.runId });
}

export async function replayGoogleDriveSyncRun(input: DriveSyncInput & {
  runId: string;
  actorUid: string;
}): Promise<DriveSyncResult> {
  const database = input.database || db;
  const failedResourceIds = await replayableConnectorSyncResources({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: driveCapabilityId,
    serviceId: "drive",
  }, { database, now: input.now });
  return syncGoogleDriveConnection({
    ...input,
    trigger: "operator_replay",
    requestedBy: input.actorUid,
    replayOfRunId: input.runId,
    resourceIds: failedResourceIds,
  });
}

export async function retryDueGoogleDriveSyncRuns(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  limit?: number;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: () => Timestamp;
}): Promise<Array<DriveSyncResult & { companyId: string; connectionId: string }>> {
  const database = input.database || db;
  const dependencies = { database, now: input.now };
  const due = await listDueConnectorSyncRuns({ serviceId: "drive", limit: input.limit }, dependencies);
  const results: Array<DriveSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of due) {
    const result = await executeGoogleDriveSyncRun({
      companyId: run.companyId,
      connectionId: run.connectionId,
      runId: run.runId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      credentialKey: input.credentialKey,
      trigger: "retry",
      database,
      fetcher: input.fetcher,
      now: input.now,
    });
    results.push({ companyId: run.companyId, connectionId: run.connectionId, ...result });
  }
  return results;
}

export async function syncAllGoogleDriveConnections(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: () => Timestamp;
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
      .where("connectorId", "==", "google_workspace")
      .where("status", "in", ["active", "attention"])
      .get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc("drive").get();
      if (!capability.exists || capability.data()?.status !== "active") continue;
      try {
        const run = await syncGoogleDriveConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
          trigger: "scheduled",
          requestedBy: "scheduler:drive",
          database,
        });
        results.push({
          companyId: company.id,
          connectionId: connection.id,
          ok: run.status !== "attention",
          ...(run.status === "attention" ? { error: "Drive synchronization needs attention" } : {}),
        });
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
