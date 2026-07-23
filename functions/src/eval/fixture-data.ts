import type {
  CompanyDataRepository,
  CompanyRecord,
} from "../agent/knowledge.js";
import { chunkRecord } from "../agent/knowledge.js";
import type { KnowledgeDocument, KnowledgeKind, RecordFilter } from "../agent/types.js";

const records: CompanyRecord[] = [
  {
    kind: "contact",
    recordId: "contact_eva",
    sourcePath: "contacts/contact_eva",
    title: "Eva Nováková",
    occurredAt: "2026-07-20T08:00:00.000Z",
    data: { displayName: "Eva Nováková", phoneE164: "+420777123456", email: "eva@example.cz" },
  },
  {
    kind: "contact",
    recordId: "contact_petr",
    sourcePath: "contacts/contact_petr",
    title: "Petr Svoboda",
    occurredAt: "2026-07-19T08:00:00.000Z",
    data: { displayName: "Petr Svoboda", phoneE164: "+420606555444" },
  },
  {
    kind: "interaction",
    recordId: "odorik_call_1",
    sourcePath: "interactions/odorik_call_1",
    title: "Call interaction +420777123456",
    occurredAt: "2026-07-20T09:15:00.000Z",
    data: {
      contactId: "contact_eva",
      from: "+420777123456",
      summary: "Eva needs a wardrobe moved from Brno to Prague next Tuesday.",
      transcript: "Caller: I need to move a wardrobe from Brno to Prague next Tuesday.",
      language: "cs",
    },
  },
  {
    kind: "service_request",
    recordId: "request_move",
    sourcePath: "serviceRequests/request_move",
    title: "Move wardrobe to Prague",
    occurredAt: "2026-07-20T09:20:00.000Z",
    data: {
      contactId: "contact_eva",
      status: "waiting_customer",
      serviceType: "moving",
      description: "Move one wardrobe from Brno to Prague.",
      requestedTiming: "next Tuesday",
      urgency: "normal",
    },
  },
  {
    kind: "service_request",
    recordId: "request_repair",
    sourcePath: "serviceRequests/request_repair",
    title: "Repair office chair",
    occurredAt: "2026-07-19T12:00:00.000Z",
    data: {
      contactId: "contact_petr",
      status: "completed",
      serviceType: "repair",
      description: "Repair one office chair in Prague.",
      urgency: "normal",
    },
  },
  {
    kind: "audit_event",
    recordId: "event_move_waiting",
    sourcePath: "auditEvents/event_move_waiting",
    title: "request_status_changed · request_move",
    occurredAt: "2026-07-20T10:00:00.000Z",
    data: {
      aggregateType: "service_request",
      aggregateId: "request_move",
      type: "request_status_changed",
      before: { status: "in_progress" },
      after: { status: "waiting_customer", note: "Need exact pickup floor." },
    },
  },
];

function matches(record: CompanyRecord, filters: RecordFilter[]): boolean {
  return filters.every((filter) => String(record.data[filter.field] ?? "").toLocaleLowerCase() === filter.value.toLocaleLowerCase());
}

export class FixtureCompanyData implements CompanyDataRepository {
  async allDocuments(kinds?: KnowledgeKind[]): Promise<KnowledgeDocument[]> {
    const selected = kinds?.length ? records.filter((record) => kinds.includes(record.kind)) : records;
    return selected.flatMap((record) => chunkRecord(record));
  }

  async getRecord(kind: KnowledgeKind, recordId: string): Promise<CompanyRecord | null> {
    return records.find((record) => record.kind === kind && record.recordId === recordId) || null;
  }

  async listRecords(kind: KnowledgeKind, filters: RecordFilter[] = [], limit = 20): Promise<CompanyRecord[]> {
    return records.filter((record) => record.kind === kind && matches(record, filters)).slice(0, limit);
  }

  async aggregateRecords(input: {
    kind: KnowledgeKind;
    filters?: RecordFilter[];
    groupBy?: string;
  }): Promise<{ total: number; groups?: Record<string, number> }> {
    const selected = records.filter((record) => record.kind === input.kind && matches(record, input.filters || []));
    if (!input.groupBy) return { total: selected.length };
    const groups: Record<string, number> = {};
    for (const record of selected) {
      const key = String(record.data[input.groupBy] ?? "unknown");
      groups[key] = (groups[key] || 0) + 1;
    }
    return { total: selected.length, groups };
  }
}

