import { URL } from "node:url";

export type DeviceAuthorization = {
  verificationUri: string;
  userCode: string;
};

export type GrokAccountSummary = {
  accountLabel: string;
  principalId: string;
  teamId: string | null;
  expiresAt: string | null;
};

type FetchLike = typeof fetch;

const ansiPattern = /\u001b\[[0-9;]*m/g;
const deviceCodePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const secretNamePattern = /^[A-Za-z0-9_-]{1,255}$/;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractDeviceAuthorization(output: string): DeviceAuthorization | null {
  const clean = output.replace(ansiPattern, "");
  const urlMatch = clean.match(/https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9-]{9})/);
  if (!urlMatch?.[0] || !urlMatch[1] || !deviceCodePattern.test(urlMatch[1])) return null;
  const parsed = new URL(urlMatch[0]);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "accounts.x.ai"
    || parsed.pathname !== "/oauth2/device"
    || parsed.searchParams.get("user_code") !== urlMatch[1]
  ) return null;
  return { verificationUri: parsed.toString(), userCode: urlMatch[1] };
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

export function validateGrokAuthDocument(raw: Buffer): GrokAccountSummary {
  if (raw.length < 100 || raw.length > 64 * 1024) {
    throw new Error("Grok OAuth session has an invalid size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Grok OAuth session is not valid JSON");
  }
  const root = objectValue(parsed);
  const entries = root ? Object.entries(root) : [];
  if (entries.length !== 1 || !entries[0]?.[0].startsWith("https://auth.x.ai::")) {
    throw new Error("Grok OAuth session has an unexpected issuer");
  }
  const account = objectValue(entries[0][1]);
  const refreshToken = boundedString(account?.refresh_token, 16_384);
  const authMode = boundedString(account?.auth_mode, 100);
  const issuer = boundedString(account?.oidc_issuer, 500);
  const email = boundedString(account?.email, 320);
  const principalId = boundedString(account?.principal_id, 500)
    || boundedString(account?.user_id, 500);
  if (!refreshToken || !authMode || !issuer || !email || !principalId) {
    throw new Error("Grok OAuth session is incomplete");
  }
  // The official Grok CLI serializes both OAuth2 and enterprise OIDC sessions
  // as AuthMode::Oidc (`"oidc"`). Do not infer provenance from an "oauth"
  // substring: that rejected the CLI's real device-code credential format.
  if (authMode !== "oidc" || issuer !== "https://auth.x.ai") {
    throw new Error("Grok session is not subscription OAuth");
  }
  if (Object.keys(account || {}).some((key) => key.toLowerCase().includes("api_key"))) {
    throw new Error("Grok API-key authentication is forbidden");
  }
  const expiresAt = boundedString(account?.expires_at, 100);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw new Error("Grok OAuth expiry is invalid");
  }
  return {
    accountLabel: email,
    principalId,
    teamId: boundedString(account?.team_id, 500),
    expiresAt,
  };
}

async function metadataRequest(path: string, fetcher: FetchLike): Promise<Response> {
  const response = await fetcher(
    `http://metadata.google.internal/computeMetadata/v1/${path}`,
    { headers: { "metadata-flavor": "Google" } },
  );
  if (!response.ok) throw new Error(`Metadata identity request failed (${response.status})`);
  return response;
}

export async function metadataIdentityToken(
  audience: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const response = await metadataRequest(
    `instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`,
    fetcher,
  );
  const token = (await response.text()).trim();
  if (token.split(".").length !== 3) throw new Error("Metadata identity token is invalid");
  return token;
}

export async function metadataAccessToken(fetcher: FetchLike = fetch): Promise<string> {
  const response = await metadataRequest(
    "instance/service-accounts/default/token",
    fetcher,
  );
  const payload = objectValue(await response.json());
  const token = boundedString(payload?.access_token, 16_384);
  if (!token) throw new Error("Metadata access token is invalid");
  return token;
}

function assertSecretName(secretName: string): void {
  if (!secretNamePattern.test(secretName)) throw new Error("Unsafe Grok secret name");
}

function secretVersionId(resourceName: string, secretName: string): string | null {
  const parts = resourceName.split("/");
  if (
    parts.length !== 6
    || parts[0] !== "projects"
    || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,})$/.test(parts[1] || "")
    || parts[2] !== "secrets"
    || parts[3] !== secretName
    || parts[4] !== "versions"
    || !/^[1-9][0-9]*$/.test(parts[5] || "")
  ) return null;
  return parts[5] || null;
}

async function secretManagerRequest(
  path: string,
  accessToken: string,
  init: RequestInit,
  fetcher: FetchLike,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://secretmanager.googleapis.com/v1/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Secret Manager request failed (${response.status})`);
  return objectValue(await response.json()) || {};
}

export async function addGrokSecretVersion(input: {
  projectId: string;
  secretName: string;
  payload: Buffer;
  accessToken: string;
  fetcher?: FetchLike;
}): Promise<string> {
  assertSecretName(input.secretName);
  const result = await secretManagerRequest(
    `projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.secretName)}:addVersion`,
    input.accessToken,
    {
      method: "POST",
      body: JSON.stringify({ payload: { data: input.payload.toString("base64") } }),
    },
    input.fetcher || fetch,
  );
  const name = boundedString(result.name, 1_000);
  const versionId = name ? secretVersionId(name, input.secretName) : null;
  if (!versionId) throw new Error("Secret Manager did not return a valid version name");
  // Secret Manager canonicalizes project IDs to project numbers in resource
  // names. Return our project-ID form so downstream tenant checks stay exact.
  return `projects/${input.projectId}/secrets/${input.secretName}/versions/${versionId}`;
}

export async function disableOtherGrokSecretVersions(input: {
  projectId: string;
  secretName: string;
  keepVersion?: string;
  accessToken: string;
  fetcher?: FetchLike;
}): Promise<number> {
  assertSecretName(input.secretName);
  const fetcher = input.fetcher || fetch;
  const parent = `projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.secretName)}`;
  const keepVersionId = input.keepVersion
    ? secretVersionId(input.keepVersion, input.secretName)
    : null;
  if (input.keepVersion && !keepVersionId) {
    throw new Error("Unsafe Grok secret version to keep");
  }
  let disabled = 0;
  let pageToken: string | null = null;
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const result = await secretManagerRequest(
      `${parent}/versions?${query.toString()}`,
      input.accessToken,
      { method: "GET" },
      fetcher,
    );
    const versions = Array.isArray(result.versions) ? result.versions : [];
    for (const value of versions) {
      const version = objectValue(value);
      const name = boundedString(version?.name, 1_000);
      if (version?.state !== "ENABLED" || !name) continue;
      const versionId = secretVersionId(name, input.secretName);
      if (!versionId) {
        throw new Error("Secret Manager returned an unexpected version");
      }
      if (versionId === keepVersionId) continue;
      await secretManagerRequest(
        `${parent}/versions/${versionId}:disable`,
        input.accessToken,
        { method: "POST", body: "{}" },
        fetcher,
      );
      disabled += 1;
    }
    pageToken = boundedString(result.nextPageToken, 2_000);
  } while (pageToken);
  return disabled;
}

export async function postAuthCallback(input: {
  callbackUrl: string;
  event: Record<string, unknown>;
  fetcher?: FetchLike;
}): Promise<void> {
  const callback = new URL(input.callbackUrl);
  if (callback.protocol !== "https:") throw new Error("Grok auth callback must use HTTPS");
  const fetcher = input.fetcher || fetch;
  const identityToken = await metadataIdentityToken(callback.origin + callback.pathname, fetcher);
  const response = await fetcher(callback.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${identityToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.event),
  });
  if (!response.ok) throw new Error(`Grok auth callback failed (${response.status})`);
}
