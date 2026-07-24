export type TranscriptionResult = {
    language: string;
    transcript: string;
    summary: string;
    segments: Array<{
        speaker: string;
        text: string;
    }>;
    actionItems: string[];
};
export declare function parseGeminiJson(text: string): TranscriptionResult;
export declare function transcribeAudio(input: {
    audio: Buffer;
    mimeType: string;
    apiKey: string;
}): Promise<TranscriptionResult>;
//# sourceMappingURL=gemini.d.ts.map