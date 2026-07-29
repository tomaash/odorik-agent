import { createHash } from "node:crypto";

/**
 * Hex SHA-256 of a UTF-8 string.
 *
 * Used for opaque document IDs, provenance checksums, and OAuth state lookup
 * keys. It is a content digest, not a password hash: never use it to store a
 * secret that must resist an offline guessing attack.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
