import assert from "node:assert/strict";
import test from "node:test";
import { parseDispatchSpec } from "../spec.js";
import { parsePublishSpec } from "../publish-spec.js";

const runId = `coding_${"a".repeat(32)}`;
const prefix = `companies/explorers/coding-runs/${runId}`;
const fixture = {
  schemaVersion: 1,
  runId,
  companyId: "explorers",
  github: {
    connectionId: "github_150346586",
    installationId: 150346586,
    repoResourceId: `repo_${"b".repeat(24)}`,
    repositoryId: 99,
    fullName: "tomaash/elixir-play",
    defaultBranch: "main",
    issueNumber: 17,
    issueContextItemId: `github_issue_${"c".repeat(32)}`,
    issueVersion: "2026-08-01T00:00:00Z",
    issueChecksum: "d".repeat(64),
    issuePrompt: "Implement the approved issue snapshot.",
  },
  grok: { connectionId: "grok_subscription", authKind: "subscription_oauth" },
  proposedBranch: "erik/issue-17-aaaaaaaa",
  baseSha: "e".repeat(40),
  approval: {
    approvalId: "coding_approval_1",
    approvedBy: "admin-1",
    effectDigest: "f".repeat(64),
  },
  publication: {
    draft: true,
    prTitle: "Implement #17",
    prBody: "Closes #17",
  },
  objects: {
    source: `${prefix}/source.bundle`,
    runSpec: `${prefix}/run-spec.json`,
    artifact: `${prefix}/artifacts.tar.gz`,
    patch: `${prefix}/changes.patch`,
    resultBundle: `${prefix}/result.bundle`,
    publishSpec: `${prefix}/publish-spec.json`,
  },
  limits: {
    maxSourceBytes: 10_000,
    maxArtifactBytes: 10_000,
    maxChangedFiles: 5,
    maxPatchBytes: 5_000,
    maxTurns: 10,
  },
};

test("dispatch spec binds all objects to the tenant and run prefix", () => {
  assert.equal(parseDispatchSpec(fixture).github.fullName, "tomaash/elixir-play");
  assert.throws(
    () => parseDispatchSpec({
      ...fixture,
      objects: { ...fixture.objects, source: "companies/other/source.bundle" },
    }),
    /outside the run object prefix/,
  );
});

test("dispatch spec only accepts subscription OAuth", () => {
  assert.throws(
    () => parseDispatchSpec({
      ...fixture,
      grok: { ...fixture.grok, authKind: "api_key" },
    }),
    /subscription OAuth/,
  );
});

test("publish spec binds approval, draft PR, and artifacts to one run", () => {
  const publish = {
    schemaVersion: 1,
    runId,
    companyId: "explorers",
    approval: fixture.approval,
    github: {
      installationId: 150346586,
      repositoryId: 99,
      fullName: "tomaash/elixir-play",
      issueNumber: 17,
    },
    git: {
      baseBranch: "main",
      baseSha: "e".repeat(40),
      resultBranch: "erik/issue-17-aaaaaaaa",
      resultSha: "1".repeat(40),
    },
    publication: fixture.publication,
    objects: {
      source: `${prefix}/source.bundle`,
      resultBundle: `${prefix}/result.bundle`,
    },
    resultBundleSha256: "2".repeat(64),
    maxResultBundleBytes: 50 * 1024 * 1024,
  };
  assert.equal(parsePublishSpec(publish).publication.draft, true);
  assert.throws(
    () => parsePublishSpec({
      ...publish,
      publication: { ...publish.publication, draft: false },
    }),
    /Only draft pull requests/,
  );
  assert.throws(
    () => parsePublishSpec({
      ...publish,
      objects: { ...publish.objects, resultBundle: "companies/other/result.bundle" },
    }),
    /outside the approved run prefix/,
  );
});
