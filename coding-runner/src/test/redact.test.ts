import assert from "node:assert/strict";
import test from "node:test";
import { findLikelySecret, redactSecrets } from "../redact.js";

test("redactSecrets removes common credential shapes", () => {
  const input = [
    "Authorization: Bearer secret-value",
    `xai-${"a".repeat(32)}`,
    `ghp_${"b".repeat(36)}`,
    `eyJ${"c".repeat(20)}.${"d".repeat(20)}.${"e".repeat(20)}`,
  ].join("\n");
  const output = redactSecrets(input);
  assert.doesNotMatch(output, /secret-value|xai-|ghp_|eyJ/);
  assert.match(output, /REDACTED/);
});

test("findLikelySecret blocks private keys", () => {
  const value = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  assert.match(findLikelySecret(value) ?? "", /PRIVATE KEY/);
});
