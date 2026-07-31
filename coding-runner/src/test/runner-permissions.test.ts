import assert from "node:assert/strict";
import test from "node:test";
import { REPOSITORY_DIRECTORY_MODE } from "../git.js";
import { INPUT_DIRECTORY_MODE, RUN_DIRECTORY_MODE, RUNS_ROOT_MODE } from "../runner.js";

test("workspace users can traverse run inputs without exposing them to other users", () => {
  assert.equal(RUNS_ROOT_MODE & 0o010, 0o010);
  assert.equal(RUN_DIRECTORY_MODE & 0o070, 0o070);
  assert.equal(INPUT_DIRECTORY_MODE & 0o050, 0o050);
  assert.equal(REPOSITORY_DIRECTORY_MODE & 0o070, 0o070);
  assert.equal(RUNS_ROOT_MODE & 0o007, 0);
  assert.equal(RUN_DIRECTORY_MODE & 0o007, 0);
  assert.equal(INPUT_DIRECTORY_MODE & 0o007, 0);
  assert.equal(REPOSITORY_DIRECTORY_MODE & 0o007, 0);
});
