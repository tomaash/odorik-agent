import { redactSecrets } from "./redact.js";

const MAX_CALLBACK_BYTES = 128 * 1024;
const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export type CodingCallbackEvent = {
  eventId: string;
  runId: string;
  type: "phase" | "completed" | "failed";
  phase: string;
  status: "running" | "ready_to_publish" | "failed";
  message: string;
  executionName?: string;
  result?: Record<string, unknown>;
};

async function identityToken(audience: string): Promise<string> {
  const url = new URL(METADATA_IDENTITY_URL);
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`metadata identity request failed (${response.status})`);
  return (await response.text()).trim();
}

export async function sendCodingCallback(
  callbackUrl: string | undefined,
  event: CodingCallbackEvent,
): Promise<void> {
  if (!callbackUrl) return;
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_CALLBACK_BYTES) {
    throw new Error("coding callback exceeds its size limit");
  }
  const token = process.env.CODING_CALLBACK_ID_TOKEN
    || await identityToken(callbackUrl);
  const response = await fetch(callbackUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agent-erik-coding-runner/0.1",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = redactSecrets((await response.text()).slice(0, 500));
    throw new Error(`coding callback failed (${response.status}): ${detail}`);
  }
}
