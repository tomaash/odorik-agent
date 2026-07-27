import { FieldValue } from "@google-cloud/firestore";
import Fastify from "fastify";
import { loadAudioObject } from "./audio-store.js";
import { geminiModel, port, requiredEnv } from "./config.js";
import { db } from "./firestore.js";
import { summarizeTranscriptWithGemini } from "./gemini.js";
import { transcribeAudioWithDeepgram } from "./deepgram.js";
import { audioMimeType } from "./recording.js";

type StorageEvent = {
  bucket?: string;
  name?: string;
  contentType?: string;
  data?: StorageEvent;
};

const maxAudioBytes = 250 * 1024 * 1024;
const legacyCompanyId = "explorers";
const server = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

server.get("/health", async () => ({ ok: true, service: "transcription-processor" }));

server.post("/events/storage", async (request, reply) => {
  const envelope = request.body as StorageEvent;
  const event = envelope.data || envelope;
  const bucketName = event.bucket;
  const objectName = event.name;
  if (!bucketName || !objectName?.startsWith("recordings/")) {
    return reply.send({ ok: true, ignored: true });
  }

  const objectParts = objectName.split("/");
  const isLegacyPath = objectParts.length === 3;
  const companyId = isLegacyPath ? legacyCompanyId : objectParts[1];
  const callId = isLegacyPath ? objectParts[1] : objectParts[2];
  if (
    !companyId
    || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(companyId)
    || !callId
    || callId.includes("/")
  ) return reply.send({ ok: true, ignored: true });

  const callRef = db().collection(`companies/${companyId}/calls`).doc(callId);
  let shouldProcess = false;
  await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(callRef);
    const status = snapshot.data()?.status;
    if (status === "completed" || status === "processing") return;
    transaction.set(
      callRef,
      {
        status: "processing",
        processingStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    shouldProcess = true;
  });

  if (!shouldProcess) {
    return reply.send({ ok: true, duplicateEvent: true });
  }

  try {
    const { audio, metadata } = await loadAudioObject({
      bucketName,
      objectName,
    });
    if (metadata.size > maxAudioBytes) {
      throw new Error(
        `Recording is ${metadata.size} bytes; limit is ${maxAudioBytes}`,
      );
    }

    const mimeType = event.contentType || metadata.contentType || audioMimeType(objectName);

    const sttResult = await transcribeAudioWithDeepgram({
      audio,
      mimeType,
      ...(process.env.DEEPGRAM_API_KEY
        ? { deepgramApiKey: process.env.DEEPGRAM_API_KEY }
        : {}),
    });

    const summaryResult = await summarizeTranscriptWithGemini({
      transcript: sttResult.transcript,
      segments: sttResult.segments,
      apiKey: requiredEnv("GEMINI_API_KEY"),
    });

    await callRef.set(
      {
        status: "completed",
        sttModel: "deepgram-nova-3",
        summaryModel: geminiModel,
        model: geminiModel,
        language: summaryResult.language || sttResult.language,
        transcript: sttResult.transcript,
        summary: summaryResult.summary,
        segments: sttResult.segments,
        actionItems: summaryResult.actionItems,
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        error: FieldValue.delete(),
      },
      { merge: true },
    );
    return reply.send({ ok: true, callId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    server.log.error({ err: error, callId }, "transcription failed");
    await callRef.set(
      {
        status: "failed",
        error: message.slice(0, 2000),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return reply.code(500).send({ ok: false, callId, error: message });
  }
});

await server.listen({ port, host: "0.0.0.0" });
