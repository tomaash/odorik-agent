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
    kind: "call",
    recordId: "odorik_call_1",
    sourcePath: "calls/odorik_call_1",
    title: "Call +420777123456 → +420910122307",
    occurredAt: "2026-07-20T09:15:00.000Z",
    data: {
      contactId: "contact_eva",
      status: "completed",
      from: "+420777123456",
      to: "+420910122307",
      summary: "Eva needs a wardrobe moved from Brno to Prague next Tuesday.",
      transcript: "Caller: I need to move a wardrobe from Brno to Prague next Tuesday.",
      language: "cs",
    },
  },
  {
    kind: "deal",
    recordId: "deal_move",
    sourcePath: "deals/deal_move",
    title: "Move wardrobe to Prague · Waiting",
    occurredAt: "2026-07-20T09:20:00.000Z",
    data: {
      title: "Move wardrobe to Prague",
      contactId: "contact_eva",
      contactName: "Eva Nováková",
      stageId: "waiting",
      stageName: "Waiting",
      stageCategory: "open",
      ownerName: "Tomáš Holas",
    },
  },
  {
    kind: "task",
    recordId: "task_move_floor",
    sourcePath: "tasks/task_move_floor",
    title: "Confirm pickup floor with Eva · open",
    occurredAt: "2026-07-20T10:00:00.000Z",
    data: {
      title: "Confirm pickup floor with Eva",
      status: "open",
      assigneeName: "Tomáš Holas",
      contactId: "contact_eva",
      dealId: "deal_move",
      callId: "odorik_call_1",
      instructions: "The move cannot be scheduled until the pickup floor is known.",
    },
  },
  {
    kind: "deal",
    recordId: "deal_repair",
    sourcePath: "deals/deal_repair",
    title: "Repair office chair · Won",
    occurredAt: "2026-07-19T12:00:00.000Z",
    data: {
      title: "Repair office chair",
      contactId: "contact_petr",
      contactName: "Petr Svoboda",
      stageId: "won",
      stageName: "Won",
      stageCategory: "won",
      ownerName: "Tomáš Holas",
    },
  },
  {
    kind: "audit_event",
    recordId: "event_move_waiting",
    sourcePath: "auditEvents/event_move_waiting",
    title: "deal_stage_changed · deal_move",
    occurredAt: "2026-07-20T10:00:00.000Z",
    data: {
      aggregateType: "deal",
      aggregateId: "deal_move",
      type: "deal_stage_changed",
      before: { stageId: "in_progress" },
      after: { stageId: "waiting", note: "Need exact pickup floor." },
    },
  },
];

function matches(record: CompanyRecord, filters: RecordFilter[]): boolean {
  return filters.every((filter) => String(record.data[filter.field] ?? "").toLocaleLowerCase() === filter.value.toLocaleLowerCase());
}

export class FixtureCompanyData implements CompanyDataRepository {
  async allDocuments(kinds?: KnowledgeKind[]): Promise<KnowledgeDocument[]> {
    const selected = kinds?.length ? records.filter((record) => kinds.includes(record.kind)) : records;
    return selected.flatMap((record) => chunkRecord(record, "fixture"));
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
