import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModel, ModelTurn } from "../agent/gemini.js";
import { parseAgentFinal, runFactAgent } from "../agent/loop.js";
import {
  bm25Search,
  qdrantConfigurationFromEnvironment,
  reciprocalRankFusion,
} from "../agent/search.js";
import { CitationRegistry, type AgentToolExecutor } from "../agent/tools.js";
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
