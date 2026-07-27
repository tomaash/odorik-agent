import multipart from "@fastify/multipart";
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { saveAudioObject } from "./audio-store.js";
import { port, requiredEnv } from "./config.js";
import { db } from "./firestore.js";
import {
  audioMimeType,
  type OdorikFields,
  recordingCallId,
  safeFileName,
} from "./recording.js";
import {
  authorizeOdorikUpload,
  legacyCompanyId,
  legacyConnectionId,
  observeOdorikResource,
  odorikStoredCallId,
} from "./connectors/odorik.js";

const maxUploadBytes = 31 * 1024 * 1024;
const server = Fastify({ logger: true, bodyLimit: maxUploadBytes });
const bucketName = requiredEnv("RECORDINGS_BUCKET");

await server.register(multipart, {
  limits: {
    fileSize: maxUploadBytes,
    files: 1,
    fields: 24,
    parts: 25,
  },
});

server.get("/health", async () => ({ ok: true, service: "odorik-ingest" }));

async function receiveRecording(
  companyId: string,
  connectionId: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await authorizeOdorikUpload({
      companyId,
      connectionId,
      authorization: request.headers.authorization,
      legacyUsername: process.env.ODORIK_UPLOAD_USER?.trim(),
      legacyPassword: process.env.ODORIK_UPLOAD_PASSWORD?.trim(),
    });
  } catch {
    reply.header("www-authenticate", 'Basic realm="Odorik uploads"');
    return reply.code(401).send({ code: 401, description: "Unauthorized" });
  }

  const fields: OdorikFields = {};
  let audio: Buffer | undefined;
  let originalFileName = "";
  let suppliedMimeType = "";

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "record" || audio) {
        part.file.resume();
        continue;
      }
      audio = await part.toBuffer();
      originalFileName = part.filename || "recording.bin";
      suppliedMimeType = part.mimetype;
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  if (!audio?.length) {
    return reply.code(400).send({ code: 400, description: "Missing record file" });
  }

  const resource = await observeOdorikResource({ companyId, connectionId, fields });
  const externalCallId = recordingCallId(fields, originalFileName);
  const callId = odorikStoredCallId(connectionId, externalCallId);
  const fileName = safeFileName(originalFileName);
  const objectName = `recordings/${companyId}/${callId}/${fileName}`;
  const mimeType = audioMimeType(fileName, suppliedMimeType);
  const callRef = db().collection(`companies/${companyId}/calls`).doc(callId);
  const now = Timestamp.now();

  await callRef.set(
    {
      status: "uploading",
      companyId,
      connectionId,
      resourceId: resource.resourceId,
      contextEnabled: resource.contextEnabled,
      source: {
        adapterId: "odorik",
        connectionId,
        resourceId: resource.resourceId,
        externalId: externalCallId,
      },
      originalFileName,
      objectName,
      mimeType,
      bytes: audio.length,
      from: fields.from || null,
      to: fields.to || null,
      duration: Number.parseInt(fields.duration || "0", 10) || null,
      lineName: fields.line_name || null,
      odorikTime: fields.time || null,
      uploadedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 90 * 24 * 60 * 60 * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const { duplicate } = await saveAudioObject({
    bucketName,
    objectName,
    audio,
    contentType: mimeType,
    metadata: {
      companyId,
      callId,
      externalCallId,
      from: fields.from || "",
      to: fields.to || "",
      duration: fields.duration || "",
    },
  });

  await callRef.set(
    {
      status: duplicate ? "uploaded" : "uploaded",
      duplicate,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const localProcessorUrl = process.env.LOCAL_PROCESSOR_URL?.trim();
  if (!duplicate && localProcessorUrl) {
    const processorResponse = await fetch(
      `${localProcessorUrl.replace(/\/$/, "")}/events/storage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bucket: bucketName,
          name: objectName,
          contentType: mimeType,
        }),
        signal: AbortSignal.timeout(240_000),
      },
    );
    if (!processorResponse.ok) {
      throw new Error(
        `Local processor failed (${processorResponse.status}): ${await processorResponse.text()}`,
      );
    }
  }

  return reply.send({
    code: 200,
    description: duplicate ? "Recording already received" : "Recording accepted",
    callid: callId,
  });
}

server.post("/odorik/recordings", async (request, reply) => {
  return receiveRecording(legacyCompanyId, legacyConnectionId, request, reply);
});

server.post<{ Params: { companyId: string; connectionId: string } }>(
  "/webhooks/odorik/:companyId/:connectionId/recordings",
  async (request, reply) => {
    const companyId = request.params.companyId;
    const connectionId = request.params.connectionId;
    if (
      !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(companyId)
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)
    ) {
      return reply.code(404).send({ code: 404, description: "Connection not found" });
    }
    return receiveRecording(companyId, connectionId, request, reply);
  },
);

server.setErrorHandler((error, _request, reply) => {
  server.log.error(error);
  const knownError = error as { message?: string; statusCode?: number };
  const statusCode =
    knownError.statusCode && knownError.statusCode < 500
      ? knownError.statusCode
      : 500;
  reply.code(statusCode).send({
    code: statusCode,
    description:
      statusCode === 500
        ? "Internal upload error"
        : knownError.message || "Upload rejected",
  });
});

await server.listen({ port, host: "0.0.0.0" });
