import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(currentDirectory, "..", "index.js");

test("runner completes a local source-to-artifact smoke flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "erik-runner-smoke-"));
  const source = join(root, "source");
  const bundle = join(root, "source.bundle");
  const auth = join(root, "auth.json");
  const fakeGrok = join(root, "grok");
  const specPath = join(root, "run-spec.json");
  const artifactPath = join(root, "result.tar.gz");
  const workspace = join(root, "workspace");
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
  const bundleBytes = await readFile(bundle);
  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");

  await writeFile(auth, '{"cached_token":{"kind":"subscription-test"}}\n', { mode: 0o600 });
  await writeFile(
    fakeGrok,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "inspect" ]]; then
  printf '%s\\n' '{"hooks":[],"plugins":[],"marketplaces":[],"mcpServers":[],"permissions":{"sources":[]},"loginPolicy":{"apiKeyAuthDisabled":true}}'
  exit 0
fi
printf '%s\\n' 'after' > hello.txt
printf '%s\\n' '{"type":"result","status":"ok"}'
`,
  );
  await chmod(fakeGrok, 0o700);

  await writeFile(
    specPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "local-smoke",
      source: {
        downloadUrl: new URL(`file://${bundle}`).toString(),
        sha256: bundleSha256,
        baseSha,
      },
      task: { title: "Smoke test", prompt: "Change hello.txt." },
      agent: { maxTurns: 1 },
      artifacts: { uploadUrl: "https://upload.invalid/result" },
      limits: {
        maxSourceBytes: 10 * 1024 * 1024,
        maxArtifactBytes: 10 * 1024 * 1024,
        maxChangedFiles: 10,
        maxPatchBytes: 1024 * 1024,
      },
    })}\n`,
  );

  await exec(process.execPath, [runnerEntry], {
    env: {
      ...process.env,
      ALLOW_LOCAL_FILES: "true",
      ARTIFACT_OUTPUT_PATH: artifactPath,
      GROK_AUTH_SOURCE: auth,
      GROK_BINARY: fakeGrok,
      GROK_HOME: join(root, "grok-home"),
      RUN_ID: "local-smoke",
      RUN_SPEC_PATH: specPath,
      WORKSPACE_ROOT: workspace,
    },
  });

  const extracted = join(root, "extracted");
  await mkdir(extracted);
  await exec("tar", ["-xzf", artifactPath, "-C", extracted]);
  const result = JSON.parse(await readFile(join(extracted, "run-result.json"), "utf8")) as {
    status: string;
    git: { changedFiles: number };
    grok: { authKind: string };
  };
  assert.equal(result.status, "succeeded");
  assert.equal(result.git.changedFiles, 1);
  assert.equal(result.grok.authKind, "subscription_oauth");
});
