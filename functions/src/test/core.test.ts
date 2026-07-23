import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartProcessingRun,
  normalizePhone,
  shouldProcessCallUpdate,
} from "../crm/process.js";
import { validateProposalEvidence } from "../crm/extract.js";
import {
  allowedRequestTransitions,
  canTransitionRequestStatus,
  normalizeRequestStatus,
  storedStatusesFor,
} from "../crm/lifecycle.js";
import { decryptCredentials, encryptCredentials } from "../connectors/credentials.js";
import {
  odorikContextItem,
  odorikContextItemId,
  odorikResourceIdentity,
} from "../connectors/odorik.js";

test("normalizes Czech and international phone numbers", () => {
  assert.equal(normalizePhone("777 123 456"), "+420777123456");
  assert.equal(normalizePhone("+421 901 222 333"), "+421901222333");
  assert.equal(normalizePhone("00420 777 123 456"), "+420777123456");
});

test("drops unsupported explicit model proposals", () => {
  const result = validateProposalEvidence([
    {
      field: "address",
      value: "Prague",
      support: "explicit",
      evidence: [{ segmentIndex: 0, quote: "in Brno" }],
    },
    {
      field: "serviceType",
      value: "moving",
      support: "explicit",
      evidence: [{ segmentIndex: 0, quote: "move a wardrobe" }],
    },
  ], "Please move a wardrobe tomorrow.", [{ text: "Please move a wardrobe tomorrow." }]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.field, "serviceType");
});

test("processes only completion transitions and explicit backfills", () => {
  const timestamp = (value: number) => ({ toMillis: () => value });
  assert.equal(shouldProcessCallUpdate({ status: "processing" }, { status: "completed" }), true);
  assert.equal(shouldProcessCallUpdate(
    { status: "completed", crmBackfillRequestedAt: timestamp(1) },
    { status: "completed", crmBackfillRequestedAt: timestamp(1), crmStatus: "failed" },
  ), false);
  assert.equal(shouldProcessCallUpdate(
    { status: "completed", crmBackfillRequestedAt: timestamp(1) },
    { status: "completed", crmBackfillRequestedAt: timestamp(2) },
  ), true);
});

test("deduplicates active processing runs but permits a stale lease retry", () => {
  const now = 2_000_000;
  const timestamp = (value: number) => ({ toMillis: () => value });
  assert.equal(canStartProcessingRun(undefined, now), true);
  assert.equal(canStartProcessingRun({ status: "completed" }, now), false);
  assert.equal(canStartProcessingRun({ status: "running", updatedAt: timestamp(now - 1_000) }, now), false);
  assert.equal(canStartProcessingRun({ status: "running", updatedAt: timestamp(now - 16 * 60_000) }, now), true);
  assert.equal(canStartProcessingRun({ status: "failed" }, now), true);
});

test("normalizes legacy request statuses and expands new for queries", () => {
  assert.equal(normalizeRequestStatus("open"), "new");
  assert.equal(normalizeRequestStatus("waiting_customer"), "waiting_customer");
  assert.equal(normalizeRequestStatus("needs_review"), null);
  assert.deepEqual(storedStatusesFor(["new", "completed"]), ["new", "completed", "open"]);
});

test("allows only explicit service-request lifecycle transitions", () => {
  assert.equal(canTransitionRequestStatus("new", "in_progress"), true);
  assert.equal(canTransitionRequestStatus("new", "completed"), false);
  assert.equal(canTransitionRequestStatus("completed", "in_progress"), true);
  assert.deepEqual(allowedRequestTransitions("waiting_customer"), ["in_progress", "completed", "cancelled"]);
});

test("encrypts connector credentials with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptCredentials({ username: "line-a", password: "secret-value" }, key);
  assert.notEqual(encrypted.includes("secret-value"), true);
  assert.deepEqual(decryptCredentials(encrypted, key), {
    username: "line-a",
    password: "secret-value",
  });
  assert.throws(() => decryptCredentials(`${encrypted.slice(0, -2)}xx`, key));
});

test("normalizes Odorik calls into connection-aware context items", () => {
  const resource = odorikResourceIdentity({ lineName: "Sales", to: "+420123456789" });
  assert.equal(resource.externalId, "line:Sales");
  assert.match(resource.resourceId, /^phone_[a-f0-9]{24}$/);
  assert.equal(
    odorikContextItemId("account-a", "call-1"),
    odorikContextItemId("account-a", "call-1"),
  );
  const item = odorikContextItem("call-1", {
    status: "completed",
    connectionId: "account-a",
    resourceId: resource.resourceId,
    from: "+420111222333",
    to: "+420123456789",
    transcript: "Please call me tomorrow.",
    summary: "Follow-up requested.",
  });
  assert.equal((item?.source as Record<string, unknown>).connectionId, "account-a");
  assert.equal(item?.kind, "call");
  assert.match(String(item?.text), /Please call me tomorrow/);
  assert.equal(odorikContextItem("call-2", { status: "uploaded" }), null);
});
