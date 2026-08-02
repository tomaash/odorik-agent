import { Timestamp } from "firebase-admin/firestore";
import { convert as convertPdfToMarkdown } from "@pdf2md/core";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  audienceEquals,
  companyAudience,
  isAudienceBroadened,
  normalizeResourceAudience,
} from "../access.js";
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
  enabled: boolean;
};

/** Bounded searchable text retained per document. */
const maxDocumentTextLength = 50_000;
const maxPdfBytes = 15 * 1024 * 1024;
const pdfConversionTimeoutMs = 45_000;
type FetchLike = typeof fetch;
export type DriveContentFormat = "markdown" | "plain_text" | "metadata";

export type DriveExtractedContent = {
  text: string;
  format: DriveContentFormat;
  extraction: {
    method: "pdf2md" | "google_export" | "download" | "metadata";
    status: "success" | "partial" | "metadata_only";
    pageCount?: number;
    wordCount?: number;
    warnings?: string[];
  };
};

export class DriveSelectionBroadeningError extends Error {
  readonly code = "DRIVE_SELECTION_BROADENING_REQUIRES_CONFIRMATION";
  constructor() {
    super("Removing this folder selection would broaden access through an ancestor. Confirm the broader audience to continue.");
    this.name = "DriveSelectionBroadeningError";
  }
}

export class DriveContentExtractionError extends Error {
  readonly code = "DRIVE_CONTENT_EXTRACTION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "DriveContentExtractionError";
  }
}

export function folderResourceId(folderId: string): string {
  return `folder_${sha256Hex(folderId).slice(0, 24)}`;
}

export function driveContextItemId(
  connectionId: string,
  fileIdOrFolderId: string,
  legacyFileId?: string,
): string {
  const fileId = legacyFileId || fileIdOrFolderId;
  return `drive_${sha256Hex(`${connectionId}:${fileId}`).slice(0, 32)}`;
}

export function driveFolderFilesQuery(
  folderId: string,
  pageToken?: string,
): URLSearchParams {
  return new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, parents, description, shared, webViewLink, createdTime, modifiedTime, md5Checksum, size)",
    pageSize: "1000",
    ...(pageToken ? { pageToken } : {}),
  });
}

export function importableDriveFiles(
  files: DriveFileEntry[],
): Array<DriveFileEntry & { id: string; name: string }> {
  return files.filter(
    (file): file is DriveFileEntry & { id: string; name: string } =>
      Boolean(file.id && file.name)
      && file.mimeType !== "application/vnd.google-apps.folder",
  );
}

export function driveContextItem(input: {
  companyId: string;
  connectionId: string;
  folderId: string;
  file: DriveFileEntry & { id: string; name: string };
  contentText: string;
  contentFormat?: DriveContentFormat;
  extraction?: DriveExtractedContent["extraction"];
  observedAt: Timestamp;
  audience?: unknown;
  audienceRevision?: number;
  resourceId?: string;
  observation?: {
    runId: string;
    trigger: ConnectorSyncTrigger;
    providerUpdatedAt: string | null;
    providerVersion: string;
    freshnessEligible: boolean;
  };
}): Record<string, unknown> {
  return {
    companyId: input.companyId,
    kind: "document",
    source: {
      providerId: "google",
      capabilityId: driveCapabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId || folderResourceId(input.folderId),
      externalId: input.file.id,
      version: input.file.md5Checksum || input.file.modifiedTime || "v1",
    },
    title: input.file.name,
    text: input.contentText.slice(0, maxDocumentTextLength),
    artifactRefs: input.file.webViewLink ? [input.file.webViewLink] : [],
    participantRefs: [],
    access: normalizeResourceAudience(input.audience),
    accessRevision: Math.max(1, Number(input.audienceRevision || 1)),
    provenance: {
      checksum: sha256Hex(input.contentText),
      ingestionVersion: "google-drive-v2",
      modifiedTime: input.file.modifiedTime || null,
    },
    metadata: {
      folderId: input.folderId,
      mimeType: input.file.mimeType || null,
      size: input.file.size || null,
      sourceUrl: input.file.webViewLink || null,
      contentFormat: input.contentFormat || "plain_text",
      extraction: input.extraction || null,
    },
    observation: input.observation ? {
      ...input.observation,
      observedAt: input.observedAt,
    } : null,
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
  const selectedMap = new Map<string, "enabled" | "disabled">();
  for (const resource of resourceSnapshots.docs) {
    const data = resource.data();
    if (data.resourceType === "folder") {
      selectedMap.set(
        String(data.externalId),
        data.status === "enabled" ? "enabled" : "disabled",
      );
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
      selected: selectedMap.has(folder.id),
      enabled: selectedMap.get(folder.id) === "enabled",
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
  confirmBroadening?: boolean;
  database?: FirebaseFirestore.Firestore;
  fetcher?: FetchLike;
  now?: () => Timestamp;
}): Promise<SelectableFolder[]> {
  const database = input.database || db;
  const { accessToken, connection, capability } = await authorizedDriveConnection(input);
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

  const folderAncestors = (folderId: string): string[] => {
    const ancestors: string[] = [];
    const visited = new Set([folderId]);
    let parentId = folderMap.get(folderId)?.parents?.[0];
    while (parentId && !visited.has(parentId)) {
      ancestors.push(parentId);
      visited.add(parentId);
      parentId = folderMap.get(parentId)?.parents?.[0];
    }
    return ancestors;
  };
  const selectedByDepth = [...selectedSet].sort(
    (left, right) => folderAncestors(left).length - folderAncestors(right).length,
  );
  const plannedAudiences = new Map<string, ReturnType<typeof normalizeResourceAudience>>();
  for (const folderId of selectedByDepth) {
    const existing = existingMap.get(folderId);
    if (existing) {
      plannedAudiences.set(folderId, normalizeResourceAudience(existing.data().audience));
      continue;
    }
    const ownerId = folderAncestors(folderId).find((ancestorId) => plannedAudiences.has(ancestorId));
    plannedAudiences.set(
      folderId,
      ownerId ? plannedAudiences.get(ownerId)! : companyAudience,
    );
  }
  if (!input.confirmBroadening) {
    for (const [folderId, resource] of existingMap.entries()) {
      if (selectedSet.has(folderId)) continue;
      const ownerId = folderAncestors(folderId).find((ancestorId) => selectedSet.has(ancestorId));
      if (
        ownerId
        && isAudienceBroadened(resource.data().audience, plannedAudiences.get(ownerId))
      ) throw new DriveSelectionBroadeningError();
    }
  }

  const now = input.now?.() || Timestamp.now();
  const batch = database.batch();
  batch.set(capability.ref, {
    syncGeneration: Number(capability.data()?.syncGeneration || 0) + 1,
    updatedAt: now,
  }, { merge: true });

  for (const folderId of selectedSet) {
    const folder = folderMap.get(folderId)!;
    const displayName = folder.name || `Folder ${folderId}`;
    const resourceRef = resourceCollection.doc(folderResourceId(folderId));
    const existing = existingMap.get(folderId);
    const ancestorIds = folderAncestors(folderId);
    if (!existing) {
      batch.set(resourceRef, {
        connectionId: input.connectionId,
        capabilityId: driveCapabilityId,
        resourceType: "folder",
        externalId: folderId,
        displayName,
        parentId: folder.parents?.[0] || null,
        ancestorIds,
        selectionDepth: ancestorIds.length,
        status: "enabled",
        audience: plannedAudiences.get(folderId) || companyAudience,
        audienceRevision: 1,
        itemCount: 0,
        syncLeaseGeneration: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      batch.set(existing.ref, {
        displayName,
        parentId: folder.parents?.[0] || null,
        ancestorIds,
        selectionDepth: ancestorIds.length,
        syncLease: null,
        syncLeaseGeneration: Number(existing.data().syncLeaseGeneration || 0) + 1,
        updatedAt: now,
      }, { merge: true });
    }
  }

  // Deselecting removes the ownership boundary. Its files are deleted before
  // the remaining ancestor roots reconcile and re-ingest them with their
  // owning audience.
  const removedResources: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const [folderId, resource] of existingMap.entries()) {
    if (selectedSet.has(folderId)) continue;
    batch.delete(resource.ref);
    removedResources.push(resource);
  }

  await batch.commit();
  for (const resource of removedResources) {
    const items = await contextItems(input.companyId, database)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id)
      .get();
    for (let offset = 0; offset < items.docs.length; offset += 400) {
      const deleteBatch = database.batch();
      for (const item of items.docs.slice(offset, offset + 400)) deleteBatch.delete(item.ref);
      await deleteBatch.commit();
    }
  }
  await syncGoogleDriveConnection({
    ...input,
    trigger: "selection",
    requestedBy: input.actorUid || null,
  });
  return listGoogleDriveFolders(input);
}

async function requireDriveDownloadSuccess(label: string, response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  requireGoogleSuccess(label, response, body);
}

function driveMetadataSummary(file: DriveFileEntry & { id: string; name: string }): string {
  return [
    `File: ${file.name}`,
    `Type: ${file.mimeType || "unknown"}`,
    `Description: ${file.description || "N/A"}`,
  ].join("\n");
}

function conversionWarnings(messages: unknown[]): string[] {
  return messages.slice(0, 20).map((message) => {
    if (typeof message === "string") return message;
    if (message && typeof message === "object" && "message" in message) {
      return String((message as { message?: unknown }).message || "PDF conversion warning");
    }
    return JSON.stringify(message).slice(0, 500);
  });
}

/** Read one file's searchable content with explicit format/provenance. */
export async function driveFileContent(
  file: DriveFileEntry & { id: string; name: string },
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<DriveExtractedContent> {
  const metadataSummary = driveMetadataSummary(file);
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
    await requireDriveDownloadSuccess("Google Drive document export", exported);
    return {
      text: await exported.text(),
      format: "plain_text",
      extraction: { method: "google_export", status: "success" },
    };
  }
  if (isPlainText) {
    const downloaded = await fetcher(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    await requireDriveDownloadSuccess("Google Drive file download", downloaded);
    return {
      text: await downloaded.text(),
      format: file.mimeType === "text/markdown" || file.name.toLowerCase().endsWith(".md")
        ? "markdown"
        : "plain_text",
      extraction: { method: "download", status: "success" },
    };
  }
  if (file.mimeType === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const declaredSize = Number(file.size || 0);
    if (declaredSize > maxPdfBytes) {
      return {
        text: `${metadataSummary}\nContent: Metadata only (PDF exceeds the extraction limit).`,
        format: "metadata",
        extraction: {
          method: "metadata",
          status: "metadata_only",
          warnings: ["policy_limited"],
        },
      };
    }
    const signal = AbortSignal.timeout(pdfConversionTimeoutMs);
    const downloaded = await fetcher(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
      },
    );
    await requireDriveDownloadSuccess("Google Drive PDF download", downloaded);
    const bytes = await downloaded.arrayBuffer();
    if (bytes.byteLength > maxPdfBytes) {
      return {
        text: `${metadataSummary}\nContent: Metadata only (PDF exceeds the extraction limit).`,
        format: "metadata",
        extraction: {
          method: "metadata",
          status: "metadata_only",
          warnings: ["policy_limited"],
        },
      };
    }
    let result: Awaited<ReturnType<typeof convertPdfToMarkdown>>;
    try {
      result = await convertPdfToMarkdown(bytes, {
        includeMetadata: true,
        chunkBy: "heading",
        signal,
      });
    } catch (error) {
      if (
        String((error as { name?: unknown })?.name || "").includes("Timeout")
        || String((error as { name?: unknown })?.name || "").includes("Abort")
      ) throw error;
      throw new DriveContentExtractionError(
        `Google Drive PDF extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const markdown = result.markdown.trim();
    if (result.messages.some((message) => message.code === "no_extractable_text")) {
      return {
        text: `${metadataSummary}\nContent: Metadata only (the PDF has no embedded text).`,
        format: "metadata",
        extraction: {
          method: "metadata",
          status: "metadata_only",
          pageCount: result.stats.pageCount,
          wordCount: result.stats.wordCount,
          warnings: ["no_embedded_text", ...conversionWarnings(result.messages || [])],
        },
      };
    }
    if (result.status === "failed" || !markdown) {
      const warnings = conversionWarnings(result.messages || []);
      if (result.messages.some((message) => ["timeout", "cancelled"].includes(message.code))) {
        throw new Error(`Google Drive PDF extraction timed out (408)${warnings[0] ? `: ${warnings[0]}` : ""}`);
      }
      throw new DriveContentExtractionError(
        `Google Drive PDF extraction failed${warnings[0] ? `: ${warnings[0]}` : ""}`,
      );
    }
    return {
      text: markdown,
      format: "markdown",
      extraction: {
        method: "pdf2md",
        status: result.status === "partial" ? "partial" : "success",
        pageCount: result.stats.pageCount,
        wordCount: result.stats.wordCount,
        warnings: conversionWarnings(result.messages || []),
      },
    };
  }
  return {
    text: metadataSummary,
    format: "metadata",
    extraction: { method: "metadata", status: "metadata_only" },
  };
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
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

function driveContextMatches(
  existing: FirebaseFirestore.DocumentData | undefined,
  next: Record<string, unknown>,
): boolean {
  const existingSource = nestedRecord(existing?.source);
  const nextSource = nestedRecord(next.source);
  const existingProvenance = nestedRecord(existing?.provenance);
  const nextProvenance = nestedRecord(next.provenance);
  return existingSource.version === nextSource.version
    && existingSource.resourceId === nextSource.resourceId
    && existingProvenance.checksum === nextProvenance.checksum
    && existing?.title === next.title
    && existing?.text === next.text
    && audienceEquals(existing?.access, next.access)
    && Number(existing?.accessRevision || 1) === Number(next.accessRevision || 1)
    && existing?.indexingEnabled !== false;
}

async function syncDriveFolderResource(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: import("./sync-runtime.js").ConnectorSyncLease;
  dependencies: ConnectorSyncDependencies;
  fetcher?: FetchLike;
  ownershipBoundaries: Set<string>;
  trigger: ConnectorSyncTrigger;
}): Promise<ConnectorSyncResourceCompletion> {
  let changes = 0;
  const rootFolderId = String(input.resource.data.externalId);
  const now = input.dependencies.now?.() || Timestamp.now();
  const existing = await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .get();
  const existingById = new Map(existing.docs.map((item) => [item.id, item]));
  const observedContextIds = new Set<string>();
  const extractionCounts: Record<DriveContentFormat, number> = {
    markdown: 0,
    plain_text: 0,
    metadata: 0,
  };
  const pendingFolders = [rootFolderId];
  const visitedFolders = new Set<string>();
  for (let folderIndex = 0; folderIndex < pendingFolders.length; folderIndex += 1) {
    const folderId = pendingFolders[folderIndex]!;
    if (visitedFolders.has(folderId)) continue;
    visitedFolders.add(folderId);
    let pageToken: string | undefined;
    do {
      const body = await driveFiles(
        input.accessToken,
        driveFolderFilesQuery(folderId, pageToken),
        input.fetcher,
      );
      for (const child of body.files || []) {
        if (
          child.id
          && child.mimeType === "application/vnd.google-apps.folder"
          && !input.ownershipBoundaries.has(child.id)
        ) pendingFolders.push(child.id);
      }

      const files = importableDriveFiles(body.files || []);
      const writes: Array<{
        ref: FirebaseFirestore.DocumentReference;
        value: Record<string, unknown>;
      }> = [];
      for (const file of files) {
        const itemId = driveContextItemId(input.connectionId, file.id);
        observedContextIds.add(itemId);
        const itemRef = input.dependencies.database.doc(companyDocumentPath(
          input.companyId,
          "contextItems",
          itemId,
        ));
        const prior = existingById.get(itemId)?.data();
        const providerVersion = file.md5Checksum || file.modifiedTime || "v1";
        const priorSource = nestedRecord(prior?.source);
        const priorMetadata = nestedRecord(prior?.metadata);
        const ownershipAndAudienceMatch = priorSource.resourceId === input.resource.id
          && audienceEquals(prior?.access, input.resource.data.audience)
          && Number(prior?.accessRevision || 1)
            === Number(input.resource.data.audienceRevision || 1)
          && prior?.indexingEnabled !== false;
        if (prior && priorSource.version === providerVersion && ownershipAndAudienceMatch) {
          const priorFormat = ["markdown", "plain_text", "metadata"].includes(
            String(priorMetadata.contentFormat),
          ) ? priorMetadata.contentFormat as DriveContentFormat : "plain_text";
          extractionCounts[priorFormat] += 1;
          continue;
        }
        const extracted = prior && priorSource.version === providerVersion
          ? {
            text: String(prior.text || driveMetadataSummary(file)),
            format: (priorMetadata.contentFormat || "plain_text") as DriveContentFormat,
            extraction: (priorMetadata.extraction || {
              method: "metadata",
              status: "metadata_only",
            }) as DriveExtractedContent["extraction"],
          }
          : await driveFileContent(file, input.accessToken, input.fetcher);
        extractionCounts[extracted.format] += 1;
        const value = driveContextItem({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: input.resource.id,
          folderId,
          file,
          contentText: extracted.text,
          contentFormat: extracted.format,
          extraction: extracted.extraction,
          observedAt: now,
          audience: input.resource.data.audience,
          audienceRevision: Number(input.resource.data.audienceRevision || 1),
          observation: {
            runId: input.lease.runId,
            trigger: input.trigger,
            providerUpdatedAt: file.modifiedTime || null,
            providerVersion,
            freshnessEligible: (() => {
              const providerUpdatedAt = timestampMillis(file.modifiedTime);
              const lastSuccessAt = timestampMillis(
                nestedRecord(input.resource.data.sync).lastSuccessAt
                  || input.resource.data.lastSyncAt,
              );
              return priorSource.version !== providerVersion
                && providerUpdatedAt !== null
                && lastSuccessAt !== null
                && providerUpdatedAt >= lastSuccessAt;
            })(),
          },
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
  }

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
    resourcePatch: {
      recursive: true,
      extractionCounts,
      selectionDepth: Number(input.resource.data.selectionDepth || 0),
      ancestorIds: Array.isArray(input.resource.data.ancestorIds)
        ? input.resource.data.ancestorIds.map(String)
        : [],
    },
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
    prepare: async () => {
      const authorization = await authorizedDriveConnection(input);
      const snapshot = await authorization.connection.ref.collection("resources")
        .where("capabilityId", "==", driveCapabilityId)
        .get();
      const needsFolderGraph = snapshot.docs.some(
        (resource) => !Number.isFinite(Number(resource.data().selectionDepth)),
      );
      const folders = needsFolderGraph
        ? await fetchDriveFolders(authorization.accessToken, input.fetcher)
        : [];
      const folderMap = new Map(folders.map((folder) => [String(folder.id), folder]));
      const ancestry = (folderId: string): string[] => {
        const ancestors: string[] = [];
        const visited = new Set([folderId]);
        let parentId = folderMap.get(folderId)?.parents?.[0];
        while (parentId && !visited.has(parentId)) {
          ancestors.push(parentId);
          visited.add(parentId);
          parentId = folderMap.get(parentId)?.parents?.[0];
        }
        return ancestors;
      };
      const driveResources = snapshot.docs.map((resource) => {
        const data = resource.data();
        if (Number.isFinite(Number(data.selectionDepth))) {
          return { id: resource.id, data };
        }
        const ancestorIds = ancestry(String(data.externalId));
        return {
          id: resource.id,
          data: {
            ...data,
            ancestorIds,
            selectionDepth: ancestorIds.length,
          },
        };
      });
      return { ...authorization, driveResources };
    },
    listResources: async ({ driveResources }) => {
      return driveResources
        .filter((resource) => resource.data.status === "enabled")
        .sort((left, right) => (
          Number(left.data.selectionDepth || 0) - Number(right.data.selectionDepth || 0)
          || left.id.localeCompare(right.id)
        ));
    },
    cursorMode: () => "full",
    synchronizeResource: ({
      preparation,
      resource,
      trigger,
      lease,
      dependencies: runDependencies,
    }) => (
      syncDriveFolderResource({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resource,
        accessToken: preparation.accessToken,
        lease,
        dependencies: runDependencies,
        fetcher: input.fetcher,
        trigger,
        ownershipBoundaries: new Set(preparation.driveResources.map(
          (selected) => String(selected.data.externalId),
        )),
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
