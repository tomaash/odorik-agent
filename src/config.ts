export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function projectId(): string {
  return (
    process.env.PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    requiredEnv("PROJECT_ID")
  );
}

export const firestoreDatabaseId =
  process.env.FIRESTORE_DATABASE_ID?.trim() || "odorik";

export const geminiModel =
  process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";

export function transcriptionProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): "gemini" | "deepgram" {
  const provider = environment.TRANSCRIPTION_PROVIDER?.trim().toLowerCase() || "gemini";
  if (provider !== "gemini" && provider !== "deepgram") {
    throw new Error(
      `TRANSCRIPTION_PROVIDER must be "gemini" or "deepgram", received: ${provider}`,
    );
  }
  return provider;
}

export const transcriptionProvider = transcriptionProviderFromEnvironment();

export const geminiTranscriptionModel =
  process.env.GEMINI_TRANSCRIPTION_MODEL?.trim() || "gemini-3.5-transcribe";

export const port = Number.parseInt(process.env.PORT || "8080", 10);
