import { db } from "./firestore.js";
import {
  FirestoreCompanyData,
  knowledgeKindForCollection,
} from "./agent/knowledge.js";
import { qdrantFromEnvironment } from "./agent/search.js";
import type { KnowledgeIndexDependencies } from "./knowledge-index-runtime.js";

export type KnowledgeSyncResult =
  | { skipped: true; reason: "collection_not_indexed" }
  | {
      skipped: false;
      kind: NonNullable<ReturnType<typeof knowledgeKindForCollection>>;
      recordId: string;
      action: "upserted" | "deleted";
      points: number;
    };

export async function synchronizeKnowledgeRecord(input: {
  collection: string;
  recordId: string;
  companyId?: string;
  geminiApiKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<KnowledgeSyncResult> {
  const kind = knowledgeKindForCollection(input.collection);
  if (!kind) return { skipped: true, reason: "collection_not_indexed" };

  if (!input.companyId) throw new Error("companyId is required for knowledge-index synchronization");
  const repository = new FirestoreCompanyData(input.database || db, input.companyId);
  const { qdrant } = qdrantFromEnvironment({
    geminiApiKey: input.geminiApiKey,
    companyId: input.companyId,
  });
  if (!qdrant) {
    throw new Error("QDRANT_URL and QDRANT_API_KEY are required for knowledge-index synchronization");
  }

  // Always re-read Firestore rather than trusting event ordering. Firestore is
  // authoritative, and background write events can be delivered more than once.
  const record = await repository.getRecord(kind, input.recordId);
  const result = await qdrant.synchronizeRecord({
    kind,
    recordId: input.recordId,
    record,
  });
  return {
    skipped: false,
    kind,
    recordId: input.recordId,
    ...result,
  };
}

export function createKnowledgeIndexDependencies(input: {
  geminiApiKey: string;
  database?: FirebaseFirestore.Firestore;
}): KnowledgeIndexDependencies {
  const database = input.database || db;
  return {
    database,
    synchronize: async (delivery) => {
      const result = await synchronizeKnowledgeRecord({
        ...delivery,
        database,
        geminiApiKey: input.geminiApiKey,
      });
      if (result.skipped) {
        throw new Error("A queued knowledge-index delivery no longer maps to an indexed collection");
      }
      return result;
    },
  };
}
