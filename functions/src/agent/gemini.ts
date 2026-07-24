export type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

export type GeminiPart = {
  text?: string;
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
  [key: string]: unknown;
};

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type ModelUsage = {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
};

export type ModelTurn = {
  content: GeminiContent;
  usage: ModelUsage;
};

export interface AgentModel {
  generate(input: {
    systemInstruction: string;
    contents: GeminiContent[];
    tools: unknown[];
    toolMode: "AUTO" | "ANY" | "NONE";
  }): Promise<ModelTurn>;
}

type GeminiPayload = {
  candidates?: Array<{ content?: GeminiContent }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { status?: string; message?: string };
};

const finalResponseSchema = {
  type: "OBJECT",
  properties: {
    answer: { type: "STRING" },
    citationIds: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    limitations: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["answer", "citationIds", "confidence", "limitations"],
};

export class GeminiRestAgentModel implements AgentModel {
  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-3.5-flash-lite",
  ) {}

  async generate(input: {
    systemInstruction: string;
    contents: GeminiContent[];
    tools: unknown[];
    toolMode: "AUTO" | "ANY" | "NONE";
  }): Promise<ModelTurn> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemInstruction }] },
          contents: input.contents,
          ...(input.tools.length ? {
            tools: [{ functionDeclarations: input.tools }],
            toolConfig: { functionCallingConfig: { mode: input.toolMode } },
          } : {}),
          generationConfig: {
            temperature: 0,
            ...(input.toolMode === "ANY" ? {} : {
              responseMimeType: "application/json",
              responseSchema: finalResponseSchema,
            }),
          },
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    const payload = await response.json() as GeminiPayload;
    if (!response.ok) {
      throw new Error(
        `Gemini ${payload.error?.status || response.status}: ${payload.error?.message || "agent request failed"}`,
      );
    }
    const content = payload.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error("Gemini returned an empty agent turn");
    const usage = payload.usageMetadata || {};
    return {
      content,
      usage: {
        promptTokens: Number(usage.promptTokenCount || 0),
        outputTokens: Number(usage.candidatesTokenCount || 0),
        thinkingTokens: Number(usage.thoughtsTokenCount || 0),
        totalTokens: Number(usage.totalTokenCount || 0),
      },
    };
  }
}
