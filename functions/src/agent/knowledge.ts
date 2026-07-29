import type { Firestore } from "firebase-admin/firestore";
import { jsonSafe } from "../firestore.js";
import {
  knowledgeKinds,
  type KnowledgeDocument,
  type KnowledgeKind,
  type RecordFilter,
} from "./types.js";

export const collectionByKnowledgeKind: Record<KnowledgeKind, string> = {
  call: "calls",
  contact: "contacts",
  task: "workItems",
  case: "cases",
  audit_event: "auditEvents",
  context_item: "contextItems",
};

const knowledgeKindByCollection = Object.fromEntries(
  Object.entries(collectionByKnowledgeKind).map(([kind, collection]) => [collection, kind]),
) as Record<string, KnowledgeKind>;

const safeFields: Record<KnowledgeKind, string[]> = {
  call: [
    "status", "from", "to", "duration", "odorikTime", "lineName", "language",
    "summary", "transcript", "segments", "actionItems", "uploadedAt", "processedAt",
  ],
  contact: [
    "displayName", "phoneE164", "phoneRaw", "email", "origin", "createdFromCallId",
    "lastCallAt", "createdAt", "updatedAt",
  ],
  task: [
    "status", "title", "instructions", "assigneeUid", "assigneeName", "dueAt",
    "contactId", "caseId", "callId", "source", "authorization", "outcomeNote",
    "createdBy", "createdAt", "updatedAt", "closedAt",
  ],
  case: [
    "title", "pipelineId", "stageId", "contactId",
    "contactName", "contactPhone", "ownerUid", "ownerName", "createdAt",
    "updatedAt", "stageChangedAt", "revision", "source", "authorization",
  ],
  audit_event: [
    "aggregateType", "aggregateId", "type", "actor", "before", "after", "createdAt",
  ],
  context_item: [
    "companyId", "kind", "source", "title", "text", "occurredAt", "observedAt",
    "artifactRefs", "participantRefs", "access", "metadata", "provenance",
    "indexingEnabled", "createdAt", "updatedAt",
  ],
};

const filterFields: Record<KnowledgeKind, string[]> = {
  call: ["status", "language", "from", "to", "contactId"],
  contact: ["displayName", "phoneE164", "phoneRaw", "email", "origin"],
  task: ["status", "assigneeUid", "contactId", "caseId", "callId"],
  case: ["stageId", "contactId", "ownerUid"],
  audit_event: ["aggregateType", "aggregateId", "type"],
  context_item: ["kind", "source.adapterId", "source.connectionId", "source.resourceId"],
};

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
  return `${String(data.type || "Audit event")} · ${String(data.aggregateId || id)}`;
}

function occurredAtFor(data: Record<string, unknown>): string | null {
  for (const field of ["occurredAt", "createdAt", "processedAt", "uploadedAt", "updatedAt", "odorikTime"]) {
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
]);

function textFor(title: string, data: Record<string, unknown>): string {
  if (typeof data.text === "string" && data.text.trim()) {
    return `${title}\n\n${data.text.trim()}`;
  }
  const lines = [title];
  for (const [field, value] of Object.entries(data)) {
    if (excludedSystemFields.has(field)) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") lines.push(`${field}: ${JSON.stringify(value)}`);
    else lines.push(`${field}: ${String(value)}`);
  }
  return lines.join("\n");
}

export function extractRecordMetadata(record: CompanyRecord): Record<string, string | number | boolean | null> {
  const data = record.data || {};
  let adapterId: string | null = null;
  let externalUrl: string | null = null;
  let internalRoute: string | null = null;

  const artifactRefs = Array.isArray(data.artifactRefs) ? (data.artifactRefs as string[]) : [];
  const metaObj = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;

  if (record.kind === "context_item") {
    const sourceObj = (data.source && typeof data.source === "object" ? data.source : {}) as Record<string, unknown>;
    adapterId = typeof sourceObj.adapterId === "string" ? sourceObj.adapterId : null;
    if (adapterId === "google_drive") {
      externalUrl = artifactRefs[0] || null;
    } else if (adapterId === "google_calendar") {
      externalUrl = (typeof metaObj.sourceUrl === "string" ? metaObj.sourceUrl : null) || artifactRefs[0] || null;
    } else if (adapterId === "gmail" || adapterId === "github") {
      externalUrl = (typeof metaObj.sourceUrl === "string" ? metaObj.sourceUrl : null) || artifactRefs[0] || null;
    } else if (adapterId === "odorik") {
      internalRoute = "/contacts";
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
  }

  if (!externalUrl && artifactRefs[0] && typeof artifactRefs[0] === "string" && artifactRefs[0].startsWith("http")) {
    externalUrl = artifactRefs[0];
  }

  return {
    adapterId,
    externalUrl,
    internalRoute,
  };
}

export function chunkRecord(record: CompanyRecord, companyId: string): KnowledgeDocument[] {
  const fullText = textFor(record.title, record.data);
  const extraMeta = extractRecordMetadata(record);
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
  constructor(private readonly firestore: Firestore, private readonly companyId: string) {}

  private async records(kind: KnowledgeKind, max = 500): Promise<CompanyRecord[]> {
    const collection = collectionByKnowledgeKind[kind];
    const source = this.firestore.collection(
      `companies/${this.companyId}/${collection}`,
    );
    const snapshot = await source.limit(max).get();
    return snapshot.docs.filter((document) => (
      kind !== "context_item" || document.data().indexingEnabled !== false
    )).map((document) => {
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
    if (kind === "context_item" && snapshot.data()?.indexingEnabled === false) return null;
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
