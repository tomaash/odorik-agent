import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel, ModelTurn } from "../agent/gemini.js";
import { parseAgentFinal, runFactAgent } from "../agent/loop.js";
import { chunkRecord, extractRecordMetadata, presentRecordForAgent } from "../agent/knowledge.js";
import {
  bm25Search,
  embeddingDimensions,
  embeddingModel,
  GeminiEmbedder,
  QdrantHybridSearch,
  QdrantRequiredSearch,
  qdrantCollection,
  getQdrantCollection,
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

test("case citations open the dedicated case workspace", () => {
  assert.equal(extractRecordMetadata({
    kind: "case",
    recordId: "case-1",
    sourcePath: "companies/default/cases/case-1",
    title: "Renew ACME",
    occurredAt: null,
    data: { stageId: "follow_up", contactId: "contact-1" },
  }).internalRoute, "/cases/case-1");
});

test("gmail context items cite as gmail with a deep link, not generic google", () => {
  const mailUrl = "https://mail.google.com/mail/u/0/#all/msg-quote-1";
  const record = {
    kind: "context_item" as const,
    recordId: "ctx_mail_msg-quote-1",
    sourcePath: "companies/explorers/contextItems/ctx_mail_msg-quote-1",
    title: "Quote for renewal",
    occurredAt: "2026-08-03T09:30:00.000Z",
    data: {
      // G1 stores capability + provider only; no source.adapterId.
      source: {
        providerId: "google",
        capabilityId: "context.mail.read_scoped",
        connectionId: "google-1",
        resourceId: "label:Label_7",
        externalId: "msg-quote-1",
        version: "8801",
      },
      text: "Label: Customers\nFrom: sender@example.com\nBody:\nPlease find the renewal quote.",
      artifactRefs: [],
      metadata: {
        sourceUrl: mailUrl,
        subject: "Quote for renewal",
        threadId: "thread-msg-quote-1",
      },
    },
  };
  const meta = extractRecordMetadata(record);
  assert.equal(meta.adapterId, "gmail");
  assert.equal(meta.externalUrl, mailUrl);
  assert.equal(meta.internalRoute, null);

  // Indexed chunks must carry the same presentation so hybrid search citations stay typed.
  const [chunk] = chunkRecord(record, "explorers");
  assert.ok(chunk);
  assert.equal(chunk.metadata?.adapterId, "gmail");
  assert.equal(chunk.metadata?.externalUrl, mailUrl);
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

test("search tools authorize vector hits again before creating citations", async () => {
  const hit = {
    id: "company-a:context_item:secret:0",
    companyId: "company-a",
    kind: "context_item" as const,
    recordId: "secret",
    sourcePath: "companies/company-a/contextItems/secret",
    title: "Restricted plan",
    text: "Restricted plan\n\nDo not disclose",
    occurredAt: null,
    metadata: {},
    score: 0.9,
    retrieval: "hybrid_rrf" as const,
  };
  const tools = new CompanyFactTools({
    getRecord: async () => null,
  } as never, {
    search: async () => [hit],
  });
  assert.deepEqual(await tools.execute("search_company_data", { query: "plan" }), {
    result: { matches: [] },
    citationIds: [],
  });
  assert.deepEqual(tools.citations.all(), []);
});

test("Qdrant search applies member eligibility to dense and lexical paths and rejects bad payloads", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      result: {
        points: [{
          id: "point-a",
          score: 0.9,
          payload: {
            id: "company-a:context_item:secret:0",
            companyId: "company-a",
            kind: "context_item",
            recordId: "secret",
            sourcePath: "companies/company-a/contextItems/secret",
            title: "Secret",
            text: "Secret",
            occurredAt: null,
            accessVisibility: "restricted",
            accessMemberIds: ["member-b"],
            metadata: {},
          },
        }],
      },
      status: "ok",
    }), { status: 200, headers: { "content-type": "application/json" } });
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
      "company-a",
      qdrantCollection,
      "member-a",
    );
    assert.deepEqual(await search.search({ query: "secret" }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const prefetch = requests[0]?.prefetch as Array<{ filter?: unknown }>;
  assert.equal(prefetch.length, 2);
  for (const path of prefetch) {
    assert.match(JSON.stringify(path.filter), /accessVisibility/);
    assert.match(JSON.stringify(path.filter), /accessMemberIds/);
    assert.match(JSON.stringify(path.filter), /member-a/);
  }
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

test("Qdrant uses one float16 dense-vector representation and environment-aware collection naming", () => {
  assert.equal(getQdrantCollection({}), "company_context_v5");
  assert.equal(getQdrantCollection({ FUNCTIONS_EMULATOR: "true" }), "company_context_dev_v5");
  assert.equal(getQdrantCollection({ QDRANT_COLLECTION: "custom_context_v1" }), "custom_context_v1");
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
      "default",
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
  assert.match(JSON.stringify(upsert.body), /default:contact:eva:0/);
  assert.deepEqual(
    ((deletion.body?.filter as Record<string, unknown>)?.must as Array<Record<string, unknown>>)
      .map((condition) => condition.key),
    ["companyId", "kind", "recordId"],
  );
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
      "default",
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
  const companyIndex = requests.find((request) => (
    request.path.endsWith("/index")
    && request.body?.field_name === "companyId"
  ));
  assert.deepEqual(companyIndex?.body?.field_schema, {
    type: "keyword",
    is_tenant: true,
  });
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
      "default",
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
  assert.match(JSON.stringify(prefetch), /"companyId"/);
  assert.match(JSON.stringify(prefetch), /"default"/);
});

test("tenant chunk IDs are distinct for the same record and Qdrant rejects mixed-tenant writes", async () => {
  const record = {
    kind: "contact" as const,
    recordId: "same-id",
    sourcePath: "contacts/same-id",
    title: "Same contact",
    occurredAt: null,
    data: { email: "person@example.com" },
  };
  const alpha = chunkRecord(record, "alpha");
  const beta = chunkRecord(record, "beta");
  assert.notEqual(alpha[0]?.id, beta[0]?.id);
  assert.equal(alpha[0]?.companyId, "alpha");
  assert.equal(beta[0]?.companyId, "beta");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: {
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
  try {
    const search = new QdrantHybridSearch(
      "https://qdrant.test",
      "test-key",
      {
        dimensions: 1536,
        embedDocument: async () => Array.from({ length: 1536 }, () => 0.01),
        embedQuery: async () => Array.from({ length: 1536 }, () => 0.01),
      },
      "alpha",
    );
    await assert.rejects(
      search.replaceTenantDocuments(beta),
      /outside the active company/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qdrant drops payloads from another company even if the provider returns them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    return new Response(JSON.stringify({
      result: path.endsWith("/points/query")
        ? {
            points: [{
              score: 1,
              payload: {
                id: "beta:contact:same-id:0",
                companyId: "beta",
                kind: "contact",
                recordId: "same-id",
                sourcePath: "companies/beta/contacts/same-id",
                title: "Private beta contact",
                text: "Must not cross the tenant boundary",
              },
            }],
          }
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
      "alpha",
    );
    assert.deepEqual(await search.search({ query: "private contact" }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("default search kinds exclude audit events and include coding runs", async () => {
  let seenKinds: string[] | undefined;
  const search: KnowledgeSearch = {
    async search(input) {
      seenKinds = input.kinds?.map(String);
      return [];
    },
  };
  const tools = new CompanyFactTools({
    async allDocuments() { return []; },
    async getRecord() { return null; },
    async listRecords() { return []; },
    async aggregateRecords() { return { total: 0 }; },
  }, search);

  await tools.execute("search_company_data", { query: "what did we code" });
  assert.deepEqual(seenKinds, [
    "call",
    "contact",
    "task",
    "case",
    "context_item",
    "coding_run",
  ]);
  assert.ok(!seenKinds?.includes("audit_event"));

  await tools.execute("search_company_data", {
    query: "why stage changed",
    kinds: ["audit_event"],
  });
  assert.deepEqual(seenKinds, ["audit_event"]);
});

test("metadata-only Drive context is not indexed as connector plumbing", () => {
  const record = {
    kind: "context_item" as const,
    recordId: "drive_abc",
    sourcePath: "companies/acme/contextItems/drive_abc",
    title: "C5-DRIVE-SCHEDULED-FRESHNESS-20260802",
    occurredAt: "2026-08-02T12:00:00.000Z",
    data: {
      kind: "drive.file",
      text: [
        "Type: application/vnd.google-apps.document",
        "Size: 1024",
        "Modified: 2026-08-02T12:00:00.000Z",
      ].join("\n"),
      metadata: {
        mimeType: "application/vnd.google-apps.document",
        size: "1024",
        folderId: "0B98TTk9YjihyenJnOGFleEtreDA",
        sourceUrl: "https://docs.google.com/document/d/example",
      },
      provenance: {
        ingestionVersion: "google-drive-v2",
        checksum: "deadbeef",
      },
    },
  };
  const [chunk] = chunkRecord(record, "acme");
  assert.ok(chunk);
  assert.match(chunk.text, /content was not extracted/i);
  assert.doesNotMatch(chunk.text, /1024/);
  assert.doesNotMatch(chunk.text, /google-drive-v2/);
  assert.doesNotMatch(chunk.text, /0B98TTk9YjihyenJnOGFleEtreDA/);
  assert.equal(chunk.metadata.contentQuality, "metadata_only");

  const presented = presentRecordForAgent(record);
  assert.equal(presented.contentQuality, "metadata_only");
  assert.equal(presented.provenance, undefined);
  assert.doesNotMatch(String(presented.text || ""), /1024/);
  const meta = presented.metadata as Record<string, unknown>;
  assert.equal(meta.size, undefined);
  assert.equal(meta.folderId, undefined);
  assert.equal(meta.sourceUrl, "https://docs.google.com/document/d/example");
});

test("coding run chunks expose shipped outcome substance for product questions", () => {
  const record = {
    kind: "coding_run" as const,
    recordId: "coding_" + "a".repeat(32),
    sourcePath: "companies/acme/codingRuns/coding_" + "a".repeat(32),
    title: "Keep the parser total · succeeded",
    occurredAt: "2026-08-01T21:13:00.000Z",
    data: {
      status: "succeeded",
      phase: "succeeded",
      github: {
        owner: "tomaash",
        repo: "elixir-play",
        issueNumber: 17,
        issueUrl: "https://github.com/tomaash/elixir-play/issues/17",
      },
      issueSnapshot: {
        title: "[tomaash/elixir-play #17] Keep the parser total",
        text: "Repository: tomaash/elixir-play\nIssue: #17\n\nThe parser throws on empty input.",
      },
      result: {
        changedFiles: 2,
        changedPaths: ["lib/parser.ex", "test/parser_test.exs"],
      },
      publicationResult: {
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/tomaash/elixir-play/pull/42",
      },
      git: {
        proposedBranch: "erik/issue-17-abcd1234",
        resultSha: "b".repeat(40),
      },
    },
  };
  const [chunk] = chunkRecord(record, "acme");
  assert.ok(chunk);
  assert.match(chunk.text, /Changed paths/);
  assert.match(chunk.text, /lib\/parser\.ex/);
  assert.match(chunk.text, /pull\/42/);
  assert.match(chunk.text, /parser throws on empty input/);
  assert.doesNotMatch(chunk.text, /dispatcher-queued/);
  assert.equal(extractRecordMetadata(record).adapterId, "github");
  assert.equal(
    extractRecordMetadata(record).externalUrl,
    "https://github.com/tomaash/elixir-play/pull/42",
  );

  // Outcome text should rank for "what did we code" style queries over empty audit noise.
  const auditNoise: KnowledgeDocument = {
    id: "audit",
    companyId: "acme",
    kind: "audit_event",
    recordId: "coding_phase",
    sourcePath: "auditEvents/coding_phase",
    title: "coding.running · dispatcher-queued",
    text: "Audit event · coding_coding_78d_dispatcher-queued\neventType: coding.running\nphase: dispatcher-queued",
    occurredAt: "2026-08-01T21:13:00.000Z",
    metadata: {},
  };
  const hits = bm25Search("what code did we implement for the parser", [chunk!, auditNoise], 2);
  assert.equal(hits[0]?.kind, "coding_run");
  assert.equal(hits[0]?.recordId, record.recordId);
});

test("document body context remains searchable content", () => {
  const record = {
    kind: "context_item" as const,
    recordId: "drive_doc",
    sourcePath: "companies/acme/contextItems/drive_doc",
    title: "Refund policy",
    occurredAt: null,
    data: {
      text: "Customers may request a refund within 14 days of purchase.",
      metadata: { mimeType: "application/vnd.google-apps.document", size: "2048" },
    },
  };
  const [chunk] = chunkRecord(record, "acme");
  assert.match(chunk!.text, /refund within 14 days/i);
  assert.equal(chunk!.metadata.contentQuality, null);
});
