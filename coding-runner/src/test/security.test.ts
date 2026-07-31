import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSubscriptionOnlyEnvironment,
  inspectRepositoryConfiguration,
} from "../security.js";

test("the runner refuses xAI API-key authentication", () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "xai-this-must-never-be-used";
  try {
    assert.throws(() => assertSubscriptionOnlyEnvironment(), /subscription OAuth only/);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("repository-provided Grok extensions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "erik-runner-security-"));
  const repository = join(root, "repo");
  const fakeGrok = join(root, "grok");
  await mkdir(repository);
  await writeFile(
    fakeGrok,
    `#!/usr/bin/env bash
printf '%s\\n' '{"hooks":[],"plugins":[],"marketplaces":[],"mcpServers":[{"name":"untrusted"}],"permissions":{"sources":[]}}'
`,
  );
  await chmod(fakeGrok, 0o700);
  await assert.rejects(
    inspectRepositoryConfiguration(fakeGrok, repository, process.env),
    /discovered MCP servers/,
  );
});

test("Grok inspection must confirm subscription-only authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "erik-runner-auth-policy-"));
  const repository = join(root, "repo");
  const fakeGrok = join(root, "grok");
  await mkdir(repository);
  await writeFile(
    fakeGrok,
    `#!/usr/bin/env bash
printf '%s\\n' '{"hooks":[],"plugins":[],"marketplaces":[],"mcpServers":[],"permissions":{"sources":[]},"loginPolicy":{"apiKeyAuthDisabled":false}}'
`,
  );
  await chmod(fakeGrok, 0o700);
  await assert.rejects(
    inspectRepositoryConfiguration(fakeGrok, repository, process.env),
    /did not disable API-key authentication/,
  );
});
