import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedGoogleCapability,
  connectionRef,
  requireGoogleSuccess,
} from "./google-oauth.js";
import { driveScopes } from "./registry.js";
import {
  markCapabilityAttention,
  markCapabilitySynced,
  writeResourceSyncState,
} from "./sync-state.js";

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

function contextItems(companyId: string) {
  return db.collection(companyCollectionPath(companyId, "contextItems"));
}

async function driveFiles(
  accessToken: string,
  query: URLSearchParams,
): Promise<DriveFileListResponse> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?${query.toString()}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  return requireGoogleSuccess(
    driveDisplayName,
    response,
    await response.json() as DriveFileListResponse,
  );
}

async function authorizedDriveConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}) {
  return authorizedGoogleCapability(driveCapabilityId, input);
}

export async function fetchDriveFolders(accessToken: string): Promise<DriveFileEntry[]> {
  const folders: DriveFileEntry[] = [];
  let pageToken: string | undefined;
  do {
    const body = await driveFiles(accessToken, new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "nextPageToken, files(id, name, parents, description, shared, createdTime, modifiedTime)",
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    }));
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
}): Promise<SelectableFolder[]> {
  const { accessToken, connection } = await authorizedDriveConnection(input);
  const folders = await fetchDriveFolders(accessToken);
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
}): Promise<SelectableFolder[]> {
  const { accessToken, connection } = await authorizedDriveConnection(input);
  const folders = await fetchDriveFolders(accessToken);
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

  const now = Timestamp.now();
  const batch = db.batch();

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
    const items = await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id)
      .get();
    for (const item of items.docs) batch.delete(item.ref);
  }

  await batch.commit();
  await syncGoogleDriveConnection(input);
  return listGoogleDriveFolders(input);
}

/** Read one file's searchable text, falling back to a metadata summary. */
async function driveFileText(
  file: DriveFileEntry & { id: string; name: string },
  accessToken: string,
): Promise<string> {
  const metadataSummary = [
    `File: ${file.name}`,
    `Type: ${file.mimeType || "unknown"}`,
    `Description: ${file.description || "N/A"}`,
  ].join("\n");
  const isPlainText = file.mimeType?.startsWith("text/")
    || [".md", ".txt", ".json", ".csv"].some((suffix) => file.name.endsWith(suffix));
  try {
    if (file.mimeType === "application/vnd.google-apps.document") {
      const exported = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      return exported.ok ? await exported.text() : metadataSummary;
    }
    if (isPlainText) {
      const downloaded = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      return downloaded.ok ? await downloaded.text() : metadataSummary;
    }
    return metadataSummary;
  } catch (error) {
    console.warn(`Failed to read content for Drive file ${file.id}:`, error);
    return `File: ${file.name}\nDescription: ${file.description || ""}`;
  }
}

export async function syncDriveFolder(input: {
  companyId: string;
  connectionId: string;
  folderId: string;
  accessToken: string;
}): Promise<{ syncedCount: number }> {
  let pageToken: string | undefined;
  let syncedCount = 0;
  const resourceId = folderResourceId(input.folderId);
  const now = Timestamp.now();

  do {
    const body = await driveFiles(
      input.accessToken,
      driveFolderFilesQuery(input.folderId, pageToken),
    );

    const files = importableDriveFiles(body.files || []);

    for (const file of files) {
      const contentText = await driveFileText(file, input.accessToken);
      const itemRef = db.doc(companyDocumentPath(
        input.companyId,
        "contextItems",
        driveContextItemId(input.connectionId, input.folderId, file.id),
      ));
      await itemRef.set(driveContextItem({
        companyId: input.companyId,
        connectionId: input.connectionId,
        folderId: input.folderId,
        file,
        contentText,
        observedAt: now,
      }), { merge: true });
      syncedCount += 1;
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  await writeResourceSyncState({
    resource: connectionRef(input.companyId, input.connectionId)
      .collection("resources").doc(resourceId),
    itemCount: syncedCount,
  });

  return { syncedCount };
}

export async function syncGoogleDriveConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ totalSynced: number }> {
  const { accessToken, connection, capability } = await authorizedDriveConnection(input);
  const resources = await connection.ref.collection("resources")
    .where("capabilityId", "==", driveCapabilityId)
    .where("status", "==", "enabled")
    .get();

  let totalSynced = 0;
  try {
    for (const resource of resources.docs) {
      const result = await syncDriveFolder({
        companyId: input.companyId,
        connectionId: input.connectionId,
        folderId: String(resource.data().externalId),
        accessToken,
      });
      totalSynced += result.syncedCount;
    }
    const updated = await markCapabilitySynced({
      connection: connection.ref,
      capability: capability.ref,
      itemCount: totalSynced,
    });
    if (!updated) {
      throw new Error("Google Drive connection was disconnected during synchronization");
    }
    return { totalSynced };
  } catch (error) {
    await markCapabilityAttention({
      connection: connection.ref,
      capability: capability.ref,
      error,
    });
    throw error;
  }
}
