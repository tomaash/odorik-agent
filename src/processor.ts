import { FieldValue } from "@google-cloud/firestore";
import Fastify from "fastify";
import { loadAudioObject } from "./audio-store.js";
import { geminiModel, port, requiredEnv } from "./config.js";
import { db } from "./firestore.js";
import { transcribeAudio } from "./gemini.js";
import { audioMimeType } from "./recording.js";

type StorageEvent = {
  bucket?: string;
  name?: string;
  contentType?: string;
  data?: StorageEvent;
};

const maxGeminiInlineBytes = 18 * 1024 * 1024;
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

  const callId = objectName.split("/")[1];
  if (!callId) return reply.send({ ok: true, ignored: true });

  const callRef = db().collection("calls").doc(callId);
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
    if (metadata.size > maxGeminiInlineBytes) {
      throw new Error(
        `Recording is ${metadata.size} bytes; inline Gemini limit is ${maxGeminiInlineBytes}`,
      );
    }

    const result = await transcribeAudio({
      audio,
      mimeType:
        event.contentType ||
        metadata.contentType ||
        audioMimeType(objectName),
      apiKey: requiredEnv("GEMINI_API_KEY"),
    });

    await callRef.set(
      {
        status: "completed",
        model: geminiModel,
        language: result.language,
        transcript: result.transcript,
        summary: result.summary,
        segments: result.segments,
        actionItems: result.actionItems,
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
