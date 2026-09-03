import { geminiTranscriptionModel } from "./config.js";
import type {
  SpeechTranscriptionResult,
  TranscriptionSegment,
} from "./transcription.js";

type GeminiWordAnnotation = {
  type?: unknown;
  text?: unknown;
  speaker?: unknown;
  start_offset?: unknown;
  end_offset?: unknown;
};

type GeminiInteraction = {
  steps?: Array<{
    content?: Array<{
      type?: unknown;
      text?: unknown;
      annotations?: GeminiWordAnnotation[];
    }>;
  }>;
  error?: { message?: string; status?: string };
};

function offsetSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function joinTokens(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

export function parseGeminiTranscription(
  payload: GeminiInteraction,
  model = geminiTranscriptionModel,
): SpeechTranscriptionResult {
  const textParts: string[] = [];
  const words: Array<{
    text: string;
    speaker: string;
    startSeconds?: number;
    endSeconds?: number;
  }> = [];

  for (const step of payload.steps || []) {
    for (const content of step.content || []) {
      if (content.type === "text" && typeof content.text === "string") {
        textParts.push(content.text);
      }
      for (const annotation of content.annotations || []) {
        if (annotation.type !== "word_info" || typeof annotation.text !== "string") continue;
        const startSeconds = offsetSeconds(annotation.start_offset);
        const endSeconds = offsetSeconds(annotation.end_offset);
        words.push({
          text: annotation.text,
          speaker: typeof annotation.speaker === "string" && annotation.speaker
            ? annotation.speaker
            : "Speaker 0",
          ...(startSeconds === undefined ? {} : { startSeconds }),
          ...(endSeconds === undefined ? {} : { endSeconds }),
        });
      }
    }
  }

  const transcript = textParts.join("\n").trim();
  if (!transcript && words.length === 0) {
    throw new Error("Gemini Transcribe returned an empty transcript");
  }

  const segments: TranscriptionSegment[] = [];
  let current: typeof words = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    segments.push({
      speaker: first.speaker,
      text: joinTokens(current.map((word) => word.text)),
      ...(first.startSeconds === undefined ? {} : { startSeconds: first.startSeconds }),
      ...(last.endSeconds === undefined ? {} : { endSeconds: last.endSeconds }),
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0 && current[0]?.speaker !== word.speaker) flush();
    current.push(word);
  }
  flush();

  if (segments.length === 0 && transcript) {
    segments.push({ speaker: "Speaker 0", text: transcript });
  }

  return {
    provider: "gemini",
    model,
    language: "und",
    transcript: transcript || segments.map((segment) => segment.text).join("\n"),
    segments,
  };
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: unknown; status?: unknown } }).error;
    const status = typeof error?.status === "string" ? `${error.status}: ` : "";
    if (typeof error?.message === "string") return `${status}${error.message}`.slice(0, 1000);
  }
  return fallback;
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function geminiAudioMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "audio/mp4" || normalized === "audio/x-m4a") return "audio/m4a";
  if (normalized === "audio/x-wav") return "audio/wav";
  return normalized || "audio/ogg";
}

export async function transcribeAudioWithGemini(input: {
  audio: Buffer;
  mimeType: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<SpeechTranscriptionResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const model = input.model || geminiTranscriptionModel;
  const mimeType = geminiAudioMimeType(input.mimeType);
  let uploadedFileName: string | undefined;

  try {
    const startResponse = await fetchImpl(
      "https://generativelanguage.googleapis.com/upload/v1beta/files",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
          "x-goog-upload-protocol": "resumable",
          "x-goog-upload-command": "start",
          "x-goog-upload-header-content-length": String(input.audio.length),
          "x-goog-upload-header-content-type": mimeType,
        },
        body: JSON.stringify({ file: { display_name: "odorik-call" } }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!startResponse.ok) {
      const payload = await responsePayload(startResponse);
      throw new Error(
        `Gemini file upload start failed (${startResponse.status}): ${errorMessage(payload, "request failed")}`,
      );
    }
    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini file upload did not return an upload URL");

    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        "content-length": String(input.audio.length),
        "x-goog-upload-offset": "0",
        "x-goog-upload-command": "upload, finalize",
      },
      body: new Uint8Array(input.audio),
      signal: AbortSignal.timeout(180_000),
    });
    const uploadPayload = await responsePayload(uploadResponse) as {
      file?: { name?: string; uri?: string; mimeType?: string; mime_type?: string };
    } | null;
    if (!uploadResponse.ok) {
      throw new Error(
        `Gemini file upload failed (${uploadResponse.status}): ${errorMessage(uploadPayload, "request failed")}`,
      );
    }
    uploadedFileName = uploadPayload?.file?.name;
    const fileUri = uploadPayload?.file?.uri;
    if (!uploadedFileName || !fileUri) {
      throw new Error("Gemini file upload returned no file name or URI");
    }

    const transcriptionResponse = await fetchImpl(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
        },
        body: JSON.stringify({
          model,
          input: [{
            type: "audio",
            uri: fileUri,
            mime_type: uploadPayload?.file?.mimeType || uploadPayload?.file?.mime_type || mimeType,
          }],
          generation_config: {
            transcription_config: {
              language_codes: [],
              mode: {
                type: "verbatim",
                diarization_mode: "speaker",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    const transcriptionPayload = await responsePayload(transcriptionResponse) as GeminiInteraction | null;
    if (!transcriptionResponse.ok || !transcriptionPayload) {
      throw new Error(
        `Gemini Transcribe failed (${transcriptionResponse.status}): ${errorMessage(transcriptionPayload, "request failed")}`,
      );
    }
    return parseGeminiTranscription(transcriptionPayload, model);
  } finally {
    if (uploadedFileName) {
      try {
        await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/${encodeURI(uploadedFileName)}`,
          {
            method: "DELETE",
            headers: { "x-goog-api-key": input.apiKey },
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch {
        // Gemini also expires uploaded files automatically after 48 hours.
      }
    }
  }
}
