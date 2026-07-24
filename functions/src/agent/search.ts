import { createHash } from "node:crypto";
import {
  chunkRecord,
  type CompanyDataRepository,
  type CompanyRecord,
} from "./knowledge.js";
import type { KnowledgeDocument, KnowledgeKind, SearchHit } from "./types.js";

export const embeddingModel = "gemini-embedding-2";
export const embeddingDimensions = 1536;
export const qdrantCollection = "company_context_v4";
export const qdrantDenseVectorConfig = {
  size: embeddingDimensions,
  distance: "Cosine",
  datatype: "float16",
} as const;

export interface EmbeddingProvider {
  readonly dimensions: number;
  embedDocument(document: KnowledgeDocument): Promise<number[]>;
  embedQuery(query: string): Promise<number[]>;
}

export interface KnowledgeSearch {
  search(input: { query: string; kinds?: KnowledgeKind[]; limit?: number }): Promise<SearchHit[]>;
}

export type RankedItem<T> = { item: T; score: number };

export function reciprocalRankFusion<T>(
  rankings: Array<Array<RankedItem<T>>>,
  identity: (item: T) => string,
  options: { k?: number; weights?: number[]; limit?: number } = {},
): RankedItem<T>[] {
  const k = options.k ?? 60;
  const totals = new Map<string, { item: T; score: number }>();
  rankings.forEach((ranking, rankingIndex) => {
    const weight = options.weights?.[rankingIndex] ?? 1;
    ranking.forEach((entry, rank) => {
      const id = identity(entry.item);
      const existing = totals.get(id) || { item: entry.item, score: 0 };
      existing.score += weight / (k + rank + 1);
      totals.set(id, existing);
    });
  });
  return [...totals.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);
}

export function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .match(/[\p{L}\p{N}][\p{L}\p{N}_.+@-]*/gu) || [];
}

export function bm25Search(
  query: string,
  documents: KnowledgeDocument[],
  limit = 10,
): SearchHit[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || documents.length === 0) return [];
  const tokenized = documents.map((document) => {
    const titleTokens = tokenize(document.title);
    return [...titleTokens, ...titleTokens, ...tokenize(document.text)];
  });
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const k1 = 1.2;
  const b = 0.75;
  const scored = documents.map((document, index) => {
    const tokens = tokenized[index] || [];
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) || 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + ((documents.length - df + 0.5) / (df + 0.5)));
      score += idf * ((frequency * (k1 + 1)) / (
        frequency + k1 * (1 - b + b * (tokens.length / averageLength))
      ));
    }
    return { document, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ document, score }) => ({ ...document, score, retrieval: "lexical_bm25" as const }));
}

type EmbeddingPayload = {
  embedding?: { values?: number[] };
  error?: { status?: string; message?: string };
};

export class GeminiEmbedder {
  readonly dimensions = embeddingDimensions;
  readonly model = embeddingModel;

  constructor(private readonly apiKey: string) {}

  private async embed(text: string) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: this.dimensions,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = await response.json() as EmbeddingPayload;
    if (!response.ok || !payload.embedding?.values?.length) {
      throw new Error(
        `Gemini embedding ${payload.error?.status || response.status}: ${payload.error?.message || "empty embedding"}`,
      );
    }
    return payload.embedding.values;
  }

  embedDocument(document: KnowledgeDocument): Promise<number[]> {
    const title = document.title.trim().slice(0, 500) || "none";
    return this.embed(`title: ${title} | text: ${document.text}`);
  }

  embedQuery(query: string): Promise<number[]> {
    return this.embed(`task: search result | query: ${query}`);
  }
}

type QdrantPoint = {
  id?: string | number;
  score?: number;
  payload?: Record<string, unknown>;
};

type QdrantResponse = {
  status?: string | { error?: string };
  result?: unknown;
};

const bm25Options = {
  language: "none",
  tokenizer: "multilingual",
  ascii_folding: true,
};

function pointId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type QdrantCollectionStats = {
  status: string;
  pointsCount: number;
  indexedVectorsCount: number;
  denseDatatype: string;
  denseVectorsOnDisk: boolean;
  quantization: string;
};

export class QdrantHybridSearch implements KnowledgeSearch {
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly apiKey: string,
    private readonly embedder: EmbeddingProvider,
    private readonly collection = qdrantCollection,
    private readonly companyId = "default",
  ) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}): Promise<QdrantResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "api-key": this.apiKey,
        ...(init.headers || {}),
      },
      signal: init.signal || AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => ({})) as QdrantResponse;
    if (!response.ok) {
      const status = typeof payload.status === "object" ? payload.status.error : payload.status;
      throw new Error(`Qdrant ${response.status}: ${status || "request failed"}`);
    }
    return payload;
  }

  private denseCollectionConfig(payload: QdrantResponse): {
    datatype: string;
    onDisk: boolean;
    quantization: string;
  } {
    const result = payload.result && typeof payload.result === "object"
      ? payload.result as Record<string, unknown>
      : {};
    const config = result.config && typeof result.config === "object"
      ? result.config as Record<string, unknown>
      : {};
    const params = config.params && typeof config.params === "object"
      ? config.params as Record<string, unknown>
      : {};
    const vectors = params.vectors && typeof params.vectors === "object"
      ? params.vectors as Record<string, unknown>
      : {};
    const dense = vectors.dense && typeof vectors.dense === "object"
      ? vectors.dense as Record<string, unknown>
      : {};
    return {
      datatype: String(dense.datatype || "float32"),
      onDisk: dense.on_disk === true,
      quantization: config.quantization_config == null ? "none" : "configured",
    };
  }

  private collectionUsesFloat16(payload: QdrantResponse): boolean {
    const dense = this.denseCollectionConfig(payload);
    return dense.datatype === qdrantDenseVectorConfig.datatype
      && dense.onDisk === false
      && dense.quantization === "none";
  }

  async ensureCollection(reset = false): Promise<void> {
    if (reset) {
      await this.request(`/collections/${encodeURIComponent(this.collection)}`, { method: "DELETE" })
        .catch((error) => {
          if (!String(error).includes("404")) throw error;
        });
    }
    const exists = await fetch(`${this.baseUrl}/collections/${encodeURIComponent(this.collection)}`, {
      headers: { "api-key": this.apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (exists.ok) {
      const payload = await exists.json().catch(() => ({})) as QdrantResponse;
      if (!this.collectionUsesFloat16(payload)) {
        throw new Error(
          `Qdrant collection ${this.collection} does not use the required float16-only schema; `
          + "run a full reindex into a fresh collection",
        );
      }
      return;
    }
    if (exists.status !== 404) throw new Error(`Qdrant collection check failed: ${exists.status}`);
    await this.request(`/collections/${encodeURIComponent(this.collection)}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          dense: {
            ...qdrantDenseVectorConfig,
            size: this.embedder.dimensions,
          },
        },
        sparse_vectors: { bm25: { modifier: "idf" } },
      }),
    });
    for (const field of ["companyId", "kind", "recordId", "sourcePath"]) {
      await this.request(`/collections/${encodeURIComponent(this.collection)}/index?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      });
    }
  }

  async replaceDocuments(documents: KnowledgeDocument[]): Promise<number> {
    await this.ensureCollection(true);
    await this.upsertDocuments(documents);
    return documents.length;
  }

  private async upsertDocuments(documents: KnowledgeDocument[]): Promise<void> {
    const batchSize = 8;
    for (let offset = 0; offset < documents.length; offset += batchSize) {
      const batch = documents.slice(offset, offset + batchSize);
      const vectors = await Promise.all(batch.map((document) => this.embedder.embedDocument(document)));
      await this.request(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({
          points: batch.map((document, index) => ({
            id: pointId(document.id),
            vector: {
              dense: vectors[index],
              bm25: { text: document.text, model: "qdrant/bm25", options: bm25Options },
            },
            payload: document,
          })),
        }),
        signal: AbortSignal.timeout(120_000),
      });
    }
  }

  async deleteRecord(kind: KnowledgeKind, recordId: string): Promise<void> {
    await this.ensureCollection();
    await this.request(`/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [
            { key: "companyId", match: { value: this.companyId } },
            { key: "kind", match: { value: kind } },
            { key: "recordId", match: { value: recordId } },
          ],
        },
      }),
    });
  }

  async synchronizeRecord(input: {
    kind: KnowledgeKind;
    recordId: string;
    record: CompanyRecord | null;
  }): Promise<{ action: "upserted" | "deleted"; points: number }> {
    await this.ensureCollection();
    if (!input.record) {
      await this.deleteRecord(input.kind, input.recordId);
      return { action: "deleted", points: 0 };
    }
    const documents = chunkRecord(input.record, this.companyId);
    const vectors = await Promise.all(documents.map((document) => this.embedder.embedDocument(document)));
    await this.deleteRecord(input.kind, input.recordId);
    await this.upsertDocumentsWithVectors(documents, vectors);
    return { action: "upserted", points: documents.length };
  }

  private async upsertDocumentsWithVectors(
    documents: KnowledgeDocument[],
    vectors: number[][],
  ): Promise<void> {
    const batchSize = 8;
    for (let offset = 0; offset < documents.length; offset += batchSize) {
      const batch = documents.slice(offset, offset + batchSize);
      const batchVectors = vectors.slice(offset, offset + batchSize);
      await this.request(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({
          points: batch.map((document, index) => ({
            id: pointId(document.id),
            vector: {
              dense: batchVectors[index],
              bm25: { text: document.text, model: "qdrant/bm25", options: bm25Options },
            },
            payload: document,
          })),
        }),
        signal: AbortSignal.timeout(120_000),
      });
    }
  }

  async collectionStats(): Promise<QdrantCollectionStats> {
    const payload = await this.request(`/collections/${encodeURIComponent(this.collection)}`);
    const result = payload.result && typeof payload.result === "object"
      ? payload.result as Record<string, unknown>
      : {};
    const dense = this.denseCollectionConfig(payload);
    return {
      status: String(result.status || "unknown"),
      pointsCount: Number(result.points_count || 0),
      indexedVectorsCount: Number(result.indexed_vectors_count || 0),
      denseDatatype: dense.datatype,
      denseVectorsOnDisk: dense.onDisk,
      quantization: dense.quantization,
    };
  }

  async search(input: { query: string; kinds?: KnowledgeKind[]; limit?: number }): Promise<SearchHit[]> {
    const limit = Math.min(20, Math.max(1, input.limit || 8));
    const dense = await this.embedder.embedQuery(input.query);
    const must: Array<Record<string, unknown>> = [
      { key: "companyId", match: { value: this.companyId } },
    ];
    if (input.kinds?.length) must.push({ key: "kind", match: { any: input.kinds } });
    const payload = await this.request(`/collections/${encodeURIComponent(this.collection)}/points/query`, {
      method: "POST",
      body: JSON.stringify({
        prefetch: [
          {
            query: dense,
            using: "dense",
            limit: Math.max(20, limit * 3),
            filter: { must },
          },
          {
            query: { text: input.query, model: "qdrant/bm25", options: bm25Options },
            using: "bm25",
            limit: Math.max(20, limit * 3),
            filter: { must },
          },
        ],
        query: { rrf: { k: 60 } },
        limit,
        with_payload: true,
      }),
    });
    const result = payload.result && typeof payload.result === "object"
      ? payload.result as { points?: QdrantPoint[] }
      : {};
    const points = Array.isArray(payload.result)
      ? payload.result as QdrantPoint[]
      : result.points || [];
    return points.flatMap((point) => {
      const value = point.payload as Partial<KnowledgeDocument> | undefined;
      if (
        !value || typeof value.id !== "string" || typeof value.kind !== "string" ||
        typeof value.recordId !== "string" || typeof value.sourcePath !== "string" ||
        typeof value.title !== "string" || typeof value.text !== "string"
      ) return [];
      return [{
        id: value.id,
        companyId: String(value.companyId || this.companyId),
        kind: value.kind as KnowledgeKind,
        recordId: value.recordId,
        sourcePath: value.sourcePath,
        title: value.title,
        text: value.text,
        occurredAt: typeof value.occurredAt === "string" ? value.occurredAt : null,
        metadata: (value.metadata || {}) as KnowledgeDocument["metadata"],
        score: Number(point.score || 0),
        retrieval: "hybrid_rrf" as const,
      }];
    });
  }
}

export class RepositoryKnowledgeSearch implements KnowledgeSearch {
  constructor(
    private readonly repository: CompanyDataRepository,
    private readonly qdrant?: QdrantHybridSearch,
  ) {}

  async search(input: { query: string; kinds?: KnowledgeKind[]; limit?: number }): Promise<SearchHit[]> {
    if (this.qdrant) {
      try {
        const hits = await this.qdrant.search(input);
        if (hits.length) return hits;
      } catch (error) {
        console.warn("Qdrant search unavailable; using Firestore lexical fallback", error);
      }
    }
    const documents = await this.repository.allDocuments(input.kinds);
    return bm25Search(input.query, documents, input.limit || 8);
  }
}

export function qdrantConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { url: string; apiKey: string } | null {
  const url = environment.QDRANT_URL?.trim() || environment.QDRANT_CLUSTER_URL?.trim();
  const apiKey = environment.QDRANT_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

export function qdrantFromEnvironment(input: {
  repository: CompanyDataRepository;
  geminiApiKey: string;
}): { search: RepositoryKnowledgeSearch; qdrant?: QdrantHybridSearch } {
  const configuration = qdrantConfigurationFromEnvironment();
  const qdrant = configuration
    ? new QdrantHybridSearch(
      configuration.url,
      configuration.apiKey,
      new GeminiEmbedder(input.geminiApiKey),
    )
    : undefined;
  return { search: new RepositoryKnowledgeSearch(input.repository, qdrant), qdrant };
}
