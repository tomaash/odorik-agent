import { createHash } from "node:crypto";

export type OdorikFields = Record<string, string>;

export function safeFileName(value: string): string {
  const baseName = value.split(/[\\/]/).pop() || value;
  const normalized = baseName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return normalized || "recording.bin";
}

export function recordingCallId(
  fields: OdorikFields,
  originalFileName: string,
): string {
  const supplied = fields.callid?.trim();
  if (supplied && /^[a-zA-Z0-9._-]{1,120}$/.test(supplied)) return supplied;

  return createHash("sha256")
    .update(
      [
        fields.from || "",
        fields.to || "",
        fields.time || "",
        fields.duration || "",
        originalFileName,
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 40);
}

export function audioMimeType(
  fileName: string,
  suppliedMimeType?: string,
): string {
  const supplied = suppliedMimeType?.toLowerCase();
  if (supplied?.startsWith("audio/")) return supplied;

  const extension = fileName.toLowerCase().split(".").pop();
  switch (extension) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}
