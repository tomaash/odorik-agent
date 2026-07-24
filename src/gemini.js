import { geminiModel } from "./config.js";
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
function repairTruncatedJson(jsonString) {
    let s = jsonString.trim();
    let inString = false;
    let isEscaped = false;
    for (let i = 0; i < s.length; i++) {
        const char = s[i];
        if (char === "\\" && !isEscaped) {
            isEscaped = true;
        }
        else {
            if (char === '"' && !isEscaped) {
                inString = !inString;
            }
            isEscaped = false;
        }
    }
    if (inString) {
        s += '"';
    }
    const stack = [];
    inString = false;
    isEscaped = false;
    for (let i = 0; i < s.length; i++) {
        const char = s[i];
        if (char === "\\" && !isEscaped) {
            isEscaped = true;
        }
        else {
            if (char === '"' && !isEscaped) {
                inString = !inString;
            }
            else if (!inString) {
                if (char === "{" || char === "[") {
                    stack.push(char);
                }
                else if (char === "}" || char === "]") {
                    stack.pop();
                }
            }
            isEscaped = false;
        }
    }
    while (stack.length > 0) {
        const open = stack.pop();
        if (open === "{")
            s += "}";
        else if (open === "[")
            s += "]";
    }
    return s;
}
export function parseGeminiJson(text) {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    let parsed = {};
    try {
        parsed = JSON.parse(cleaned);
    }
    catch (err) {
        try {
            const repaired = repairTruncatedJson(cleaned);
            parsed = JSON.parse(repaired);
        }
        catch {
            throw new Error(`Gemini returned invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const segments = Array.isArray(parsed.segments)
        ? parsed.segments.filter((s) => Boolean(s && typeof s.speaker === "string" && typeof s.text === "string"))
        : [];
    const transcript = typeof parsed.transcript === "string" && parsed.transcript.trim()
        ? parsed.transcript
        : segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
    return {
        language: typeof parsed.language === "string" ? parsed.language : "cs",
        transcript: transcript || "Prepis hovoru",
        summary: typeof parsed.summary === "string" ? parsed.summary : "Telefonni hovor",
        segments,
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.filter((a) => typeof a === "string") : [],
    };
}
export async function transcribeAudio(input) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
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
                            text: "Transcribe this telephone call faithfully. Preserve names, numbers, and important wording. " +
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
    });
    const payload = (await response.json());
    if (!response.ok) {
        throw new Error(`Gemini ${payload.error?.status || response.status}: ${payload.error?.message || "request failed"}`);
    }
    const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";
    if (!text)
        throw new Error("Gemini returned no transcription");
    return parseGeminiJson(text);
}
//# sourceMappingURL=gemini.js.map