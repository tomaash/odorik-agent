import { createDecipheriv } from "node:crypto";

type EncryptedEnvelope = {
  v: 1;
  alg: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
};

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("CONNECTOR_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function decryptCredentials(
  encrypted: string,
  encodedKey: string,
): Record<string, string> {
  const parsed = JSON.parse(
    Buffer.from(encrypted, "base64url").toString("utf8"),
  ) as EncryptedEnvelope;
  if (parsed.v !== 1 || parsed.alg !== "A256GCM") {
    throw new Error("Unsupported connector credential envelope");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeKey(encodedKey),
    Buffer.from(parsed.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
    decipher.final(),
  ]);
  const value = JSON.parse(plaintext.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid connector credentials");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, String(child)]),
  );
}

