import assert from "node:assert/strict";
import test from "node:test";
import { parseBasicAuth, secureEquals } from "../auth.js";
import { parseGeminiJson } from "../gemini.js";
import {
  geminiAudioMimeType,
  parseGeminiTranscription,
  transcribeAudioWithGemini,
} from "../gemini-transcribe.js";
import { transcriptionProviderFromEnvironment } from "../config.js";
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

test("Gemini Transcribe annotations become speaker segments", () => {
  const result = parseGeminiTranscription({
    steps: [{
      content: [{
        type: "text",
        text: "Ahoj, světe. Dobrý den.",
        annotations: [
          { type: "word_info", text: "Ahoj", speaker: "spk_1", start_offset: "0.1s", end_offset: "0.4s" },
          { type: "word_info", text: ",", speaker: "spk_1", start_offset: "0.4s", end_offset: "0.4s" },
          { type: "word_info", text: "světe", speaker: "spk_1", start_offset: "0.5s", end_offset: "0.9s" },
          { type: "word_info", text: "Dobrý", speaker: "spk_2", start_offset: "1.1s", end_offset: "1.4s" },
          { type: "word_info", text: "den", speaker: "spk_2", start_offset: "1.5s", end_offset: "1.8s" },
        ],
      }],
    }],
  });
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-3.5-transcribe");
  assert.deepEqual(result.segments, [
    { speaker: "spk_1", text: "Ahoj, světe", startSeconds: 0.1, endSeconds: 0.9 },
    { speaker: "spk_2", text: "Dobrý den", startSeconds: 1.1, endSeconds: 1.8 },
  ]);
});

test("Gemini Transcribe normalizes supported audio MIME aliases", () => {
  assert.equal(geminiAudioMimeType("audio/mp4"), "audio/m4a");
  assert.equal(geminiAudioMimeType("audio/x-wav"), "audio/wav");
  assert.equal(geminiAudioMimeType("audio/ogg"), "audio/ogg");
});

test("Gemini Transcribe uploads, transcribes, and deletes temporary audio", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.example/session" } }),
    Response.json({ file: { name: "files/call-1", uri: "https://files.example/call-1", mimeType: "audio/ogg" } }),
    Response.json({ steps: [{ content: [{ type: "text", text: "Dobrý den." }] }] }),
    new Response(null, { status: 204 }),
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;

  const result = await transcribeAudioWithGemini({
    audio: Buffer.from("audio"),
    mimeType: "audio/ogg",
    apiKey: "test-key",
    fetchImpl,
  });

  assert.equal(result.transcript, "Dobrý den.");
  assert.equal(requests.length, 4);
  assert.equal(requests[2]?.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(requests[3]?.init?.method, "DELETE");
  const interactionBody = JSON.parse(String(requests[2]?.init?.body));
  assert.equal(interactionBody.model, "gemini-3.5-transcribe");
  assert.equal(interactionBody.generation_config.transcription_config.mode.diarization_mode, "speaker");
});

test("Gemini is the default transcription provider and Deepgram remains selectable", () => {
  assert.equal(transcriptionProviderFromEnvironment({}), "gemini");
  assert.equal(transcriptionProviderFromEnvironment({ TRANSCRIPTION_PROVIDER: "deepgram" }), "deepgram");
  assert.throws(
    () => transcriptionProviderFromEnvironment({ TRANSCRIPTION_PROVIDER: "other" }),
    /must be "gemini" or "deepgram"/,
  );
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
