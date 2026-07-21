import { geminiModel } from "./config.js";

export type TranscriptionResult = {
  language: string;
  transcript: string;
  summary: string;
  segments: Array<{ speaker: string; text: string }>;
  actionItems: string[];
};

const responseSchema = {
  type: "OBJECT",
  properties: {
    language: { type: "STRING" },
    transcript: { type: "STRING" },
    summary: { type: "STRING" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          speaker: { type: "STRING" },
          text: { type: "STRING" },
        },
        required: ["speaker", "text"],
      },
    },
    actionItems: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["language", "transcript", "summary", "segments", "actionItems"],
};

export function parseGeminiJson(text: string): TranscriptionResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Partial<TranscriptionResult>;
  if (
    typeof parsed.language !== "string" ||
    typeof parsed.transcript !== "string" ||
    typeof parsed.summary !== "string" ||
    !Array.isArray(parsed.segments) ||
    !Array.isArray(parsed.actionItems)
  ) {
    throw new Error("Gemini returned an invalid transcription payload");
  }
  return parsed as TranscriptionResult;
}

export async function transcribeAudio(input: {
  audio: Buffer;
  mimeType: string;
  apiKey: string;
}): Promise<TranscriptionResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Transcribe this telephone call faithfully. Preserve names, numbers, and important wording. " +
                  "Identify speakers when the audio supports it. Detect the spoken language. " +
                  "Also provide a concise summary and explicit action items. Do not invent inaudible content.",
              },
              {
                inlineData: {
                  mimeType: input.mimeType,
                  data: input.audio.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
      signal: AbortSignal.timeout(180_000),
    },
  );

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
    error?: { message?: string; status?: string };
  };

  if (!response.ok) {
    throw new Error(
      `Gemini ${payload.error?.status || response.status}: ${
        payload.error?.message || "request failed"
      }`,
    );
  }

  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";
  if (!text) throw new Error("Gemini returned no transcription");
  return parseGeminiJson(text);
}

