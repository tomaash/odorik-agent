import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareDependencies } from "../dependencies.js";

const exec = promisify(execFile);

test("repository dependency metadata is never executed by the supervisor", async () => {
  const repository = await mkdtemp(join(tmpdir(), "erik-runner-deps-"));
  await exec("git", ["init"], { cwd: repository });
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { preinstall: "node -e \"require('fs').writeFileSync('pwned','yes')\"" },
    })}\n`,
  );
  await writeFile(
    join(repository, "package-lock.json"),
    `${JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fixture", version: "1.0.0", hasInstallScript: true } },
    })}\n`,
  );

  const result = await prepareDependencies(repository);
  assert.equal(result.kind, "unavailable");
  assert.equal(await readFile(join(repository, "package.json"), "utf8").then((value) => value.includes("pwned")), true);
  assert.match(await readFile(join(repository, ".git", "info", "exclude"), "utf8"), /node_modules/);

  await mkdir(join(repository, "node_modules"));
  assert.equal((await prepareDependencies(repository)).kind, "preinstalled");
});
