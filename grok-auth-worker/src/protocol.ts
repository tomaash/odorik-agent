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

export type GrokSecretVersion = {
  name: string;
  payload: Buffer;
};

export type GrokRefreshResult = {
  payload: Buffer;
  account: GrokAccountSummary;
  refreshed: boolean;
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

function canonicalSecretVersion(
  resourceName: string,
  projectId: string,
  secretName: string,
): string {
  const versionId = secretVersionId(resourceName, secretName);
  if (!versionId) throw new Error("Secret Manager returned an invalid Grok secret version");
  return `projects/${projectId}/secrets/${secretName}/versions/${versionId}`;
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

export async function accessLatestGrokSecretVersion(input: {
  projectId: string;
  secretName: string;
  accessToken: string;
  fetcher?: FetchLike;
}): Promise<GrokSecretVersion> {
  assertSecretName(input.secretName);
  const result = await secretManagerRequest(
    `projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.secretName)}/versions/latest:access`,
    input.accessToken,
    { method: "GET" },
    input.fetcher || fetch,
  );
  const name = boundedString(result.name, 1_000);
  const payload = objectValue(result.payload);
  const encoded = boundedString(payload?.data, 128 * 1024);
  if (!name || !encoded) throw new Error("Secret Manager returned an incomplete Grok credential");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 100 || decoded.length > 64 * 1024) {
    decoded.fill(0);
    throw new Error("Secret Manager returned an invalid Grok credential size");
  }
  return {
    name: canonicalSecretVersion(name, input.projectId, input.secretName),
    payload: decoded,
  };
}

function authDocument(raw: Buffer): {
  root: Record<string, unknown>;
  issuerKey: string;
  account: Record<string, unknown>;
} {
  validateGrokAuthDocument(raw);
  const root = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const [issuerKey, value] = Object.entries(root)[0] || [];
  const account = objectValue(value);
  if (!issuerKey || !account) throw new Error("Grok OAuth session is incomplete");
  return { root, issuerKey, account };
}

function refreshIsRequired(account: Record<string, unknown>, now: Date): boolean {
  const expiresAt = boundedString(account.expires_at, 100);
  return !expiresAt || Date.parse(expiresAt) <= now.getTime() + 5 * 60 * 1000;
}

async function retryingFetch(
  input: string,
  init: RequestInit,
  fetcher: FetchLike,
): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetcher(input, init);
    if (response.ok || (response.status < 500 && response.status !== 429)) return response;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  return response as Response;
}

export async function refreshGrokAuthDocument(input: {
  payload: Buffer;
  fetcher?: FetchLike;
  now?: Date;
}): Promise<GrokRefreshResult> {
  const fetcher = input.fetcher || fetch;
  const now = input.now || new Date();
  const current = authDocument(input.payload);
  const summary = validateGrokAuthDocument(input.payload);
  if (!refreshIsRequired(current.account, now)) {
    return { payload: Buffer.from(input.payload), account: summary, refreshed: false };
  }
  const issuer = boundedString(current.account.oidc_issuer, 500);
  const clientId = boundedString(current.account.oidc_client_id, 500);
  const refreshToken = boundedString(current.account.refresh_token, 16_384);
  if (issuer !== "https://auth.x.ai" || !clientId || !refreshToken) {
    throw new Error("Grok OAuth session cannot be refreshed");
  }
  const discovery = await retryingFetch(
    `${issuer}/.well-known/openid-configuration`,
    { method: "GET" },
    fetcher,
  );
  if (!discovery.ok) throw new Error(`Grok OIDC discovery failed (${discovery.status})`);
  const discoveryBody = objectValue(await discovery.json());
  const tokenEndpoint = boundedString(discoveryBody?.token_endpoint, 1_000);
  if (tokenEndpoint !== "https://auth.x.ai/oauth2/token") {
    throw new Error("Grok OIDC discovery returned an untrusted token endpoint");
  }
  const parameters = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const principalType = boundedString(current.account.principal_type, 100);
  const principalId = boundedString(current.account.principal_id, 500);
  if (principalType) parameters.set("principal_type", principalType);
  if (principalId) parameters.set("principal_id", principalId);
  const refreshed = await retryingFetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters.toString(),
  }, fetcher);
  if (!refreshed.ok) throw new Error(`Grok OAuth refresh failed (${refreshed.status})`);
  const tokenBody = objectValue(await refreshed.json());
  const accessToken = boundedString(tokenBody?.access_token, 32_768);
  const rotatedRefreshToken = boundedString(tokenBody?.refresh_token, 16_384) || refreshToken;
  const expiresIn = Number(tokenBody?.expires_in);
  if (!accessToken || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
    throw new Error("Grok OAuth refresh returned an invalid token response");
  }
  const refreshedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const nextAccount = {
    ...current.account,
    key: accessToken,
    refresh_token: rotatedRefreshToken,
    create_time: refreshedAt,
    expires_at: expiresAt,
  };
  const payload = Buffer.from(JSON.stringify({
    ...current.root,
    [current.issuerKey]: nextAccount,
  }));
  return {
    payload,
    account: validateGrokAuthDocument(payload),
    refreshed: true,
  };
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
