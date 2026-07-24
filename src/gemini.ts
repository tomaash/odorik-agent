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

function repairTruncatedJson(jsonString: string): string {
  let s = jsonString.trim();
  let inString = false;
  let isEscaped = false;
  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === "\\" && !isEscaped) {
      isEscaped = true;
    } else {
      if (char === '"' && !isEscaped) {
        inString = !inString;
      }
      isEscaped = false;
    }
  }

  if (inString) {
    s += '"';
  }

  const stack: string[] = [];
  inString = false;
  isEscaped = false;
  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === "\\" && !isEscaped) {
      isEscaped = true;
    } else {
      if (char === '"' && !isEscaped) {
        inString = !inString;
      } else if (!inString) {
        if (char === "{" || char === "[") {
          stack.push(char);
        } else if (char === "}" || char === "]") {
          stack.pop();
        }
      }
      isEscaped = false;
    }
  }

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") s += "}";
    else if (open === "[") s += "]";
  }

  return s;
}

export function parseGeminiJson(text: string): TranscriptionResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: Partial<TranscriptionResult> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    try {
      const repaired = repairTruncatedJson(cleaned);
      parsed = JSON.parse(repaired);
    } catch {
      throw new Error(`Gemini returned invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.filter((s): s is { speaker: string; text: string } => Boolean(s && typeof s.speaker === "string" && typeof s.text === "string"))
    : [];

  const transcript = typeof parsed.transcript === "string" && parsed.transcript.trim()
    ? parsed.transcript
    : segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");

  return {
    language: typeof parsed.language === "string" ? parsed.language : "cs",
    transcript: transcript || "Prepis hovoru",
    summary: typeof parsed.summary === "string" ? parsed.summary : "Telefonni hovor",
    segments,
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.filter((a): a is string => typeof a === "string") : [],
  };
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

export async function summarizeTranscriptWithGemini(input: {
  transcript: string;
  segments: Array<{ speaker: string; text: string }>;
  apiKey: string;
}): Promise<{ summary: string; actionItems: string[]; language: string }> {
  const prompt = `Analyze this transcribed telephone call. Provide a concise summary (in the primary language of the call) and list explicit action items if any were mentioned.

Transcript:
${input.transcript}

Return JSON with format:
{
  "language": "cs",
  "summary": "Concise call summary",
  "actionItems": ["Action item 1", ...]
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": input.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!response.ok) {
      return {
        language: "cs",
        summary: "Telefonni hovor",
        actionItems: [],
      };
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as Partial<TranscriptionResult>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : "cs",
      summary: typeof parsed.summary === "string" ? parsed.summary : "Telefonni hovor",
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.filter((a): a is string => typeof a === "string")
        : [],
    };
  } catch {
    return {
      language: "cs",
      summary: "Telefonni hovor",
      actionItems: [],
    };
  }
}

