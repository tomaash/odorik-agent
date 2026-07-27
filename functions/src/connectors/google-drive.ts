import { createHash, randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { revokeGoogleToken } from "./google-calendar.js";
import {
  defaultGoogleRedirectUri,
  googleOAuthRedirectUri,
  googleOAuthReturnUrl,
} from "./google-oauth-return.js";

export const driveScopes = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const driveAuthorizationLifetimeMs = 60 * 60 * 1000;

type GoogleTokens = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
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

type DriveCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

export type SelectableFolder = {
  id: string;
  parentId: string | null;
  displayName: string;
  description: string | null;
  shared: boolean;
  selected: boolean;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function connectionRef(companyId: string, connectionId: string) {
  return db.doc(`companies/${companyId}/connections/${connectionId}`);
}

function folderResourceId(folderId: string): string {
  return `folder_${hash(folderId).slice(0, 24)}`;
}

function driveContextItemId(
  connectionId: string,
  folderId: string,
  fileId: string,
): string {
  return `drive_${hash(`${connectionId}:${folderId}:${fileId}`).slice(0, 32)}`;
}

function requireGoogleSuccess<T>(response: Response, body: T & { error?: unknown }): T {
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : JSON.stringify(body.error || body);
    throw new Error(`Google Drive API failed (${response.status}): ${message.slice(0, 1000)}`);
  }
  return body;
}

export async function createDriveAuthorization(input: {
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  returnOrigin?: string;
}): Promise<{ authorizationUrl: string }> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = hash(state);
  const now = Timestamp.now();
  const redirectUri = googleOAuthRedirectUri(input.returnOrigin);
  await db.doc(`oauthStates/${stateHash}`).set({
    companyId: input.companyId,
    provider: "google_drive",
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    redirectUri,
    returnUrl: googleOAuthReturnUrl(input.returnOrigin),
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + driveAuthorizationLifetimeMs),
  });
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: driveScopes.join(" "),
    state,
  });
  return {
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
  };
}

export async function revokeGoogleDriveAuthorization(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
}): Promise<boolean> {
  const connection = await connectionRef(input.companyId, input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== "google_drive"
    || typeof data.credentialCiphertext !== "string"
  ) return false;
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as DriveCredential;
  const token = credentials.refreshToken || credentials.accessToken;
  return token ? revokeGoogleToken(token) : false;
}

export async function exchangeGoogleDriveAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ connectionId: string }> {
  const stateRef = db.doc(`oauthStates/${hash(input.state)}`);
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp
    ? stateData.expiresAt.toMillis()
    : 0;
  if (
    !stateSnapshot.exists
    || stateData?.provider !== "google_drive"
    || typeof stateData?.companyId !== "string"
    || expiresAt < Date.now()
  ) {
    throw new Error("The Google Drive authorization request is invalid or expired");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: String(stateData.redirectUri || defaultGoogleRedirectUri),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = requireGoogleSuccess(
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token || !tokenBody.refresh_token) {
    throw new Error("Google did not return the required offline refresh token");
  }

  // Fetch user info / about to label provider account
  const aboutResponse = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const aboutData = aboutResponse.ok
    ? (await aboutResponse.json() as { user?: { emailAddress?: string; displayName?: string } })
    : null;
  const providerAccountId = String(
    aboutData?.user?.emailAddress
    || stateData.email
    || "unknown Google Drive account",
  );

  const companyId = String(stateData.companyId);
  const connections = db.collection(`companies/${companyId}/connections`);
  const existingConnections = await connections
    .where("adapterId", "==", "google_drive")
    .get();
  const existingConnection = existingConnections.docs.find(
    (doc) => doc.data().providerAccountId === providerAccountId,
  );
  const connection = existingConnection?.ref || connections.doc();
  const now = Timestamp.now();
  const credentials: DriveCredential = {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || driveScopes.join(" "),
  };
  const batch = db.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    companyId,
    adapterId: "google_drive",
    displayName: "Google Drive",
    accountLabel: providerAccountId,
    providerAccountId,
    status: "active",
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: driveScopes,
    },
    credentialCiphertext: encryptCredentials(credentials, input.credentialKey),
    stats: { itemCount: 0, lastError: null },
    createdBy: existingConnection?.data().createdBy || stateData.uid,
    authorizedBy: {
      email: stateData.email || null,
      displayName: stateData.displayName || null,
    },
    ...(!existingConnection ? { createdAt: now } : { reauthorizedAt: now }),
    updatedAt: now,
  }, { merge: true });
  await batch.commit();
  return { connectionId: connection.id };
}

async function refreshDriveToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = requireGoogleSuccess(
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token) {
    throw new Error("Google Drive token refresh did not return an access token");
  }
  return {
    accessToken: tokenBody.access_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
  };
}

async function authorizedDriveConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ accessToken: string; connection: FirebaseFirestore.DocumentSnapshot }> {
  const connection = await connectionRef(input.companyId, input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== "google_drive"
    || !["active", "attention"].includes(String(data?.status))
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new Error("Active Google Drive connection not found");
  }
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as DriveCredential;
  const isExpired = Date.parse(credentials.expiresAt) <= Date.now() + 60_000;
  if (!isExpired && credentials.accessToken) {
    return { accessToken: credentials.accessToken, connection };
  }
  const refreshed = await refreshDriveToken({
    refreshToken: credentials.refreshToken,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const updatedCredentials: DriveCredential = {
    ...credentials,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
  };
  await connection.ref.update({
    credentialCiphertext: encryptCredentials(updatedCredentials, input.credentialKey),
    updatedAt: Timestamp.now(),
  });
  return { accessToken: refreshed.accessToken, connection };
}

export async function fetchDriveFolders(accessToken: string): Promise<DriveFileEntry[]> {
  const folders: DriveFileEntry[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "nextPageToken, files(id, name, parents, description, shared, createdTime, modifiedTime)",
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = requireGoogleSuccess(
      response,
      await response.json() as DriveFileListResponse,
    );
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
  for (const doc of resourceSnapshots.docs) {
    const data = doc.data();
    if (data.resourceType === "folder") {
      selectedMap.set(String(data.externalId), data.status === "enabled");
    }
  }

  const visibleFolderIds = new Set(
    folders.flatMap((folder) => folder.id ? [folder.id] : []),
  );

  return folders
    .filter((f): f is DriveFileEntry & { id: string; name: string } => Boolean(f.id && f.name))
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
  const folderMap = new Map(folders.map((f) => [f.id, f]));
  const selectedSet = new Set(input.folderIds);

  const resourceCollection = connection.ref.collection("resources");
  const existingResources = await resourceCollection.get();
  const existingMap = new Map(
    existingResources.docs
      .filter((d) => d.data().resourceType === "folder")
      .map((d) => [String(d.data().externalId), d]),
  );

  const now = Timestamp.now();
  const batch = db.batch();
  const foldersToSync: string[] = [];

  for (const folderId of selectedSet) {
    const folder = folderMap.get(folderId);
    const displayName = folder?.name || `Folder ${folderId}`;
    const resId = folderResourceId(folderId);
    const resRef = resourceCollection.doc(resId);
    const existing = existingMap.get(folderId);
    if (!existing) {
      batch.set(resRef, {
        connectionId: input.connectionId,
        resourceType: "folder",
        externalId: folderId,
        displayName,
        status: "enabled",
        stats: { itemCount: 0 },
        createdAt: now,
        updatedAt: now,
      });
      foldersToSync.push(folderId);
    } else if (existing.data().status !== "enabled") {
      batch.update(existing.ref, { status: "enabled", updatedAt: now });
      foldersToSync.push(folderId);
    }
  }

  // Deselect / Remove unselected folders
  for (const [folderId, doc] of existingMap.entries()) {
    if (!selectedSet.has(folderId)) {
      batch.delete(doc.ref);
      // Remove all normalized context items for this folder
      const contextItems = await db.collection(`companies/${input.companyId}/contextItems`)
        .where("source.connectionId", "==", input.connectionId)
        .where("source.resourceId", "==", folderId)
        .get();
      for (const itemDoc of contextItems.docs) {
        batch.delete(itemDoc.ref);
      }
    }
  }

  await batch.commit();

  // Sync newly selected folders
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
    const query = new URLSearchParams({
      q: `'${input.folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, description, webViewLink, createdTime, modifiedTime, md5Checksum, size)",
      pageSize: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = requireGoogleSuccess(
      response,
      await response.json() as DriveFileListResponse,
    );

    const files = (body.files || []).filter((f): f is DriveFileEntry & { id: string; name: string } => Boolean(f.id && f.name));

    for (const file of files) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        // Skip subfolder objects in item listing (they are browsable separately)
        continue;
      }

      let contentText = "";
      try {
        if (file.mimeType === "application/vnd.google-apps.document") {
          // Export Google Doc as plain text
          const exportResponse = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
            {
              headers: { authorization: `Bearer ${input.accessToken}` },
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (exportResponse.ok) {
            contentText = await exportResponse.text();
          }
        } else if (
          file.mimeType?.startsWith("text/")
          || file.name.endsWith(".md")
          || file.name.endsWith(".txt")
          || file.name.endsWith(".json")
          || file.name.endsWith(".csv")
        ) {
          const downloadResponse = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            {
              headers: { authorization: `Bearer ${input.accessToken}` },
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (downloadResponse.ok) {
            contentText = await downloadResponse.text();
          }
        } else {
          // Unsupported or binary file — summarize file metadata
          contentText = `File: ${file.name}\nType: ${file.mimeType || "unknown"}\nDescription: ${file.description || "N/A"}`;
        }
      } catch (err) {
        console.warn(`Failed to read content for Drive file ${file.id}:`, err);
        contentText = `File: ${file.name}\nDescription: ${file.description || ""}`;
      }

      const itemId = driveContextItemId(input.connectionId, input.folderId, file.id);
      const itemRef = db.doc(`companies/${input.companyId}/contextItems/${itemId}`);

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
        text: contentText.slice(0, 50_000), // Bounded searchable text limit
        artifactRefs: file.webViewLink ? [file.webViewLink] : [],
        participantRefs: [],
        access: { visibility: "company" },
        provenance: {
          checksum: hash(contentText),
          ingestionVersion: "v1",
          modifiedTime: file.modifiedTime || null,
        },
        observedAt: now.toDate().toISOString(),
        createdAt: now,
        updatedAt: now,
      }, { merge: true });

      syncedCount++;
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  // Update resource item count and timestamp
  const resourceRef = connectionRef(
    input.companyId,
    input.connectionId,
  ).collection("resources").doc(resourceId);
  await resourceRef.set({
    stats: { itemCount: syncedCount },
    lastObservedAt: now.toDate().toISOString(),
    updatedAt: now,
  }, { merge: true });

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
  for (const doc of resources.docs) {
    const externalId = String(doc.data().externalId);
    const result = await syncDriveFolder({
      companyId: input.companyId,
      connectionId: input.connectionId,
      folderId: externalId,
      accessToken,
    });
    totalSynced += result.syncedCount;
  }

  const now = Timestamp.now();
  await connection.ref.update({
    "stats.itemCount": totalSynced,
    "stats.lastError": null,
    lastSyncAt: now.toDate().toISOString(),
    lastObservedAt: now.toDate().toISOString(),
    updatedAt: now,
  });

  return { totalSynced };
}
