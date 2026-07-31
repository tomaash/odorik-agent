import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cloneBundle, createChangeArtifacts } from "../git.js";
import type { CodingRunSpec } from "../spec.js";

const exec = promisify(execFile);

test("a clean source bundle becomes an auditable result bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "erik-runner-git-"));
  const source = join(root, "source");
  const bundle = join(root, "source.bundle");
  const clone = join(root, "clone");
  const artifacts = join(root, "artifacts");
  await mkdir(source);
  await exec("git", ["init", "--initial-branch=main"], { cwd: source });
  await exec("git", ["config", "user.name", "Test"], { cwd: source });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await writeFile(join(source, "hello.txt"), "before\n");
  await exec("git", ["add", "hello.txt"], { cwd: source });
  await exec("git", ["commit", "-m", "base"], { cwd: source });
  const { stdout: shaOutput } = await exec("git", ["rev-parse", "HEAD"], { cwd: source });
  const baseSha = shaOutput.trim();
  await exec("git", ["bundle", "create", bundle, "HEAD"], { cwd: source });

  await cloneBundle(bundle, clone, baseSha);
  await writeFile(join(clone, "hello.txt"), "after\n");
  await writeFile(join(clone, "new.txt"), "new\n");

  const spec: CodingRunSpec = {
    schemaVersion: 1,
    runId: "test-run",
    source: {
      downloadUrl: "https://example.invalid/source.bundle",
      sha256: "a".repeat(64),
      baseSha,
    },
    task: { title: "Test", prompt: "Test" },
    agent: { maxTurns: 1 },
    artifacts: { uploadUrl: "https://example.invalid/result.tgz" },
    limits: {
      maxSourceBytes: 1024 * 1024,
      maxArtifactBytes: 1024 * 1024,
      maxChangedFiles: 10,
      maxPatchBytes: 1024 * 1024,
    },
  };
  const result = await createChangeArtifacts(clone, artifacts, spec);
  assert.equal(result.hasChanges, true);
  assert.equal(result.changedFiles, 2);
  assert.notEqual(result.resultSha, baseSha);
  assert.match(await readFile(join(artifacts, "changes.patch"), "utf8"), /new\.txt/);
  await exec("git", ["bundle", "verify", join(artifacts, "result.bundle")], { cwd: clone });
});
