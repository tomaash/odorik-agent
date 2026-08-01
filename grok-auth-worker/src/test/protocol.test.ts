import assert from "node:assert/strict";
import test from "node:test";
import {
  addGrokSecretVersion,
  disableOtherGrokSecretVersions,
  extractDeviceAuthorization,
  validateGrokAuthDocument,
} from "../protocol.js";

test("extracts only the pinned Grok HTTPS device flow", () => {
  assert.deepEqual(extractDeviceAuthorization(`
    To sign in, open this URL in your browser:
    https://accounts.x.ai/oauth2/device?user_code=3DHX-65CK
    Confirm this code: 3DHX-65CK
  `), {
    verificationUri: "https://accounts.x.ai/oauth2/device?user_code=3DHX-65CK",
    userCode: "3DHX-65CK",
  });
  assert.equal(extractDeviceAuthorization(
    "https://evil.example/oauth2/device?user_code=3DHX-65CK",
  ), null);
});

test("accepts subscription OAuth auth.json and rejects API-key shaped state", () => {
  const valid = Buffer.from(JSON.stringify({
    "https://auth.x.ai::client": {
      auth_mode: "oidc",
      oidc_issuer: "https://auth.x.ai",
      refresh_token: "refresh-token-value-that-is-long-enough",
      email: "operator@example.com",
      principal_id: "principal-1",
      team_id: "team-1",
      expires_at: "2026-08-01T12:00:00.000Z",
    },
  }));
  assert.deepEqual(validateGrokAuthDocument(valid), {
    accountLabel: "operator@example.com",
    principalId: "principal-1",
    teamId: "team-1",
    expiresAt: "2026-08-01T12:00:00.000Z",
  });
  assert.throws(() => validateGrokAuthDocument(Buffer.from(JSON.stringify({
    "https://auth.x.ai::client": {
      auth_mode: "oidc",
      oidc_issuer: "https://auth.x.ai",
      refresh_token: "refresh-token-value-that-is-long-enough",
      email: "operator@example.com",
      principal_id: "principal-1",
      api_key: "forbidden",
    },
  }))));
  assert.throws(() => validateGrokAuthDocument(Buffer.from(JSON.stringify({
    "https://auth.x.ai::client": {
      auth_mode: "oauth",
      oidc_issuer: "https://auth.x.ai",
      refresh_token: "refresh-token-value-that-is-long-enough",
      email: "operator@example.com",
      principal_id: "principal-1",
    },
  }))), /not subscription OAuth/);
});

test("disconnect disables enabled versions without reading their payloads", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(`${init?.method || "GET"} ${String(url)}`);
    if (String(url).includes("/versions?")) {
      return new Response(JSON.stringify({
        versions: [
          { name: "projects/224347630361/secrets/grok-subscription-auth/versions/1", state: "ENABLED" },
          { name: "projects/224347630361/secrets/grok-subscription-auth/versions/2", state: "ENABLED" },
          { name: "projects/224347630361/secrets/grok-subscription-auth/versions/3", state: "DISABLED" },
        ],
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const disabled = await disableOtherGrokSecretVersions({
    projectId: "project-1",
    secretName: "grok-subscription-auth",
    keepVersion: "projects/project-1/secrets/grok-subscription-auth/versions/2",
    accessToken: "access-token",
    fetcher,
  });
  assert.equal(disabled, 1);
  assert.equal(requests.filter((request) => request.endsWith(":disable")).length, 1);
  assert.ok(requests.some((request) => request.includes(
    "projects/project-1/secrets/grok-subscription-auth/versions/1:disable",
  )));
  assert.ok(requests.every((request) => !request.includes(":access")));
});

test("canonicalizes Secret Manager's numeric project version name", async () => {
  const version = await addGrokSecretVersion({
    projectId: "project-1",
    secretName: "grok-subscription-auth",
    payload: Buffer.from("credential"),
    accessToken: "access-token",
    fetcher: async () => new Response(JSON.stringify({
      name: "projects/224347630361/secrets/grok-subscription-auth/versions/7",
    }), { status: 200 }),
  });
  assert.equal(
    version,
    "projects/project-1/secrets/grok-subscription-auth/versions/7",
  );
});
