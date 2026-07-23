import assert from "node:assert/strict";
import test from "node:test";
import { parseBasicAuth, secureEquals } from "../auth.js";
import { parseGeminiJson } from "../gemini.js";
import {
  audioMimeType,
  recordingCallId,
  safeFileName,
} from "../recording.js";
import {
  legacyConnectionId,
  odorikResourceIdentity,
  odorikStoredCallId,
} from "../connectors/odorik.js";

test("secure comparison and Basic auth parsing", () => {
  assert.equal(secureEquals("secret", "secret"), true);
  assert.equal(secureEquals("wrong", "secret"), false);
  assert.deepEqual(parseBasicAuth(`Basic ${Buffer.from("odorik:secret").toString("base64")}`), {
    username: "odorik",
    password: "secret",
  });
});

test("recording identifiers are deterministic and safe", () => {
  assert.equal(
    recordingCallId({ callid: "fixture-call-001" }, "call.wav"),
    "fixture-call-001",
  );
  assert.equal(
    recordingCallId({ from: "123", to: "456", time: "now" }, "call.wav"),
    recordingCallId({ from: "123", to: "456", time: "now" }, "call.wav"),
  );
  assert.equal(safeFileName("../../Call recording.wav"), "Call-recording.wav");
  assert.equal(audioMimeType("call.opus"), "audio/ogg");
});

test("structured Gemini response parsing accepts fenced JSON", () => {
  const result = parseGeminiJson(`\`\`\`json
  {
    "language": "en",
    "transcript": "Hello",
    "summary": "Greeting",
    "segments": [{"speaker": "Speaker 1", "text": "Hello"}],
    "actionItems": []
  }
  \`\`\``);
  assert.equal(result.transcript, "Hello");
});

test("maps each Odorik line to a stable selectable resource", () => {
  const byName = odorikResourceIdentity({ line_name: "Support", to: "+420123" });
  const repeated = odorikResourceIdentity({ line_name: "Support", to: "+420999" });
  const byNumber = odorikResourceIdentity({ to: "+420123" });
  assert.equal(byName.resourceId, repeated.resourceId);
  assert.equal(byName.displayName, "Support");
  assert.notEqual(byName.resourceId, byNumber.resourceId);
  assert.equal(odorikStoredCallId(legacyConnectionId, "call-1"), "call-1");
  assert.match(odorikStoredCallId("second-account", "call-1"), /^odorik_[a-f0-9]{32}$/);
  assert.notEqual(
    odorikStoredCallId("second-account", "call-1"),
    odorikStoredCallId("third-account", "call-1"),
  );
});
