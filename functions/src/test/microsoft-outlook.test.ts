import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import { encryptCredentials } from "../connectors/credentials.js";
import {
  outlookInboxResourceId,
  outlookMailContextItemId,
  syncMicrosoftOutlookConnection,
} from "../connectors/microsoft-outlook.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "company-outlook";
const connectionId = "microsoft-consumer-1";
const credentialKey = Buffer.alloc(32, 19).toString("base64");
const now = Timestamp.fromDate(new Date("2026-08-17T10:00:00.000Z"));
const connectionPath = `companies/${companyId}/connections/${connectionId}`;

function seedOutlook(memory: MemoryFirestore): void {
  memory.seed(connectionPath, {
    companyId,
    connectorId: "microsoft_365",
    status: "active",
    createdBy: "member-1",
    tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
    credentialRevision: 1,
    credentialCiphertext: encryptCredentials({
      accessToken: "outlook-access-token",
      refreshToken: "outlook-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      accessTokenScopes: "openid profile offline_access User.Read Mail.Read Mail.ReadWrite",
      consentedScopes: "openid profile offline_access User.Read Mail.Read Mail.ReadWrite",
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/mail`, {
    capabilityId: "context.mail.read_scoped",
    serviceId: "mail",
    status: "permission_granted",
    grantedScopes: ["Mail.Read"],
    stats: {},
  });
}

function graphResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Outlook imports a fixed restricted Inbox window and resumes from the opaque delta link", async () => {
  const memory = new MemoryFirestore();
  seedOutlook(memory);
  const requested: URL[] = [];
  let incremental = false;
  const request = (async (value: string | URL | Request) => {
    const url = new URL(String(value));
    requested.push(url);
    if (incremental) {
      assert.equal(url.searchParams.get("$deltatoken"), "cursor-1");
      return graphResponse({
        value: [{ id: "message-1", "@removed": { reason: "deleted" } }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=cursor-2",
      });
    }
    return graphResponse({
      value: [{
        id: "message-1",
        changeKey: "v1",
        conversationId: "conversation-1",
        internetMessageId: "<test-1@outlook.com>",
        subject: "Outlook test mail",
        bodyPreview: "This is the preview",
        body: { contentType: "html", content: "<p>Hello <b>Erik</b></p>" },
        from: { emailAddress: { address: "sender@example.com" } },
        toRecipients: [{ emailAddress: { address: "tomas.holas@outlook.com" } }],
        receivedDateTime: "2026-08-17T09:30:00.000Z",
        lastModifiedDateTime: "2026-08-17T09:31:00.000Z",
        hasAttachments: false,
        isDraft: false,
        webLink: "https://outlook.live.com/mail/0/id/test",
      }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=cursor-1",
    });
  }) as typeof fetch;

  const first = await syncMicrosoftOutlookConnection({
    companyId, connectionId, clientId: "client", clientSecret: "secret", credentialKey,
    requestedBy: "scheduler:outlook-mail", database: memory.asFirestore(), fetch: request, now: () => now,
  });
  assert.equal(first.status, "succeeded");
  assert.equal(requested[0]?.pathname, "/v1.0/me/mailFolders/inbox/messages/delta");
  assert.match(requested[0]?.searchParams.get("$filter") || "", /^receivedDateTime ge 2026-/);
  assert.equal(requested[0]?.searchParams.get("$orderby"), "receivedDateTime desc");

  const resource = memory.read(`${connectionPath}/resources/${outlookInboxResourceId}`);
  assert.equal(resource?.externalId, "inbox");
  assert.deepEqual(resource?.audience, { visibility: "restricted", memberIds: ["member-1"] });
  assert.match(String(resource?.deltaLink), /cursor-1/);
  assert.equal(memory.read(`${connectionPath}/capabilities/mail`)?.status, "active");

  const itemPath = `companies/${companyId}/contextItems/${outlookMailContextItemId(connectionId, "message-1")}`;
  const item = memory.read(itemPath);
  assert.equal(item?.title, "Outlook test mail");
  assert.match(String(item?.text), /Hello Erik/);
  assert.deepEqual(item?.access, { visibility: "restricted", memberIds: ["member-1"] });
  assert.equal((item?.metadata as Record<string, unknown>).sourceUrl, "https://outlook.live.com/mail/0/id/test");

  incremental = true;
  const second = await syncMicrosoftOutlookConnection({
    companyId, connectionId, clientId: "client", clientSecret: "secret", credentialKey,
    requestedBy: "member-1", database: memory.asFirestore(), fetch: request, now: () => now,
  });
  assert.equal(second.status, "succeeded");
  assert.equal(memory.read(itemPath), undefined, "Graph @removed must remove normalized evidence");
  assert.match(String(memory.read(`${connectionPath}/resources/${outlookInboxResourceId}`)?.deltaLink), /cursor-2/);
});

test("an expired Outlook delta cursor rebuilds from the bounded Inbox window", async () => {
  const memory = new MemoryFirestore();
  seedOutlook(memory);
  memory.seed(`${connectionPath}/resources/${outlookInboxResourceId}`, {
    connectionId,
    capabilityId: "context.mail.read_scoped",
    status: "enabled",
    externalId: "inbox",
    audience: { visibility: "restricted", memberIds: ["member-1"] },
    audienceRevision: 2,
    deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired",
  });
  let calls = 0;
  const request = (async (value: string | URL | Request) => {
    calls += 1;
    const url = new URL(String(value));
    if (calls === 1) return graphResponse({ error: { code: "SyncStateNotFound", message: "expired" } }, 410);
    assert.ok(url.searchParams.has("$filter"), "fallback must remain bounded to the initial window");
    return graphResponse({ value: [], "@odata.deltaLink": `${url.origin}${url.pathname}?$deltatoken=fresh` });
  }) as typeof fetch;
  const result = await syncMicrosoftOutlookConnection({
    companyId, connectionId, clientId: "client", clientSecret: "secret", credentialKey,
    requestedBy: "member-1", database: memory.asFirestore(), fetch: request, now: () => now,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2);
});
