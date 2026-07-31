import assert from "node:assert/strict";
import test from "node:test";
import { parseRunSpec } from "../spec.js";

function validSpec() {
  return {
    schemaVersion: 1,
    runId: "run_123",
    source: {
      downloadUrl: "https://storage.example/source.bundle?signature=secret",
      sha256: "a".repeat(64),
      baseSha: "b".repeat(40),
    },
    task: { title: "Fix the widget", prompt: "Implement the issue." },
    artifacts: { uploadUrl: "https://storage.example/result.tgz?signature=secret" },
  };
}

test("parseRunSpec applies bounded defaults", () => {
  const parsed = parseRunSpec(validSpec());
  assert.equal(parsed.agent.maxTurns, 30);
  assert.equal(parsed.limits.maxChangedFiles, 300);
  assert.equal(parsed.limits.maxPatchBytes, 10 * 1024 * 1024);
});

test("parseRunSpec rejects non-HTTPS production URLs", () => {
  const value = validSpec();
  value.source.downloadUrl = "http://storage.example/source.bundle";
  assert.throws(() => parseRunSpec(value), /must use HTTPS/);
});

test("parseRunSpec rejects unbounded agent turns", () => {
  const value = { ...validSpec(), agent: { maxTurns: 101 } };
  assert.throws(() => parseRunSpec(value), /between 1 and 100/);
});

test("parseRunSpec rejects malformed run IDs and checksums", () => {
  assert.throws(() => parseRunSpec({ ...validSpec(), runId: "../escape" }), /invalid format/);
  const value = validSpec();
  value.source.sha256 = "not-a-checksum";
  assert.throws(() => parseRunSpec(value), /invalid format/);
});
