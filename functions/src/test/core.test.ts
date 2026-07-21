import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartProcessingRun,
  normalizePhone,
  shouldProcessCallUpdate,
} from "../crm/process.js";
import { validateProposalEvidence } from "../crm/extract.js";

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
