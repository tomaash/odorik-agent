import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firestore.js";

/**
 * The single shape in which connectors record synchronization state.
 *
 * `repository.ts` renders the Sources screen from exactly these fields:
 * `itemCount`, `lastObservedAt`, and `lastSyncAt` on a resource, and
 * `stats.*` on a connection. Adapters that invented their own nesting
 * silently reported zero items and no sync time, so every adapter now writes
 * through these helpers instead of hand-rolling the write.
 */

const activeStatuses = ["active", "attention"];

export async function writeResourceSyncState(input: {
  resource: FirebaseFirestore.DocumentReference;
  itemCount: number;
  /** Adapter-specific fields, such as a Calendar sync token. */
  extra?: Record<string, unknown>;
}): Promise<void> {
  await input.resource.set({
    ...input.extra,
    itemCount: input.itemCount,
    lastSyncAt: FieldValue.serverTimestamp(),
    lastObservedAt: FieldValue.serverTimestamp(),
    lastError: null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Record a successful connection sync.
 *
 * Returns false when the connection was disconnected or deleted while the
 * sync was running; the caller should treat that as a failed sync rather than
 * resurrecting a connection the user has since turned off.
 */
export async function markConnectionSynced(input: {
  connection: FirebaseFirestore.DocumentReference;
  itemCount: number;
}): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const current = await transaction.get(input.connection);
    if (!current.exists || !activeStatuses.includes(String(current.data()?.status))) {
      return false;
    }
    transaction.set(input.connection, {
      status: "active",
      stats: {
        itemCount: input.itemCount,
        lastSyncAt: FieldValue.serverTimestamp(),
        lastObservedAt: FieldValue.serverTimestamp(),
        lastError: null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
}

/** Move a connection to `attention` and retain the error the user should see. */
export async function markConnectionAttention(input: {
  connection: FirebaseFirestore.DocumentReference;
  error: unknown;
}): Promise<void> {
  const message = (
    input.error instanceof Error ? input.error.message : String(input.error)
  ).slice(0, 1500);
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(input.connection);
    if (!current.exists || !activeStatuses.includes(String(current.data()?.status))) return;
    transaction.set(input.connection, {
      status: "attention",
      stats: { lastError: message },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}
