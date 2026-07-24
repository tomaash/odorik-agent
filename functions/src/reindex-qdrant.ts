import { createHash } from "node:crypto";

function corpusChecksum(documents: Array<{ id: string; text: string }>): string {
  const hash = createHash("sha256");
  for (const document of [...documents].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(document.id);
    hash.update("\0");
    hash.update(document.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
if (!geminiApiKey) throw new Error("GEMINI_API_KEY is required");

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim() || "odorik-tx-260720-c58d";
const [{ FirestoreCompanyData }, {
  embeddingDimensions,
  embeddingModel,
  qdrantCollection,
  qdrantFromEnvironment,
}, { db }] = await Promise.all([
  import("./agent/knowledge.js"),
  import("./agent/search.js"),
  import("./firestore.js"),
]);

const repository = new FirestoreCompanyData(db);
const { qdrant } = qdrantFromEnvironment({ repository, geminiApiKey });
if (!qdrant) {
  throw new Error("QDRANT_URL (or QDRANT_CLUSTER_URL) and QDRANT_API_KEY are required");
}

const documents = await repository.allDocuments();
if (documents.length === 0) throw new Error("No eligible Firestore documents were found");

const expectedChecksum = corpusChecksum(documents);
const indexed = await qdrant.replaceDocuments(documents);
const stats = await qdrant.collectionStats();
if (stats.pointsCount !== indexed) {
  throw new Error(`Qdrant reconciliation failed: expected ${indexed} points, found ${stats.pointsCount}`);
}

const probe = documents.find((document) => document.kind === "contact") || documents[0]!;
const probeHits = await qdrant.search({ query: probe.title, limit: 5 });
if (!probeHits.some((hit) => hit.sourcePath === probe.sourcePath)) {
  throw new Error(`Qdrant retrieval probe did not return ${probe.sourcePath}`);
}

console.log(JSON.stringify({
  collection: qdrantCollection,
  embeddingModel,
  embeddingDimensions,
  documents: documents.length,
  points: stats.pointsCount,
  indexedVectors: stats.indexedVectorsCount,
  status: stats.status,
  scalarQuantization: stats.scalarQuantization,
  corpusChecksum: expectedChecksum,
  retrievalProbe: {
    query: probe.title,
    expectedSourcePath: probe.sourcePath,
    rank: probeHits.findIndex((hit) => hit.sourcePath === probe.sourcePath) + 1,
  },
}, null, 2));
