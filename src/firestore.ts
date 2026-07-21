import { Firestore, Timestamp } from "@google-cloud/firestore";
import { firestoreDatabaseId, projectId } from "./config.js";

let firestore: Firestore | undefined;

export function db(): Firestore {
  firestore ??= new Firestore({
    projectId: projectId(),
    databaseId: firestoreDatabaseId,
  });
  return firestore;
}

export function toJsonSafe(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toJsonSafe(child)]),
    );
  }
  return value;
}

