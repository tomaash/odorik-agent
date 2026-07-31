const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:xai-|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED TOKEN]"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED GOOGLE KEY]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]"],
  [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"']+/gi, "$1[REDACTED]"],
  [/(X-Goog-(?:Signature|Credential|Security-Token)=)[^&\s]+/gi, "$1[REDACTED]"],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}

export function findLikelySecret(value: string): string | undefined {
  for (const [pattern, label] of SECRET_PATTERNS.slice(0, 5)) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return label.replaceAll("[", "").replaceAll("]", "");
  }
  return undefined;
}
