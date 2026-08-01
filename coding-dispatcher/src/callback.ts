const metadataIdentityUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[opaque]")
    .replace(/(?:\/[^\s/]+){2,}/g, "[path]")
    .slice(0, 500);
}

async function identityToken(audience: string): Promise<string> {
  const url = new URL(metadataIdentityUrl);
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`metadata identity request failed (${response.status})`);
  return (await response.text()).trim();
}

export async function callback(input: {
  callbackUrl: string;
  event: Record<string, unknown>;
}): Promise<void> {
  const body = JSON.stringify(input.event);
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error("callback is too large");
  const token = process.env.CODING_CALLBACK_ID_TOKEN || await identityToken(input.callbackUrl);
  const response = await fetch(input.callbackUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`callback failed (${response.status})`);
}

export { safeError };
