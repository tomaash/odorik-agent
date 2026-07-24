import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GeminiRestAgentModel } from "../agent/gemini.js";
import { runFactAgent } from "../agent/loop.js";
import { bm25Search, type KnowledgeSearch } from "../agent/search.js";
import { CompanyFactTools } from "../agent/tools.js";
import { FixtureCompanyData } from "./fixture-data.js";

type EvalCase = {
  id: string;
  question: string;
  expectedSourcePaths: string[];
  expectedTerms: string[];
  shouldAbstain?: boolean;
  retrieval?: boolean;
};

async function loadCases(): Promise<EvalCase[]> {
  const path = resolve(process.cwd(), "evals/fact-agent.json");
  return JSON.parse(await readFile(path, "utf8")) as EvalCase[];
}

async function retrievalEval(cases: EvalCase[], repository: FixtureCompanyData) {
  const documents = await repository.allDocuments();
  const relevantCases = cases.filter((item) => item.retrieval !== false && item.expectedSourcePaths.length);
  let hits = 0;
  let reciprocalRank = 0;
  for (const item of relevantCases) {
    const result = bm25Search(item.question, documents, 5);
    const rank = result.findIndex((hit) => item.expectedSourcePaths.includes(hit.sourcePath));
    if (rank >= 0) {
      hits += 1;
      reciprocalRank += 1 / (rank + 1);
    }
    console.log(`${rank >= 0 ? "PASS" : "FAIL"} retrieval ${item.id} rank=${rank < 0 ? "miss" : rank + 1}`);
  }
  return {
    cases: relevantCases.length,
    hitAt5: relevantCases.length ? hits / relevantCases.length : 0,
    mrr: relevantCases.length ? reciprocalRank / relevantCases.length : 0,
  };
}

async function liveAgentEval(cases: EvalCase[], repository: FixtureCompanyData, apiKey: string) {
  let passed = 0;
  const results = [];
  const documents = await repository.allDocuments();
  const fixtureSearch: KnowledgeSearch = {
    async search(input) {
      const selected = input.kinds?.length
        ? documents.filter((document) => input.kinds?.includes(document.kind))
        : documents;
      return bm25Search(input.query, selected, input.limit || 8);
    },
  };
  for (const item of cases) {
    const tools = new CompanyFactTools(repository, fixtureSearch);
    const answer = await runFactAgent({
      question: item.question,
      model: new GeminiRestAgentModel(apiKey),
      tools,
    });
    const normalized = answer.answer.toLocaleLowerCase();
    const termsPass = item.expectedTerms.every((term) => normalized.includes(term.toLocaleLowerCase()));
    const sources = new Set(answer.citations.map((citation) => citation.sourcePath));
    const sourcesPass = item.shouldAbstain
      ? answer.confidence === "low"
      : item.expectedSourcePaths.some((sourcePath) => sources.has(sourcePath));
    const grounded = item.shouldAbstain || answer.citations.length > 0;
    const pass = termsPass && sourcesPass && grounded;
    if (pass) passed += 1;
    results.push({ id: item.id, pass, confidence: answer.confidence, sources: [...sources] });
    console.log(`${pass ? "PASS" : "FAIL"} agent ${item.id}: ${answer.answer.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  return { cases: cases.length, passed, passRate: cases.length ? passed / cases.length : 0, results };
}

const cases = await loadCases();
const repository = new FixtureCompanyData();
const retrieval = await retrievalEval(cases, repository);
console.log(`Retrieval hit@5=${retrieval.hitAt5.toFixed(3)} MRR=${retrieval.mrr.toFixed(3)} (${retrieval.cases} cases)`);

if (process.argv.includes("--live")) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for --live evaluation");
  const agent = await liveAgentEval(cases, repository, apiKey);
  console.log(`Agent pass rate=${agent.passRate.toFixed(3)} (${agent.passed}/${agent.cases})`);
  if (agent.passRate < 0.8) process.exitCode = 1;
}

if (retrieval.hitAt5 < 0.8) process.exitCode = 1;
