import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel, ModelTurn } from "../agent/gemini.js";
import { parseAgentFinal, runFactAgent } from "../agent/loop.js";
import {
  bm25Search,
  embeddingDimensions,
  embeddingModel,
  GeminiEmbedder,
  QdrantHybridSearch,
  QdrantRequiredSearch,
  qdrantCollection,
  qdrantConfigurationFromEnvironment,
  qdrantDenseVectorConfig,
  reciprocalRankFusion,
  SearchUnavailableError,
  searchUnavailableMessage,
  type KnowledgeSearch,
} from "../agent/search.js";
import { CitationRegistry, CompanyFactTools, type AgentToolExecutor } from "../agent/tools.js";
import type { KnowledgeDocument } from "../agent/types.js";

test("BM25 finds exact company names and identifiers", () => {
  const documents: KnowledgeDocument[] = [
    {
      id: "contact:eva:0",
      companyId: "default",
      kind: "contact",
      recordId: "eva",
      sourcePath: "contacts/eva",
      title: "Eva Nováková",
      text: "phoneE164: +420777123456",
      occurredAt: null,
      metadata: {},
    },
    {
      id: "contact:petr:0",
      companyId: "default",
      kind: "contact",
      recordId: "petr",
      sourcePath: "contacts/petr",
      title: "Petr Svoboda",
      text: "phoneE164: +420606555444",
      occurredAt: null,
      metadata: {},
    },
  ];
  const result = bm25Search("telefon Eva Novakova", documents, 2);
  assert.equal(result[0]?.recordId, "eva");
});

test("RRF combines rankings without comparing incompatible raw scores", () => {
  const result = reciprocalRankFusion(
    [
      [{ item: "dense-only", score: 0.99 }, { item: "both", score: 0.2 }],
      [{ item: "both", score: 120 }, { item: "lexical-only", score: 100 }],
    ],
    (item) => item,
    { k: 60 },
  );
  assert.equal(result[0]?.item, "both");
});

test("Qdrant configuration supports deployed and local URL variable names", () => {
  assert.deepEqual(qdrantConfigurationFromEnvironment({
    QDRANT_URL: " https://deployed.example ",
    QDRANT_CLUSTER_URL: "https://local.example",
    QDRANT_API_KEY: " key ",
  }), {
    url: "https://deployed.example",
    apiKey: "key",
  });
  assert.deepEqual(qdrantConfigurationFromEnvironment({
    QDRANT_CLUSTER_URL: " https://local.example/ ",
    QDRANT_API_KEY: " local-key ",
  }), {
    url: "https://local.example/",
    apiKey: "local-key",
  });
  assert.equal(qdrantConfigurationFromEnvironment({ QDRANT_URL: "https://missing-key.example" }), null);
});

test("company search fails closed when Qdrant is not configured", async () => {
  const search = new QdrantRequiredSearch();
  await assert.rejects(
    search.search({ query: "Eva" }),
    (error) => error instanceof SearchUnavailableError
      && error.message === searchUnavailableMessage,
  );
});

test("an empty Qdrant result remains empty without a Firestore scan", async () => {
  const qdrant = {
    search: async () => [],
  } satisfies KnowledgeSearch;
  const search = new QdrantRequiredSearch(qdrant);
  assert.deepEqual(await search.search({ query: "not present" }), []);
});

test("a Qdrant failure is normalized without leaking provider details", async () => {
  const qdrant = {
    search: async () => {
      throw new Error("internal endpoint detail");
    },
  } satisfies KnowledgeSearch;
  const search = new QdrantRequiredSearch(qdrant);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await assert.rejects(
      search.search({ query: "Eva" }),
      (error) => error instanceof SearchUnavailableError
        && error.message === searchUnavailableMessage
        && !error.message.includes("endpoint"),
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("a missing Qdrant search becomes a stable temporary-unavailable tool result", async () => {
  const tools = new CompanyFactTools({} as never, new QdrantRequiredSearch());
  assert.deepEqual(await tools.execute("search_company_data", { query: "Eva" }), {
    result: {
      available: false,
      error: searchUnavailableMessage,
      matches: [],
    },
    citationIds: [],
  });
});

test("Gemini Embedding 2 uses 1536 dimensions and retrieval prompt prefixes", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      embedding: { values: Array.from({ length: embeddingDimensions }, () => 0.01) },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const embedder = new GeminiEmbedder("test-key");
    await embedder.embedDocument({
      id: "contact:eva:0",
      companyId: "default",
      kind: "contact",
      recordId: "eva",
      sourcePath: "contacts/eva",
      title: "Eva Nováková",
      text: "phoneE164: +420777123456",
      occurredAt: null,
      metadata: {},
    });
    await embedder.embedQuery("Who is Eva?");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(embeddingModel, "gemini-embedding-2");
  assert.equal(embeddingDimensions, 1536);
  assert.equal(requests[0]?.outputDimensionality, 1536);
  assert.match(JSON.stringify(requests[0]), /title: Eva Nováková \\| text:/);
  assert.match(JSON.stringify(requests[1]), /task: search result \\| query: Who is Eva\\?/);
  assert.doesNotMatch(JSON.stringify(requests), /taskType/);
});

test("Qdrant uses one float16 dense-vector representation", () => {
  assert.equal(qdrantCollection, "company_context_v4");
  assert.deepEqual(qdrantDenseVectorConfig, {
    size: 1536,
    distance: "Cosine",
    datatype: "float16",
  });
});

test("record synchronization removes stale chunks before upserting the current projection", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      path,
      method: init?.method || "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    return new Response(JSON.stringify({
      result: {
        config: {
          params: {
            vectors: {
              dense: qdrantDenseVectorConfig,
            },
          },
          quantization_config: null,
        },
      },
      status: "ok",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const search = new QdrantHybridSearch(
      "https://qdrant.test",
      "test-key",
      {
        dimensions: 1536,
        embedDocument: async () => Array.from({ length: 1536 }, () => 0.01),
        embedQuery: async () => Array.from({ length: 1536 }, () => 0.01),
      },
    );
    const result = await search.synchronizeRecord({
      kind: "contact",
      recordId: "eva",
      record: {
        kind: "contact",
        recordId: "eva",
        sourcePath: "contacts/eva",
        title: "Eva Nováková",
        occurredAt: null,
        data: { phoneE164: "+420777123456" },
      },
    });
    assert.deepEqual(result, { action: "upserted", points: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const deletion = requests.find((request) => request.path.endsWith("/points/delete"));
  const upsert = requests.find((request) => request.path.endsWith("/points") && request.method === "PUT");
  const collectionUpdate = requests.find((request) => request.path.endsWith(`/${qdrantCollection}`)
    && request.method === "PATCH");
  assert.equal(collectionUpdate, undefined);
  assert.ok(deletion);
  assert.match(JSON.stringify(deletion.body), /recordId/);
  assert.match(JSON.stringify(deletion.body), /eva/);
  assert.ok(upsert);
  assert.match(JSON.stringify(upsert.body), /contact:eva:0/);
});

test("fresh Qdrant collections use float16 without scalar quantization", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method || "GET";
    requests.push({
      path,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    if (method === "GET") {
      return new Response(JSON.stringify({ status: { error: "Not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ result: true, status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const search = new QdrantHybridSearch(
      "https://qdrant.test",
      "test-key",
      {
        dimensions: 1536,
        embedDocument: async () => Array.from({ length: 1536 }, () => 0.01),
        embedQuery: async () => Array.from({ length: 1536 }, () => 0.01),
      },
    );
    await search.ensureCollection();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const creation = requests.find((request) => request.path.endsWith(`/${qdrantCollection}`)
    && request.method === "PUT");
  assert.ok(creation);
  const vectors = creation.body?.vectors as Record<string, unknown>;
  assert.deepEqual(vectors.dense, qdrantDenseVectorConfig);
  assert.equal(creation.body?.quantization_config, undefined);
});

test("dense prefetch searches float16 vectors without quantization parameters", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      path,
      method: init?.method || "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    return new Response(JSON.stringify({
      result: path.endsWith("/points/query")
        ? { points: [] }
        : {
            config: {
              params: { vectors: { dense: qdrantDenseVectorConfig } },
              quantization_config: null,
            },
          },
      status: "ok",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const search = new QdrantHybridSearch(
      "https://qdrant.test",
      "test-key",
      {
        dimensions: 1536,
        embedDocument: async () => Array.from({ length: 1536 }, () => 0.01),
        embedQuery: async () => Array.from({ length: 1536 }, () => 0.01),
      },
    );
    assert.deepEqual(await search.search({ query: "Christmas holiday", limit: 5 }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const query = requests.find((request) => request.path.endsWith("/points/query"));
  assert.ok(query);
  const prefetch = query.body?.prefetch as Array<Record<string, unknown>>;
  assert.equal(prefetch[0]?.params, undefined);
  assert.equal(prefetch[1]?.params, undefined);
});

test("parses structured final answers and recovers citation IDs from plain text", () => {
  assert.deepEqual(parseAgentFinal(JSON.stringify({
    answer: "The request is open [C1].",
    citationIds: ["C1"],
    confidence: "high",
    limitations: [],
  })).citationIds, ["C1"]);
  assert.deepEqual(parseAgentFinal("The request is open [C2].").citationIds, ["C2"]);
});

class ScriptedModel implements AgentModel {
  private index = 0;

  constructor(private readonly turns: ModelTurn[]) {}

  async generate(): Promise<ModelTurn> {
    const turn = this.turns[this.index++];
    if (!turn) throw new Error("Script exhausted");
    return turn;
  }
}

class FakeTools implements AgentToolExecutor {
  readonly citations = new CitationRegistry();

  async execute(name: string): Promise<{ result: Record<string, unknown>; citationIds: string[] }> {
    assert.equal(name, "search_company_data");
    const citation = this.citations.add({
      kind: "contact",
      recordId: "eva",
      sourcePath: "contacts/eva",
      title: "Eva Nováková",
      excerpt: "phoneE164: +420777123456",
      occurredAt: null,
    });
    return {
      result: { matches: [{ citationId: citation.citationId, phone: "+420777123456" }] },
      citationIds: [citation.citationId],
    };
  }
}

const zeroUsage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };

test("agent executes a tool and returns only citations seen in this run", async () => {
  const answer = await runFactAgent({
    question: "What is Eva's phone number?",
    model: new ScriptedModel([
      {
        content: {
          role: "model",
          parts: [{ functionCall: { id: "call-1", name: "search_company_data", args: { query: "Eva phone" } } }],
        },
        usage: zeroUsage,
      },
      {
        content: {
          role: "model",
          parts: [{ text: JSON.stringify({
            answer: "Eva's phone number is +420777123456 [C1]. Phantom [C9].",
            citationIds: ["C1", "C9"],
            confidence: "high",
            limitations: [],
          }) }],
        },
        usage: zeroUsage,
      },
    ]),
    tools: new FakeTools(),
  });
  assert.deepEqual(answer.citations.map((citation) => citation.citationId), ["C1"]);
  assert.match(answer.answer, /\[unverified citation\]/);
  assert.equal(answer.toolTrace.length, 1);
});
