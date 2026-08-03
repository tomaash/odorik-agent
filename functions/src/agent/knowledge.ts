import type { Firestore } from "firebase-admin/firestore";
import { jsonSafe } from "../firestore.js";
import {
  knowledgeKinds,
  type KnowledgeDocument,
  type KnowledgeKind,
  type RecordFilter,
} from "./types.js";
import { accessForSourceRecord, canMemberAccess } from "../access.js";

export const collectionByKnowledgeKind: Record<KnowledgeKind, string> = {
  call: "calls",
  contact: "contacts",
  task: "workItems",
  case: "cases",
  audit_event: "auditEvents",
  context_item: "contextItems",
  coding_run: "codingRuns",
};

const knowledgeKindByCollection = Object.fromEntries(
  Object.entries(collectionByKnowledgeKind).map(([kind, collection]) => [collection, kind]),
) as Record<string, KnowledgeKind>;

const safeFields: Record<KnowledgeKind, string[]> = {
  call: [
    "status", "from", "to", "duration", "odorikTime", "lineName", "language",
    "summary", "transcript", "segments", "actionItems", "uploadedAt", "processedAt",
    "connectionId", "resourceId", "source", "access", "accessRevision", "indexingEnabled",
  ],
  contact: [
    "displayName", "phoneE164", "phoneRaw", "email", "origin", "createdFromCallId",
    "lastCallAt", "createdAt", "updatedAt", "access", "indexingEnabled",
  ],
  task: [
    "status", "title", "instructions", "assigneeUid", "assigneeName", "dueAt",
    "contactId", "caseId", "callId", "source", "authorization", "outcomeNote",
    "createdBy", "createdAt", "updatedAt", "closedAt", "access", "accessRevision",
    "indexingEnabled",
  ],
  case: [
    "title", "pipelineId", "stageId", "contactId",
    "contactName", "contactPhone", "ownerUid", "ownerName", "createdAt",
    "updatedAt", "stageChangedAt", "revision", "source", "authorization", "access",
    "accessRevision", "indexingEnabled",
  ],
  audit_event: [
    "aggregateType", "aggregateId", "type", "eventType", "actor", "before", "after",
    "createdAt", "access", "accessRevision", "indexingEnabled",
  ],
  context_item: [
    "companyId", "kind", "source", "title", "text", "occurredAt", "observedAt",
    "artifactRefs", "participantRefs", "access", "metadata", "provenance",
    "indexingEnabled", "createdAt", "updatedAt",
  ],
  coding_run: [
    "status", "phase", "github", "issueSnapshot", "result", "publicationResult",
    "publication", "git", "authorization", "error", "access", "accessRevision",
    "indexingEnabled", "createdAt", "updatedAt", "completedAt", "initiatedBy",
  ],
};

const filterFields: Record<KnowledgeKind, string[]> = {
  call: ["status", "language", "from", "to", "contactId"],
  contact: ["displayName", "phoneE164", "phoneRaw", "email", "origin"],
  task: ["status", "assigneeUid", "contactId", "caseId", "callId"],
  case: ["stageId", "contactId", "ownerUid"],
  audit_event: ["aggregateType", "aggregateId", "type", "eventType"],
  context_item: [
    "kind",
    "source.providerId",
    "source.capabilityId",
    "source.adapterId",
    "source.connectionId",
    "source.resourceId",
  ],
  coding_run: ["status", "phase"],
};

/** Metadata keys that are connector plumbing, not company knowledge. */
const plumbingMetadataKeys = new Set([
  "size",
  "md5Checksum",
  "folderId",
  "parentId",
  "driveId",
  "fileId",
  "providerFileId",
  "ingestionVersion",
  "checksum",
  "resourceId",
  "connectionId",
  "externalId",
  "version",
]);

export type CompanyRecord = {
  kind: KnowledgeKind;
  recordId: string;
  sourcePath: string;
  title: string;
  occurredAt: string | null;
  data: Record<string, unknown>;
};

export interface CompanyDataRepository {
  allDocuments(kinds?: KnowledgeKind[]): Promise<KnowledgeDocument[]>;
  getRecord(kind: KnowledgeKind, recordId: string): Promise<CompanyRecord | null>;
  listRecords(kind: KnowledgeKind, filters?: RecordFilter[], limit?: number): Promise<CompanyRecord[]>;
  aggregateRecords(input: {
    kind: KnowledgeKind;
    filters?: RecordFilter[];
    groupBy?: string;
  }): Promise<{ total: number; groups?: Record<string, number> }>;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function selectSafeFields(kind: KnowledgeKind, value: Record<string, unknown>): Record<string, unknown> {
  const safe = jsonSafe(value) as Record<string, unknown>;
  return Object.fromEntries(
    safeFields[kind]
      .filter((field) => safe[field] !== undefined)
      .map((field) => [field, safe[field]]),
  );
}

export function knowledgeKindForCollection(collection: string): KnowledgeKind | null {
  return knowledgeKindByCollection[collection] || null;
}

function titleFor(kind: KnowledgeKind, id: string, data: Record<string, unknown>): string {
  if (kind === "call") return `Call ${String(data.from || "unknown")} → ${String(data.to || "unknown")}`;
  if (kind === "contact") return String(data.displayName || data.phoneE164 || data.phoneRaw || `Contact ${id}`);
  if (kind === "task") return `${String(data.title || "Task")} · ${String(data.status || "unknown")}`;
  if (kind === "case") return `${String(data.title || `Case ${id}`)} · ${String(data.stageId || "unknown stage")}`;
  if (kind === "context_item") return String(data.title || `Context item ${id}`);
  if (kind === "coding_run") {
    const issue = plainObject(data.issueSnapshot);
    const github = plainObject(data.github);
    const issueTitle = String(issue.title || "").trim();
    const number = github.issueNumber != null ? `#${github.issueNumber}` : "";
    const repo = github.owner && github.repo
      ? `${github.owner}/${github.repo}`
      : "";
    const label = issueTitle
      || [repo, number].filter(Boolean).join(" ")
      || `Coding run ${id}`;
    return `${label} · ${String(data.status || "unknown")}`;
  }
  const eventName = data.type || data.eventType || "Audit event";
  return `${String(eventName)} · ${String(data.aggregateId || id)}`;
}

function occurredAtFor(data: Record<string, unknown>): string | null {
  for (const field of [
    "occurredAt", "completedAt", "createdAt", "processedAt", "uploadedAt", "updatedAt", "odorikTime",
  ]) {
    const value = data[field];
    if (typeof value === "string") return value;
  }
  return null;
}

const excludedSystemFields = new Set([
  "companyId",
  "source",
  "provenance",
  "access",
  "accessRevision",
  "observedAt",
  "createdAt",
  "updatedAt",
  "indexingEnabled",
  "checksum",
  "version",
  "ingestionVersion",
  "externalId",
  "connectionId",
  "resourceId",
  "title",
  "authorization",
  "initiatedBy",
  "schemaVersion",
  "expiresAt",
  "artifacts",
  "cloudRun",
  "dispatch",
  "grok",
]);

/**
 * True when Drive (or similar) stored only connector metadata, not document body.
 * These should not be treated as high-value knowledge evidence.
 */
export function isMetadataOnlyContextText(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return true;
  if (/Content:\s*Metadata only/i.test(normalized)) return true;
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const metadataLine = /^(Type|Size|Modified|Created|Link|Name|Folder|MIME|File ID|Folder ID|Checksum|MD5)\s*:/i;
  const urlOnly = /^https?:\/\//i;
  return lines.every((line) => metadataLine.test(line) || urlOnly.test(line));
}

function codingRunSearchText(title: string, data: Record<string, unknown>): string {
  const github = plainObject(data.github);
  const issue = plainObject(data.issueSnapshot);
  const result = plainObject(data.result);
  const publication = plainObject(data.publicationResult);
  const publicationPlan = plainObject(data.publication);
  const git = plainObject(data.git);
  const error = plainObject(data.error);
  const changedPaths = Array.isArray(result.changedPaths)
    ? result.changedPaths.map(String).filter(Boolean)
    : [];
  const lines = [
    title,
    "",
    `Status: ${String(data.status || "unknown")}`,
    data.phase ? `Phase: ${String(data.phase)}` : undefined,
    github.owner && github.repo
      ? `Repository: ${github.owner}/${github.repo}`
      : undefined,
    github.issueNumber != null ? `Issue: #${github.issueNumber}` : undefined,
    typeof github.issueUrl === "string" ? `Issue URL: ${github.issueUrl}` : undefined,
    typeof issue.title === "string" && issue.title ? `Issue title: ${issue.title}` : undefined,
    result.changedFiles != null ? `Changed files: ${String(result.changedFiles)}` : undefined,
    changedPaths.length
      ? `Changed paths:\n${changedPaths.slice(0, 40).map((path) => `- ${path}`).join("\n")}`
      : undefined,
    typeof publication.pullRequestUrl === "string"
      ? `Pull request: #${String(publication.pullRequestNumber || "")} ${publication.pullRequestUrl}`.trim()
      : typeof publicationPlan.prTitle === "string"
        ? `Planned pull request: ${publicationPlan.prTitle}`
        : undefined,
    typeof git.proposedBranch === "string" ? `Branch: ${git.proposedBranch}` : undefined,
    typeof git.resultSha === "string" ? `Result commit: ${git.resultSha}` : undefined,
    typeof error.message === "string" ? `Error: ${error.message}` : undefined,
  ].filter((line): line is string => Boolean(line));

  const issueBody = typeof issue.text === "string" ? issue.text.trim() : "";
  if (issueBody) {
    lines.push("", "Issue context:", issueBody.slice(0, 6_000));
  }
  return lines.join("\n");
}

function auditEventSearchText(title: string, data: Record<string, unknown>): string {
  const lines = [
    title,
    data.aggregateType ? `Aggregate: ${String(data.aggregateType)}` : undefined,
    data.aggregateId ? `Aggregate ID: ${String(data.aggregateId)}` : undefined,
    data.type ? `Type: ${String(data.type)}` : undefined,
    data.eventType ? `Event: ${String(data.eventType)}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (data.before !== undefined) lines.push(`Before: ${JSON.stringify(data.before)}`);
  if (data.after !== undefined) lines.push(`After: ${JSON.stringify(data.after)}`);
  return lines.join("\n");
}

function contextItemSearchText(title: string, data: Record<string, unknown>): string {
  const rawText = typeof data.text === "string" ? data.text.trim() : "";
  if (rawText && isMetadataOnlyContextText(rawText)) {
    return [
      title,
      "",
      "Document content was not extracted. Only file presence metadata is available.",
      "Do not treat connector IDs, MIME types, sizes, or ingestion versions as business facts.",
    ].join("\n");
  }
  if (rawText) {
    return `${title}\n\n${rawText}`;
  }
  const meta = plainObject(data.metadata);
  const usefulMeta = Object.entries(meta)
    .filter(([key, value]) => {
      if (plumbingMetadataKeys.has(key)) return false;
      if (value === null || value === undefined || value === "") return false;
      return true;
    })
    .map(([key, value]) => (
      typeof value === "object" ? `${key}: ${JSON.stringify(value)}` : `${key}: ${String(value)}`
    ));
  if (usefulMeta.length === 0) {
    return `${title}\n\nNo searchable content body is available for this context item.`;
  }
  return [title, "", ...usefulMeta].join("\n");
}

function genericSearchText(title: string, data: Record<string, unknown>): string {
  if (typeof data.text === "string" && data.text.trim()) {
    return `${title}\n\n${data.text.trim()}`;
  }
  if (typeof data.summary === "string" && data.summary.trim()) {
    const parts = [title, "", `Summary: ${data.summary.trim()}`];
    if (typeof data.transcript === "string" && data.transcript.trim()) {
      parts.push("", `Transcript:\n${data.transcript.trim()}`);
    }
    return parts.join("\n");
  }
  const lines = [title];
  for (const [field, value] of Object.entries(data)) {
    if (excludedSystemFields.has(field)) continue;
    if (field === "metadata" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [metaKey, metaValue] of Object.entries(value as Record<string, unknown>)) {
        if (plumbingMetadataKeys.has(metaKey)) continue;
        if (metaValue === null || metaValue === undefined || metaValue === "") continue;
        if (typeof metaValue === "object") lines.push(`${metaKey}: ${JSON.stringify(metaValue)}`);
        else lines.push(`${metaKey}: ${String(metaValue)}`);
      }
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") lines.push(`${field}: ${JSON.stringify(value)}`);
    else lines.push(`${field}: ${String(value)}`);
  }
  return lines.join("\n");
}

/** Build the human-useful text that is embedded and BM25-indexed. */
export function searchTextForRecord(kind: KnowledgeKind, title: string, data: Record<string, unknown>): string {
  if (kind === "coding_run") return codingRunSearchText(title, data);
  if (kind === "audit_event") return auditEventSearchText(title, data);
  if (kind === "context_item") return contextItemSearchText(title, data);
  return genericSearchText(title, data);
}

/**
 * Shape a record for model tool results: keep substance, drop connector plumbing
 * that models tend to recite as high-confidence “facts”.
 */
export function presentRecordForAgent(record: CompanyRecord): Record<string, unknown> {
  const data = jsonSafe(record.data) as Record<string, unknown>;
  const presented: Record<string, unknown> = { ...data };
  delete presented.provenance;
  delete presented.companyId;
  delete presented.indexingEnabled;
  delete presented.accessRevision;
  delete presented.access;
  delete presented.schemaVersion;
  delete presented.artifacts;
  delete presented.cloudRun;
  delete presented.expiresAt;
  delete presented.grok;
  delete presented.dispatch;

  if (presented.source && typeof presented.source === "object" && !Array.isArray(presented.source)) {
    const source = presented.source as Record<string, unknown>;
    presented.source = {
      ...(typeof source.providerId === "string" ? { providerId: source.providerId } : {}),
      ...(typeof source.capabilityId === "string" ? { capabilityId: source.capabilityId } : {}),
      ...(typeof source.adapterId === "string" ? { adapterId: source.adapterId } : {}),
    };
  }

  if (presented.metadata && typeof presented.metadata === "object" && !Array.isArray(presented.metadata)) {
    presented.metadata = Object.fromEntries(
      Object.entries(presented.metadata as Record<string, unknown>)
        .filter(([key]) => !plumbingMetadataKeys.has(key)),
    );
  }

  if (
    record.kind === "context_item"
    && typeof presented.text === "string"
    && isMetadataOnlyContextText(presented.text)
  ) {
    presented.text = "Document content was not extracted. Only file presence metadata is available.";
    presented.contentQuality = "metadata_only";
  }

  return presented;
}

export function extractRecordMetadata(record: CompanyRecord): Record<string, string | number | boolean | null> {
  const data = record.data || {};
  let adapterId: string | null = null;
  let externalUrl: string | null = null;
  let internalRoute: string | null = null;
  let contentQuality: string | null = null;

  const artifactRefs = Array.isArray(data.artifactRefs) ? (data.artifactRefs as string[]) : [];
  const metaObj = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;

  if (record.kind === "context_item") {
    const sourceObj = (data.source && typeof data.source === "object" ? data.source : {}) as Record<string, unknown>;
    const capabilityId = typeof sourceObj.capabilityId === "string"
      ? sourceObj.capabilityId
      : null;
    adapterId = capabilityId === "context.document.read"
      ? "google_drive"
      : capabilityId === "context.calendar.read"
        ? "google_calendar"
        : capabilityId === "context.call.read"
          ? "odorik"
          : typeof sourceObj.adapterId === "string"
            ? sourceObj.adapterId
            : typeof sourceObj.providerId === "string"
              ? sourceObj.providerId
              : null;
    if (adapterId === "google_drive") {
      externalUrl = artifactRefs[0] || null;
    } else if (adapterId === "google_calendar") {
      externalUrl = (typeof metaObj.sourceUrl === "string" ? metaObj.sourceUrl : null) || artifactRefs[0] || null;
    } else if (adapterId === "gmail" || adapterId === "github" || sourceObj.providerId === "github") {
      externalUrl = (typeof metaObj.sourceUrl === "string" ? metaObj.sourceUrl : null) || artifactRefs[0] || null;
      if (sourceObj.providerId === "github") adapterId = "github";
    } else if (adapterId === "odorik") {
      internalRoute = "/contacts";
    }
    if (typeof data.text === "string" && isMetadataOnlyContextText(data.text)) {
      contentQuality = "metadata_only";
    }
  } else if (record.kind === "call") {
    adapterId = "odorik";
    internalRoute = typeof data.contactId === "string"
      ? `/contacts/${data.contactId}`
      : "/contacts";
  } else if (record.kind === "contact") {
    adapterId = "crm";
    internalRoute = `/contacts/${record.recordId}`;
  } else if (record.kind === "task" || record.kind === "case" || record.kind === "audit_event") {
    adapterId = "crm";
    if (record.kind === "task") internalRoute = "/tasks";
    if (record.kind === "case") internalRoute = `/cases/${record.recordId}`;
  } else if (record.kind === "coding_run") {
    adapterId = "github";
    const github = plainObject(data.github);
    const publication = plainObject(data.publicationResult);
    externalUrl = typeof publication.pullRequestUrl === "string"
      ? publication.pullRequestUrl
      : typeof github.issueUrl === "string"
        ? github.issueUrl
        : null;
    internalRoute = "/coding";
  }

  if (!externalUrl && artifactRefs[0] && typeof artifactRefs[0] === "string" && artifactRefs[0].startsWith("http")) {
    externalUrl = artifactRefs[0];
  }

  return {
    adapterId,
    externalUrl,
    internalRoute,
    contentQuality,
  };
}

export function chunkRecord(record: CompanyRecord, companyId: string): KnowledgeDocument[] {
  const fullText = searchTextForRecord(record.kind, record.title, record.data);
  const extraMeta = extractRecordMetadata(record);
  const access = accessForSourceRecord(record.kind, record.data);
  const accessFields = access.visibility === "company"
    ? { accessVisibility: "company" as const, accessMemberIds: [] }
    : { accessVisibility: "restricted" as const, accessMemberIds: access.memberIds };
  const chunkSize = 1800;
  const overlap = 220;
  if (fullText.length <= chunkSize) {
    return [{
      id: `${companyId}:${record.kind}:${record.recordId}:0`,
      companyId,
      kind: record.kind,
      recordId: record.recordId,
      sourcePath: record.sourcePath,
      title: record.title,
      text: fullText,
      occurredAt: record.occurredAt,
      ...accessFields,
      metadata: { ...extraMeta },
    }];
  }

  const chunks: KnowledgeDocument[] = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < fullText.length && chunkIndex < 100) {
    let end = Math.min(fullText.length, offset + chunkSize);
    if (end < fullText.length) {
      const boundary = Math.max(fullText.lastIndexOf("\n", end), fullText.lastIndexOf(" ", end));
      if (boundary > offset + chunkSize / 2) end = boundary;
    }
    const text = fullText.slice(offset, end).trim();
    if (text) {
      chunks.push({
        id: `${companyId}:${record.kind}:${record.recordId}:${chunkIndex}`,
        companyId,
        kind: record.kind,
        recordId: record.recordId,
        sourcePath: record.sourcePath,
        title: record.title,
        text,
        occurredAt: record.occurredAt,
        ...accessFields,
        metadata: { ...extraMeta, chunk: chunkIndex },
      });
    }
    if (end >= fullText.length) break;
    offset = Math.max(offset + 1, end - overlap);
    chunkIndex += 1;
  }
  return chunks;
}

function validateFilters(kind: KnowledgeKind, filters: RecordFilter[]): RecordFilter[] {
  const allowed = new Set(filterFields[kind]);
  return filters.filter((filter) => allowed.has(filter.field) && filter.value.trim());
}

function matchesFilters(record: CompanyRecord, filters: RecordFilter[]): boolean {
  return filters.every((filter) => {
    const actual = filter.field.split(".").reduce<unknown>((value, part) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      return (value as Record<string, unknown>)[part];
    }, record.data);
    if (Array.isArray(actual)) return actual.map(String).includes(filter.value);
    return String(actual ?? "").toLocaleLowerCase() === filter.value.toLocaleLowerCase();
  });
}

function sortTime(record: CompanyRecord): number {
  const value = record.occurredAt ? new Date(record.occurredAt).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

export class FirestoreCompanyData implements CompanyDataRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly companyId: string,
    private readonly memberId?: string,
  ) {}

  private readable(_kind: KnowledgeKind, data: Record<string, unknown>): boolean {
    if (data.indexingEnabled === false || data.contextEnabled === false) return false;
    return !this.memberId || canMemberAccess(data.access, this.memberId);
  }

  private async records(kind: KnowledgeKind, max = 500): Promise<CompanyRecord[]> {
    const collection = collectionByKnowledgeKind[kind];
    const source = this.firestore.collection(
      `companies/${this.companyId}/${collection}`,
    );
    const snapshot = await source.limit(max).get();
    return snapshot.docs.filter((document) => this.readable(kind, plainObject(document.data())))
      .map((document) => {
      const data = selectSafeFields(kind, plainObject(document.data()));
      return {
        kind,
        recordId: document.id,
        sourcePath: `companies/${this.companyId}/${collection}/${document.id}`,
        title: titleFor(kind, document.id, data),
        occurredAt: occurredAtFor(data),
        data,
      };
    }).sort((a, b) => sortTime(b) - sortTime(a));
  }

  async allDocuments(kinds: KnowledgeKind[] = [...knowledgeKinds]): Promise<KnowledgeDocument[]> {
    const records = (await Promise.all(kinds.map((kind) => this.records(kind)))).flat();
    return records.flatMap((record) => chunkRecord(record, this.companyId));
  }

  async getRecord(kind: KnowledgeKind, recordId: string): Promise<CompanyRecord | null> {
    const collection = collectionByKnowledgeKind[kind];
    const path = `companies/${this.companyId}/${collection}/${recordId}`;
    const snapshot = await this.firestore.doc(path).get();
    if (!snapshot.exists) return null;
    if (!this.readable(kind, plainObject(snapshot.data()))) return null;
    const data = selectSafeFields(kind, plainObject(snapshot.data()));
    return {
      kind,
      recordId,
      sourcePath: snapshot.ref.path,
      title: titleFor(kind, recordId, data),
      occurredAt: occurredAtFor(data),
      data,
    };
  }

  async listRecords(kind: KnowledgeKind, filters: RecordFilter[] = [], limit = 20): Promise<CompanyRecord[]> {
    const validFilters = validateFilters(kind, filters);
    const records = await this.records(kind);
    return records.filter((record) => matchesFilters(record, validFilters)).slice(0, Math.min(50, limit));
  }

  async aggregateRecords(input: {
    kind: KnowledgeKind;
    filters?: RecordFilter[];
    groupBy?: string;
  }): Promise<{ total: number; groups?: Record<string, number> }> {
    const validFilters = validateFilters(input.kind, input.filters || []);
    const records = (await this.records(input.kind, 1000))
      .filter((record) => matchesFilters(record, validFilters));
    if (!input.groupBy || !filterFields[input.kind].includes(input.groupBy)) {
      return { total: records.length };
    }
    const groups: Record<string, number> = {};
    for (const record of records) {
      const key = String(record.data[input.groupBy] ?? "unknown");
      groups[key] = (groups[key] || 0) + 1;
    }
    return { total: records.length, groups };
  }
}

export function isKnowledgeKind(value: string): value is KnowledgeKind {
  return (knowledgeKinds as readonly string[]).includes(value);
}
