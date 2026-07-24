import { Storage } from "@google-cloud/storage";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { transcribeAudioWithDeepgram } from "../src/deepgram.ts";
import { summarizeTranscriptWithGemini } from "../src/gemini.ts";

process.env.FIRESTORE_DATABASE_ID = "odorik";
initializeApp({ projectId: "odorik-tx-260720-c58d" });
const db = getFirestore("odorik");

const projectId = "odorik-tx-260720-c58d";
const apiKey = "AIzaSyDDQU8iD18y0G4e_D597NFUa_CXyV3mY18";
const deepgramApiKey = "1100a942cf4ed9b8766931e92a481929c5e7706f";
const callId = "eb5dcc0fdb478680247bcdef5c4fd6fee3125b68";
const objectName = "recordings/eb5dcc0fdb478680247bcdef5c4fd6fee3125b68/2026.07.24_21-00-02-1185-759616-771218776-910122307.opus";

console.log(`[reprocess] Fetching 19.7-min recording from Cloud Storage bucket...`);
const storage = new Storage({ projectId });
const bucket = storage.bucket("odorik-tx-260720-c58d-recordings");
const file = bucket.file(objectName);

const [audio] = await file.download();
console.log(`[reprocess] Downloaded ${audio.length} bytes audio. Running Deepgram Nova-3 STT (detect_language=true, diarize=true)...`);

const startTime = Date.now();
const sttResult = await transcribeAudioWithDeepgram({
  audio,
  mimeType: "audio/ogg",
  deepgramApiKey,
});
const sttMs = Date.now() - startTime;

console.log(`[reprocess] Deepgram Nova-3 completed in ${sttMs} ms!`);
console.log(`- Detected language: ${sttResult.language}`);
console.log(`- Transcript length: ${sttResult.transcript.length} characters`);
console.log(`- Speaker segments: ${sttResult.segments.length}`);

console.log(`[reprocess] Summarizing with Gemini 3.5 Flash-Lite...`);
const summaryResult = await summarizeTranscriptWithGemini({
  transcript: sttResult.transcript,
  segments: sttResult.segments,
  apiKey,
});

console.log(`- Summary: ${summaryResult.summary}`);
console.log(`- Action items (${summaryResult.actionItems.length}):`, summaryResult.actionItems);

const callRef = db.doc(`calls/${callId}`);
await callRef.set(
  {
    status: "completed",
    sttModel: "deepgram-nova-3",
    summaryModel: "gemini-3.5-flash-lite",
    model: "gemini-3.5-flash-lite",
    language: summaryResult.language || sttResult.language,
    transcript: sttResult.transcript,
    summary: summaryResult.summary,
    segments: sttResult.segments,
    actionItems: summaryResult.actionItems,
    crmBackfillRequestedAt: FieldValue.serverTimestamp(),
    processedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    error: FieldValue.delete(),
  },
  { merge: true },
);

console.log("[reprocess] Call document updated in production Firestore! Triggering CRM intake processing...");
const { processCompletedCall } = await import("./functions/lib/crm/process.js");
const crmResult = await processCompletedCall({ callId, apiKey });
console.log("[reprocess] ✅ CRM Intake pipeline re-processing complete!", crmResult);
