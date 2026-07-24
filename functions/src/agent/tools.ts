import { z } from "zod";
import type { CompanyDataRepository, CompanyRecord } from "./knowledge.js";
import {
  SearchUnavailableError,
  searchUnavailableMessage,
  type KnowledgeSearch,
} from "./search.js";
import {
  knowledgeKinds,
  type KnowledgeKind,
  type ToolCitation,
} from "./types.js";

const kindSchema = z.enum(knowledgeKinds);
const filterSchema = z.object({
  field: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(500),
});

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  kinds: z.array(kindSchema).max(knowledgeKinds.length).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

const getSchema = z.object({
  kind: kindSchema,
  record_id: z.string().trim().min(1).max(500),
});

const listSchema = z.object({
  kind: kindSchema,
  filters: z.array(filterSchema).max(6).optional(),
  limit: z.number().int().min(1).max(30).optional(),
});

const aggregateSchema = z.object({
  kind: kindSchema,
  filters: z.array(filterSchema).max(6).optional(),
  group_by: z.string().trim().min(1).max(100).optional(),
});

export const factToolDeclarations = [
  {
    name: "search_company_data",
    description:
      "Hybrid semantic and full-text search across calls, transcripts, contacts, service requests, tasks, reviews, and audit events. Use this first for names, topics, phrases, and broad factual questions.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "A focused search query, preferably one fact or concept at a time." },
        kinds: {
          type: "ARRAY",
          items: { type: "STRING", enum: [...knowledgeKinds] },
          description: "Optional record kinds to search.",
        },
        limit: { type: "INTEGER", description: "Number of evidence chunks, from 1 to 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_company_record",
    description:
      "Fetch one complete safe company record after its kind and exact ID are known from search or another tool.",
    parameters: {
      type: "OBJECT",
      properties: {
        kind: { type: "STRING", enum: [...knowledgeKinds] },
        record_id: { type: "STRING", description: "Exact record ID returned by another tool." },
      },
      required: ["kind", "record_id"],
    },
  },
  {
    name: "list_company_records",
    description:
      "List recent records of one kind with exact equality filters. Use for questions such as which requests have a status or which interactions belong to a contact.",
    parameters: {
      type: "OBJECT",
      properties: {
        kind: { type: "STRING", enum: [...knowledgeKinds] },
        filters: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              field: { type: "STRING" },
              value: { type: "STRING" },
            },
            required: ["field", "value"],
          },
        },
        limit: { type: "INTEGER", description: "Maximum records from 1 to 30." },
      },
      required: ["kind"],
    },
  },
  {
    name: "aggregate_company_records",
    description:
      "Count records, optionally filtered or grouped by an allowed exact field. Use for totals and status distributions instead of estimating from search results.",
    parameters: {
      type: "OBJECT",
      properties: {
        kind: { type: "STRING", enum: [...knowledgeKinds] },
        filters: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              field: { type: "STRING" },
              value: { type: "STRING" },
            },
            required: ["field", "value"],
          },
        },
        group_by: { type: "STRING", description: "Optional allowed field, such as status, type, urgency, or language." },
      },
      required: ["kind"],
    },
  },
] as const;

function excerpt(value: string, max = 900): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function compactRecord(record: CompanyRecord): Record<string, unknown> {
  const json = JSON.stringify(record.data);
  const data = json.length <= 12_000
    ? record.data
    : { truncated: true, content: `${json.slice(0, 11_900)}…` };
  return {
    kind: record.kind,
    recordId: record.recordId,
    title: record.title,
    occurredAt: record.occurredAt,
    data,
  };
}

export class CitationRegistry {
  private readonly byKey = new Map<string, ToolCitation>();
  private readonly byId = new Map<string, ToolCitation>();

  add(input: Omit<ToolCitation, "citationId">, key = input.sourcePath): ToolCitation {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const cleanInput = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    ) as Omit<ToolCitation, "citationId">;
    const citation = { ...cleanInput, citationId: `C${this.byId.size + 1}` };
    this.byKey.set(key, citation);
    this.byId.set(citation.citationId, citation);
    return citation;
  }

  get(citationId: string): ToolCitation | undefined {
    return this.byId.get(citationId);
  }

  resolve(citationIds: string[]): ToolCitation[] {
    return [...new Set(citationIds)].flatMap((id) => {
      const citation = this.get(id);
      return citation ? [citation] : [];
    });
  }

  all(): ToolCitation[] {
    return [...this.byId.values()];
  }
}

export type ToolExecution = {
  result: Record<string, unknown>;
  citationIds: string[];
};

export interface AgentToolExecutor {
  execute(name: string, args: unknown): Promise<ToolExecution>;
  citations: CitationRegistry;
}

function extractCitationInfo(record: CompanyRecord): {
  excerptText: string;
  adapterId?: string;
  externalUrl?: string;
  internalRoute?: string;
  metadata?: Record<string, unknown>;
  artifactRefs?: string[];
} {
  const data = record.data || {};
  let adapterId: string | undefined;
  let externalUrl: string | undefined;
  let internalRoute: string | undefined;

  const artifactRefs = Array.isArray(data.artifactRefs) ? (data.artifactRefs as string[]) : undefined;
  const metadata = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;

  if (record.kind === "context_item") {
    const sourceObj = (data.source && typeof data.source === "object" ? data.source : {}) as Record<string, unknown>;
    adapterId = typeof sourceObj.adapterId === "string" ? sourceObj.adapterId : undefined;
    if (adapterId === "google_drive") {
      externalUrl = artifactRefs?.[0];
    } else if (adapterId === "google_calendar") {
      externalUrl = (typeof metadata.sourceUrl === "string" ? metadata.sourceUrl : undefined) || artifactRefs?.[0];
    } else if (adapterId === "gmail" || adapterId === "github") {
      externalUrl = (typeof metadata.sourceUrl === "string" ? metadata.sourceUrl : undefined) || artifactRefs?.[0];
    } else if (adapterId === "odorik") {
      internalRoute = "/inbox";
    }
  } else if (record.kind === "call" || record.kind === "interaction") {
    adapterId = "odorik";
    internalRoute = "/inbox";
  } else if (record.kind === "contact") {
    adapterId = "crm";
    internalRoute = `/contacts/${record.recordId}`;
  } else if (record.kind === "service_request") {
    adapterId = "crm";
    internalRoute = `/requests/${record.recordId}`;
  } else if (record.kind === "task" || record.kind === "review" || record.kind === "audit_event") {
    adapterId = "crm";
  }

  if (!externalUrl && artifactRefs?.[0] && typeof artifactRefs[0] === "string" && artifactRefs[0].startsWith("http")) {
    externalUrl = artifactRefs[0];
  }

  let excerptText = "";
  if (typeof data.text === "string" && data.text.trim()) {
    excerptText = excerpt(data.text);
  } else if (typeof data.summary === "string" && data.summary.trim()) {
    excerptText = excerpt(data.summary);
  } else if (record.kind === "contact") {
    excerptText = excerpt([data.displayName, data.phoneE164, data.email].filter(Boolean).join(" · "));
  } else if (record.kind === "service_request") {
    excerptText = excerpt([data.title, data.serviceType, data.description, data.address].filter(Boolean).join(" — "));
  } else if (record.kind === "task") {
    excerptText = excerpt(`${data.type || "Task"} · Status: ${data.status || "unknown"}`);
  } else {
    excerptText = excerpt(record.title || record.recordId);
  }

  return {
    excerptText,
    adapterId,
    externalUrl,
    internalRoute,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    artifactRefs,
  };
}

export class CompanyFactTools implements AgentToolExecutor {
  readonly citations = new CitationRegistry();

  constructor(
    private readonly repository: CompanyDataRepository,
    private readonly search: KnowledgeSearch,
  ) {}

  async execute(name: string, args: unknown): Promise<ToolExecution> {
    if (name === "search_company_data") {
      const input = searchSchema.parse(args);
      let hits;
      try {
        hits = await this.search.search(input);
      } catch (error) {
        if (error instanceof SearchUnavailableError) {
          return {
            result: {
              available: false,
              error: searchUnavailableMessage,
              matches: [],
            },
            citationIds: [],
          };
        }
        throw error;
      }
      const matches = hits.map((hit) => {
        const citation = this.citations.add({
          kind: hit.kind,
          recordId: hit.recordId,
          sourcePath: hit.sourcePath,
          title: hit.title,
          excerpt: excerpt(hit.text),
          occurredAt: hit.occurredAt,
          adapterId: typeof hit.metadata?.adapterId === "string" ? hit.metadata.adapterId : undefined,
          externalUrl: typeof hit.metadata?.externalUrl === "string" ? hit.metadata.externalUrl : undefined,
          internalRoute: typeof hit.metadata?.internalRoute === "string" ? hit.metadata.internalRoute : undefined,
        }, hit.id);
        return {
          citationId: citation.citationId,
          kind: hit.kind,
          recordId: hit.recordId,
          title: hit.title,
          excerpt: citation.excerpt,
          occurredAt: hit.occurredAt,
          score: Number(hit.score.toFixed(6)),
          retrieval: hit.retrieval,
        };
      });
      return { result: { matches }, citationIds: matches.map((match) => match.citationId) };
    }

    if (name === "get_company_record") {
      const input = getSchema.parse(args);
      const record = await this.repository.getRecord(input.kind, input.record_id);
      if (!record) return { result: { found: false }, citationIds: [] };
      const info = extractCitationInfo(record);
      const citation = this.citations.add({
        kind: record.kind,
        recordId: record.recordId,
        sourcePath: record.sourcePath,
        title: record.title,
        excerpt: info.excerptText,
        occurredAt: record.occurredAt,
        adapterId: info.adapterId,
        externalUrl: info.externalUrl,
        internalRoute: info.internalRoute,
        metadata: info.metadata,
        artifactRefs: info.artifactRefs,
      });
      return {
        result: { found: true, citationId: citation.citationId, record: compactRecord(record) },
        citationIds: [citation.citationId],
      };
    }

    if (name === "list_company_records") {
      const input = listSchema.parse(args);
      const records = await this.repository.listRecords(input.kind, input.filters, input.limit);
      const items = records.map((record) => {
        const info = extractCitationInfo(record);
        const citation = this.citations.add({
          kind: record.kind,
          recordId: record.recordId,
          sourcePath: record.sourcePath,
          title: record.title,
          excerpt: info.excerptText,
          occurredAt: record.occurredAt,
          adapterId: info.adapterId,
          externalUrl: info.externalUrl,
          internalRoute: info.internalRoute,
          metadata: info.metadata,
          artifactRefs: info.artifactRefs,
        });
        return { citationId: citation.citationId, ...compactRecord(record) };
      });
      return { result: { items, count: items.length }, citationIds: items.map((item) => item.citationId) };
    }

    if (name === "aggregate_company_records") {
      const input = aggregateSchema.parse(args);
      const aggregate = await this.repository.aggregateRecords({
        kind: input.kind,
        filters: input.filters,
        groupBy: input.group_by,
      });
      const filterText = (input.filters || []).map((filter) => `${filter.field}=${filter.value}`).join(", ");
      const sourcePath = `aggregate/${input.kind}/${filterText || "all"}/${input.group_by || "total"}`;
      const citation = this.citations.add({
        kind: input.kind,
        recordId: "aggregate",
        sourcePath,
        title: `Computed ${input.kind} aggregate`,
        excerpt: JSON.stringify({ ...aggregate, filters: input.filters || [], groupBy: input.group_by || null }),
        occurredAt: null,
      });
      return {
        result: { citationId: citation.citationId, ...aggregate },
        citationIds: [citation.citationId],
      };
    }

    throw new Error(`Unknown agent tool: ${name}`);
  }
}

export function kindsFromStrings(values: string[] | undefined): KnowledgeKind[] | undefined {
  if (!values) return undefined;
  const allowed = new Set<string>(knowledgeKinds);
  return values.filter((value): value is KnowledgeKind => allowed.has(value));
}
