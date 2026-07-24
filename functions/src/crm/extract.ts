import { extractionSchema, type ExtractionResult, type FieldProposal } from "./schemas.js";

export const intakePromptVersion = "intake-v1";
export const intakeSchemaVersion = 1;
export const crmModel = "gemini-3.5-flash-lite";

const responseSchema = {
  type: "OBJECT",
  properties: {
    proposals: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          field: {
            type: "STRING",
            enum: [
              "contactName",
              "requestTitle",
              "serviceType",
              "description",
              "address",
              "requestedTiming",
              "urgency",
              "notes",
            ],
          },
          value: { type: "STRING" },
          support: { type: "STRING", enum: ["explicit", "inferred"] },
          evidence: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                segmentIndex: { type: "INTEGER" },
                quote: { type: "STRING" },
              },
              required: ["segmentIndex", "quote"],
            },
          },
        },
        required: ["field", "value", "support", "evidence"],
      },
    },
    missingInformation: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["proposals", "missingInformation"],
};

type Segment = { speaker?: string; text?: string };

function cleanJson(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function validateProposalEvidence(
  proposals: FieldProposal[],
  transcript: string,
  segments: Segment[],
): FieldProposal[] {
  const normalizedTranscript = normalizeText(transcript);
  return proposals.flatMap((proposal) => {
    const evidence = proposal.evidence.filter((item) => {
      const quote = normalizeText(item.quote);
      if (!quote) return false;
      const segment = segments[item.segmentIndex]?.text || "";
      return normalizeText(segment).includes(quote) || normalizedTranscript.includes(quote);
    });
    if (proposal.support === "explicit" && evidence.length === 0) return [];
    return [{ ...proposal, evidence }];
  });
}

export async function extractIntake(input: {
  transcript: string;
  segments: Segment[];
  from?: string | null;
  to?: string | null;
  apiKey: string;
}): Promise<ExtractionResult> {
  const numberedSegments = input.segments
    .map((segment, index) => `[${index}] ${segment.speaker || "speaker"}: ${segment.text || ""}`)
    .join("\n");

  const prompt = `You extract a reviewable service-business CRM intake from a telephone transcript.

Rules:
- Propose facts; never claim they are confirmed company truth.
- Use only facts supported by the transcript.
- Mark a proposal explicit only when the caller clearly stated it.
- Inferred proposals are allowed only when operationally helpful and must be labeled inferred.
- Every explicit proposal needs an exact short quote and the matching segment index.
- Do not extract the caller phone number; trusted call metadata supplies it.
- requestedTiming is a customer preference, never a confirmed appointment.
- urgency must be exactly normal or urgent.
- Omit unknown fields instead of guessing.
- List information that is still needed to understand or act on the request.

Trusted metadata:
from: ${input.from || "unknown"}
to: ${input.to || "unknown"}

Numbered transcript segments:
${numberedSegments || `[0] ${input.transcript}`}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(crmModel)}:generateContent`,
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
          responseSchema,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { status?: string; message?: string };
  };
  if (!response.ok) {
    throw new Error(
      `Gemini ${payload.error?.status || response.status}: ${payload.error?.message || "request failed"}`,
    );
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned no CRM extraction");
  const parsed = extractionSchema.parse(JSON.parse(cleanJson(text)));
  return {
    proposals: validateProposalEvidence(parsed.proposals, input.transcript, input.segments),
    missingInformation: [...new Set(parsed.missingInformation.map((item) => item.trim()).filter(Boolean))],
  };
}
