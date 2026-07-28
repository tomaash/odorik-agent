import { requiredEnv } from "./config.js";

export type DeepgramTranscriptionResult = {
  language: string;
  transcript: string;
  summary: string;
  segments: Array<{
    speaker: string;
    text: string;
    startSeconds?: number;
    endSeconds?: number;
  }>;
  actionItems: string[];
};

export async function transcribeAudioWithDeepgram(input: {
  audio: Buffer;
  mimeType: string;
  deepgramApiKey?: string;
}): Promise<DeepgramTranscriptionResult> {
  const apiKey =
    input.deepgramApiKey ||
    process.env.DEEPGRAM_API_KEY ||
    requiredEnv("DEEPGRAM_API_KEY");

  const url =
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&detect_language=true&punctuate=true";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": input.mimeType || "audio/ogg",
    },
    body: new Uint8Array(input.audio),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram STT failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as any;
  const channel = data.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const detectedLanguage = channel?.detected_language || alternative?.languages?.[0] || "cs";
  if (!alternative) {
    throw new Error("Deepgram returned an empty transcription alternative");
  }

  const fullTranscript = alternative.transcript || "";
  const segments: DeepgramTranscriptionResult["segments"] = [];

  const paragraphs = alternative.paragraphs?.paragraphs || [];
  if (paragraphs.length > 0) {
    for (const p of paragraphs) {
      const speakerLabel = `Speaker ${p.speaker ?? 0}`;
      const paragraphText =
        p.sentences?.map((s: any) => s.text).join(" ") || p.transcript || "";
      if (paragraphText.trim()) {
        const firstSentence = p.sentences?.[0];
        const lastSentence = p.sentences?.[p.sentences.length - 1];
        const startSeconds = Number(p.start ?? firstSentence?.start);
        const endSeconds = Number(p.end ?? lastSentence?.end);
        segments.push({
          speaker: speakerLabel,
          text: paragraphText.trim(),
          ...(Number.isFinite(startSeconds) ? { startSeconds } : {}),
          ...(Number.isFinite(endSeconds) ? { endSeconds } : {}),
        });
      }
    }
  } else if (alternative.words && alternative.words.length > 0) {
    let currentSpeaker: number | null = null;
    let currentText = "";
    let currentStart: number | undefined;
    let currentEnd: number | undefined;

    for (const word of alternative.words) {
      const wordSpeaker = word.speaker ?? 0;
      if (currentSpeaker === null) {
        currentSpeaker = wordSpeaker;
        currentText = word.punctuated_word || word.word;
        currentStart = Number.isFinite(Number(word.start)) ? Number(word.start) : undefined;
        currentEnd = Number.isFinite(Number(word.end)) ? Number(word.end) : undefined;
      } else if (currentSpeaker === wordSpeaker) {
        currentText += ` ${word.punctuated_word || word.word}`;
        currentEnd = Number.isFinite(Number(word.end)) ? Number(word.end) : currentEnd;
      } else {
        segments.push({
          speaker: `Speaker ${currentSpeaker}`,
          text: currentText.trim(),
          ...(currentStart === undefined ? {} : { startSeconds: currentStart }),
          ...(currentEnd === undefined ? {} : { endSeconds: currentEnd }),
        });
        currentSpeaker = wordSpeaker;
        currentText = word.punctuated_word || word.word;
        currentStart = Number.isFinite(Number(word.start)) ? Number(word.start) : undefined;
        currentEnd = Number.isFinite(Number(word.end)) ? Number(word.end) : undefined;
      }
    }
    if (currentText.trim() && currentSpeaker !== null) {
      segments.push({
        speaker: `Speaker ${currentSpeaker}`,
        text: currentText.trim(),
        ...(currentStart === undefined ? {} : { startSeconds: currentStart }),
        ...(currentEnd === undefined ? {} : { endSeconds: currentEnd }),
      });
    }
  }

  if (segments.length === 0 && fullTranscript.trim()) {
    segments.push({
      speaker: "Speaker 0",
      text: fullTranscript.trim(),
    });
  }

  return {
    language: detectedLanguage,
    transcript: fullTranscript || segments.map((s) => `${s.speaker}: ${s.text}`).join("\n"),
    summary: "",
    segments,
    actionItems: [],
  };
}
