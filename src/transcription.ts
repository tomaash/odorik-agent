export type TranscriptionProvider = "gemini" | "deepgram";

export type TranscriptionSegment = {
  speaker: string;
  text: string;
  startSeconds?: number;
  endSeconds?: number;
};

export type SpeechTranscriptionResult = {
  provider: TranscriptionProvider;
  model: string;
  language: string;
  transcript: string;
  segments: TranscriptionSegment[];
};
