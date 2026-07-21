import assert from "node:assert/strict";
import test from "node:test";
import { parseBasicAuth, secureEquals } from "../auth.js";
import { parseGeminiJson } from "../gemini.js";
import {
  audioMimeType,
  recordingCallId,
  safeFileName,
} from "../recording.js";

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

