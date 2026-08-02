export const knowledgeKinds = [
  "call",
  "contact",
  "task",
  "case",
  "audit_event",
  "context_item",
] as const;

export type KnowledgeKind = typeof knowledgeKinds[number];

export type KnowledgeDocument = {
  id: string;
  companyId: string;
  kind: KnowledgeKind;
  recordId: string;
  sourcePath: string;
  title: string;
  text: string;
  occurredAt: string | null;
  accessVisibility?: "company" | "restricted";
  accessMemberIds?: string[];
  metadata: Record<string, string | number | boolean | null>;
};

export type SearchHit = KnowledgeDocument & {
  score: number;
  retrieval: "hybrid_rrf" | "lexical_bm25";
};

export type RecordFilter = {
  field: string;
  value: string;
};

export type ToolCitation = {
  citationId: string;
  kind: KnowledgeKind;
  recordId: string;
  sourcePath: string;
  title: string;
  excerpt: string;
  occurredAt: string | null;
  adapterId?: string;
  externalUrl?: string;
  internalRoute?: string;
  metadata?: Record<string, unknown>;
  artifactRefs?: string[];
};

export type AgentAnswer = {
  answer: string;
  citations: ToolCitation[];
  confidence: "high" | "medium" | "low";
  limitations: string[];
  toolTrace: Array<{
    name: string;
    args: Record<string, unknown>;
    citationIds: string[];
  }>;
  usage: {
    promptTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    totalTokens: number;
  };
};
