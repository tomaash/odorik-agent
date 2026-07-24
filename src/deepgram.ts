import { requiredEnv } from "./config.js";

export type DeepgramTranscriptionResult = {
  language: string;
  transcript: string;
  summary: string;
  segments: Array<{ speaker: string; text: string }>;
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
    body: input.audio,
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
  const segments: Array<{ speaker: string; text: string }> = [];

  const paragraphs = alternative.paragraphs?.paragraphs || [];
  if (paragraphs.length > 0) {
    for (const p of paragraphs) {
      const speakerLabel = `Speaker ${p.speaker ?? 0}`;
      const paragraphText =
        p.sentences?.map((s: any) => s.text).join(" ") || p.transcript || "";
      if (paragraphText.trim()) {
        segments.push({
          speaker: speakerLabel,
          text: paragraphText.trim(),
        });
      }
    }
  } else if (alternative.words && alternative.words.length > 0) {
    let currentSpeaker: number | null = null;
    let currentText = "";

    for (const word of alternative.words) {
      const wordSpeaker = word.speaker ?? 0;
      if (currentSpeaker === null) {
        currentSpeaker = wordSpeaker;
        currentText = word.punctuated_word || word.word;
      } else if (currentSpeaker === wordSpeaker) {
        currentText += ` ${word.punctuated_word || word.word}`;
      } else {
        segments.push({
          speaker: `Speaker ${currentSpeaker}`,
          text: currentText.trim(),
        });
        currentSpeaker = wordSpeaker;
        currentText = word.punctuated_word || word.word;
      }
    }
    if (currentText.trim() && currentSpeaker !== null) {
      segments.push({
        speaker: `Speaker ${currentSpeaker}`,
        text: currentText.trim(),
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
