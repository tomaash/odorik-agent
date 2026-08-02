import assert from "node:assert/strict";
import test from "node:test";
import {
  audienceEquals,
  canMemberAccess,
  canMemberAccessSourceData,
  isAudienceBroadened,
  normalizeResourceAudience,
} from "../access.js";
import { FirestoreCompanyData } from "../agent/knowledge.js";
import { memberThreadDocumentId } from "../agent/threads.js";
import { listTasks } from "../tasks/repository.js";
import { listActionApprovals } from "../approvals/repository.js";
import { MemoryFirestore } from "./firestore-harness.js";

test("audiences are canonical, backward compatible, and detect access broadening", () => {
  assert.deepEqual(normalizeResourceAudience(undefined), { visibility: "company" });
  assert.deepEqual(normalizeResourceAudience({
    visibility: "restricted",
    memberIds: ["member-b", "member-a", "member-b", ""],
  }), {
    visibility: "restricted",
    memberIds: ["member-a", "member-b"],
  });
  assert.equal(canMemberAccess({ visibility: "restricted", memberIds: ["member-a"] }, "member-a"), true);
  assert.equal(canMemberAccess({ visibility: "restricted", memberIds: ["member-a"] }, "member-b"), false);
  assert.equal(canMemberAccessSourceData({
    access: { visibility: "company" },
    indexingEnabled: false,
  }, "member-a"), false);
  assert.equal(isAudienceBroadened(
    { visibility: "restricted", memberIds: ["member-a"] },
    { visibility: "restricted", memberIds: ["member-a", "member-b"] },
  ), true);
  assert.equal(isAudienceBroadened(
    { visibility: "company" },
    { visibility: "restricted", memberIds: ["member-a"] },
  ), false);
  assert.equal(audienceEquals(
    { visibility: "restricted", memberIds: ["member-b", "member-a"] },
    { visibility: "restricted", memberIds: ["member-a", "member-b"] },
  ), true);
});

test("the same logical chat ID maps to a different private document for every member", () => {
  const alice = memberThreadDocumentId("alice", "general");
  const bob = memberThreadDocumentId("bob", "general");
  assert.notEqual(alice, bob);
  assert.equal(alice, memberThreadDocumentId("alice", "general"));
  assert.doesNotMatch(alice, /alice|general/);
});

test("lookup, list, aggregate, and indexing isolate companies and selected members", async () => {
  const memory = new MemoryFirestore();
  const seed = (
    companyId: string,
    id: string,
    access: { visibility: "company" } | { visibility: "restricted"; memberIds: string[] },
    indexingEnabled = true,
  ) => memory.seed(`companies/${companyId}/contextItems/${id}`, {
    companyId,
    kind: "document",
    title: `${companyId}:${id}`,
    text: `Secret ${companyId}:${id}`,
    source: { connectionId: "drive-a", resourceId: "folder-a" },
    access,
    indexingEnabled,
    updatedAt: "2026-08-02T10:00:00.000Z",
  });
  seed("company-a", "public", { visibility: "company" });
  seed("company-a", "alice-only", { visibility: "restricted", memberIds: ["alice"] });
  seed("company-a", "bob-only", { visibility: "restricted", memberIds: ["bob"] });
  seed("company-a", "disabled", { visibility: "restricted", memberIds: ["alice"] }, false);
  seed("company-b", "alice-only", { visibility: "restricted", memberIds: ["alice"] });

  const alice = new FirestoreCompanyData(memory.asFirestore(), "company-a", "alice");
  const bob = new FirestoreCompanyData(memory.asFirestore(), "company-a", "bob");
  assert.equal((await alice.getRecord("context_item", "alice-only"))?.recordId, "alice-only");
  assert.equal(await bob.getRecord("context_item", "alice-only"), null);
  assert.equal(await alice.getRecord("context_item", "disabled"), null);
  assert.deepEqual((await alice.listRecords("context_item")).map((record) => record.recordId).sort(), [
    "alice-only",
    "public",
  ]);
  assert.deepEqual((await bob.listRecords("context_item")).map((record) => record.recordId).sort(), [
    "bob-only",
    "public",
  ]);
  assert.equal((await alice.aggregateRecords({ kind: "context_item" })).total, 2);
  assert.equal((await bob.aggregateRecords({ kind: "context_item" })).total, 2);
  assert.deepEqual(
    [...new Set((await alice.allDocuments(["context_item"])).map((document) => document.recordId))].sort(),
    ["alice-only", "public"],
  );

  const otherCompany = new FirestoreCompanyData(memory.asFirestore(), "company-b", "alice");
  assert.equal(await otherCompany.getRecord("context_item", "public"), null);
  assert.equal((await otherCompany.getRecord("context_item", "alice-only"))?.title, "company-b:alice-only");
});

test("direct task and approval APIs hide restricted and disabled evidence", async () => {
  const memory = new MemoryFirestore();
  const base = "companies/company-a";
  for (const [collection, id, objectType, access, indexingEnabled] of [
    ["workItems", "task-public", "task", { visibility: "company" }, true],
    ["workItems", "task-alice", "task", { visibility: "restricted", memberIds: ["alice"] }, true],
    ["workItems", "task-disabled", "task", { visibility: "company" }, false],
    ["actionApprovals", "approval-public", "action_approval", { visibility: "company" }, true],
    ["actionApprovals", "approval-alice", "action_approval", { visibility: "restricted", memberIds: ["alice"] }, true],
    ["actionApprovals", "approval-disabled", "action_approval", { visibility: "company" }, false],
  ] as const) {
    memory.seed(`${base}/${collection}/${id}`, {
      objectType,
      access,
      indexingEnabled,
      status: collection === "workItems" ? "open" : "pending",
      createdAt: "2026-08-02T10:00:00.000Z",
    });
  }
  const database = memory.asFirestore();
  const ids = (value: unknown) => (value as Array<{ id: string }>).map((record) => record.id).sort();
  assert.deepEqual(ids(await listTasks({ companyId: "company-a", memberUid: "alice" }, database)),
    ["task-alice", "task-public"]);
  assert.deepEqual(ids(await listTasks({ companyId: "company-a", memberUid: "bob" }, database)),
    ["task-public"]);
  assert.deepEqual(ids(await listActionApprovals({ companyId: "company-a", memberUid: "alice" }, database)),
    ["approval-alice", "approval-public"]);
  assert.deepEqual(ids(await listActionApprovals({ companyId: "company-a", memberUid: "bob" }, database)),
    ["approval-public"]);
});
