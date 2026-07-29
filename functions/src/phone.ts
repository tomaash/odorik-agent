/**
 * Normalize a caller number to E.164.
 *
 * Bare nine-digit numbers are assumed Czech, which is the only locale the
 * telephony connector currently serves. Anything already carrying a country
 * prefix keeps it.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`;
  if (digits.startsWith("00") && digits.length >= 10) return `+${digits.slice(2)}`;
  if (digits.length === 9) return `+420${digits}`;
  return `+${digits}`;
}
