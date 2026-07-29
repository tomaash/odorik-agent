import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedGoogleConnection,
  completeGoogleAuthorization,
  connectionRef,
  createGoogleAuthorization,
  requireGoogleSuccess,
  revokeGoogleAuthorization,
  type GoogleConnector,
} from "./google-oauth.js";
import {
  markConnectionAttention,
  markConnectionSynced,
  writeResourceSyncState,
} from "./sync-state.js";

export const driveScopes = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

const driveConnector: GoogleConnector = {
  adapterId: "google_drive",
  displayName: "Google Drive",
  scopes: driveScopes,
};

type DriveFileEntry = {
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

function folderResourceId(folderId: string): string {
  return `folder_${sha256Hex(folderId).slice(0, 24)}`;
}

function driveContextItemId(
  connectionId: string,
  folderId: string,
  fileId: string,
): string {
  return `drive_${sha256Hex(`${connectionId}:${folderId}:${fileId}`).slice(0, 32)}`;
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
    driveConnector.displayName,
    response,
    await response.json() as DriveFileListResponse,
  );
}

export async function createDriveAuthorization(input: {
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  returnOrigin?: string;
}): Promise<{ authorizationUrl: string }> {
  return createGoogleAuthorization(driveConnector, input);
}

export async function revokeGoogleDriveAuthorization(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
}): Promise<boolean> {
  return revokeGoogleAuthorization(driveConnector, input);
}

export async function exchangeGoogleDriveAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ connectionId: string }> {
  return completeGoogleAuthorization(driveConnector, {
    ...input,
    resolveAccountLabel: async (accessToken) => {
      const response = await fetch(
        "https://www.googleapis.com/drive/v3/about?fields=user",
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) return null;
      const body = await response.json() as {
        user?: { emailAddress?: string; displayName?: string };
      };
      return body.user?.emailAddress || null;
    },
  });
}

async function authorizedDriveConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}) {
  return authorizedGoogleConnection(driveConnector, input);
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
  const resourceSnapshots = await connection.ref.collection("resources").get();
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

  const resourceCollection = connection.ref.collection("resources");
  const existingResources = await resourceCollection.get();
  const existingMap = new Map(
    existingResources.docs
      .filter((resource) => resource.data().resourceType === "folder")
      .map((resource) => [String(resource.data().externalId), resource]),
  );

  const now = Timestamp.now();
  const batch = db.batch();
  const foldersToSync: string[] = [];

  for (const folderId of selectedSet) {
    const folder = folderMap.get(folderId);
    const displayName = folder?.name || `Folder ${folderId}`;
    const resourceRef = resourceCollection.doc(folderResourceId(folderId));
    const existing = existingMap.get(folderId);
    if (!existing) {
      batch.set(resourceRef, {
        connectionId: input.connectionId,
        resourceType: "folder",
        externalId: folderId,
        displayName,
        status: "enabled",
        itemCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      foldersToSync.push(folderId);
    } else if (existing.data().status !== "enabled") {
      batch.update(existing.ref, { status: "enabled", updatedAt: now });
      foldersToSync.push(folderId);
    }
  }

  // Deselecting a folder removes its resource and every context item it
  // produced, so the Qdrant deletion trigger drops the derived chunks too.
  for (const [folderId, resource] of existingMap.entries()) {
    if (selectedSet.has(folderId)) continue;
    batch.delete(resource.ref);
    const items = await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", folderId)
      .get();
    for (const item of items.docs) batch.delete(item.ref);
  }

  await batch.commit();

  for (const folderId of foldersToSync) {
    await syncDriveFolder({
      companyId: input.companyId,
      connectionId: input.connectionId,
      folderId,
      accessToken,
    });
  }

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
    const body = await driveFiles(input.accessToken, new URLSearchParams({
      q: `'${input.folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, description, webViewLink, createdTime, modifiedTime, md5Checksum, size)",
      pageSize: "50",
      ...(pageToken ? { pageToken } : {}),
    }));

    const files = (body.files || []).filter(
      (file): file is DriveFileEntry & { id: string; name: string } =>
        Boolean(file.id && file.name)
        // Subfolders are browsable as their own resource, not as items.
        && file.mimeType !== "application/vnd.google-apps.folder",
    );

    for (const file of files) {
      const contentText = await driveFileText(file, input.accessToken);
      const itemRef = db.doc(companyDocumentPath(
        input.companyId,
        "contextItems",
        driveContextItemId(input.connectionId, input.folderId, file.id),
      ));
      await itemRef.set({
        companyId: input.companyId,
        kind: "document",
        source: {
          adapterId: "google_drive",
          connectionId: input.connectionId,
          resourceId: input.folderId,
          externalId: file.id,
          version: file.md5Checksum || file.modifiedTime || "v1",
        },
        title: file.name,
        text: contentText.slice(0, maxDocumentTextLength),
        artifactRefs: file.webViewLink ? [file.webViewLink] : [],
        participantRefs: [],
        access: { visibility: "company" },
        provenance: {
          checksum: sha256Hex(contentText),
          ingestionVersion: "google-drive-v1",
          modifiedTime: file.modifiedTime || null,
        },
        observedAt: now.toDate().toISOString(),
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
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
  const { accessToken, connection } = await authorizedDriveConnection(input);
  const resources = await connection.ref.collection("resources")
    .where("resourceType", "==", "folder")
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
    const updated = await markConnectionSynced({
      connection: connection.ref,
      itemCount: totalSynced,
    });
    if (!updated) {
      throw new Error("Google Drive connection was disconnected during synchronization");
    }
    return { totalSynced };
  } catch (error) {
    await markConnectionAttention({ connection: connection.ref, error });
    throw error;
  }
}
