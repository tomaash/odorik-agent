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
  process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite";

export const port = Number.parseInt(process.env.PORT || "8080", 10);
