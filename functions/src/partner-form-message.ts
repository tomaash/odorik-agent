import { z } from "zod";

// The website posts this from a public page, so every field is capped and the
// honeypot must stay empty — a bot filling every input is the cheap case to
// catch before spending a Resend call on it.
export const partnerFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  message: z.string().trim().min(1).max(4000),
  locale: z.enum(["cs", "en"]).optional().default("cs"),
  // Hidden input; humans never see it, so anything here is a bot.
  website: z.string().max(200).optional().default(""),
});

export type PartnerFormInput = z.infer<typeof partnerFormSchema>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function partnerFormSubject(input: PartnerFormInput): string {
  return `Pilotní partner: ${input.name}`;
}

export function renderPartnerFormEmail(input: PartnerFormInput): string {
  const rows: [string, string][] = [
    ["Jméno", input.name],
    ["E-mail", input.email],
    ["Jazyk webu", input.locale],
  ];
  const table = rows
    .map(([label, value]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#71717a;">${label}</td>`
      + `<td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const message = `<p style="white-space:pre-wrap;margin-top:16px;">${escapeHtml(input.message)}</p>`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;">`
    + `<table style="border-collapse:collapse;">${table}</table>${message}</div>`;
}

// One submission per address per minute, per instance. Enough to stop a form
// being hammered without a Firestore round trip on every request.
const lastSubmission = new Map<string, number>();
const throttleWindowMs = 60_000;

export function isThrottled(
  key: string,
  now: number,
  seen: Map<string, number> = lastSubmission,
): boolean {
  const previous = seen.get(key);
  for (const [entry, at] of seen) {
    if (now - at > throttleWindowMs) seen.delete(entry);
  }
  if (previous !== undefined && now - previous < throttleWindowMs) return true;
  seen.set(key, now);
  return false;
}
