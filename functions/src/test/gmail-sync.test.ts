import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  mailContextItemId,
  mailMessageBody,
  mailMessageContextItem,
  mailMessageSourceUrl,
  mailResourceId,
  normalizeRfc822MessageId,
  syncGoogleGmailConnection,
} from "../connectors/google-gmail.js";
import { encryptCredentials } from "../connectors/credentials.js";
import { mailScopes } from "../connectors/registry.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "explorers";
const labelId = "Label_7";
const resourceId = mailResourceId(labelId);
const credentialKey = Buffer.alloc(32, 11).toString("base64");
const now = Timestamp.fromDate(new Date("2026-08-03T10:00:00.000Z"));

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function gmailMessage(input: {
  id: string;
  subject: string;
  body: string;
  historyId: string;
  labelIds?: string[];
  messageIdHeader?: string | null;
  threadId?: string;
}) {
  const headers = [
    { name: "Subject", value: input.subject },
    { name: "From", value: `Sender One <sender@example.com>` },
    { name: "To", value: `Owner <owner@example.com>` },
    { name: "Date", value: "Mon, 3 Aug 2026 09:30:00 +0000" },
  ];
  if (input.messageIdHeader !== null) {
    headers.push({
      name: "Message-ID",
      value: input.messageIdHeader
        ?? `<quote-${input.id}@mail.example.com>`,
    });
  }
  return {
    id: input.id,
    threadId: input.threadId ?? `thread-${input.id}`,
    historyId: input.historyId,
    internalDate: String(Date.parse("2026-08-03T09:30:00.000Z")),
    labelIds: input.labelIds ?? [labelId, "INBOX"],
    snippet: input.body.slice(0, 20),
    payload: {
      mimeType: "multipart/mixed",
      headers,
      parts: [
        {
          mimeType: "text/plain",
          body: { data: base64Url(input.body) },
        },
        {
          mimeType: "application/pdf",
          filename: "quote.pdf",
          body: { attachmentId: "att-1", size: 4096 },
        },
      ],
    },
  };
}

/** Seed one Workspace connection with mail enabled and one restricted label resource. */
function seedMailConnection(memory: MemoryFirestore, input: {
  connectionId: string;
  historyId?: string | null;
}): string {
  const connectionPath = `companies/${companyId}/connections/${input.connectionId}`;
  memory.seed(connectionPath, {
    companyId,
    connectorId: "google_workspace",
    status: "active",
    credentialCiphertext: encryptCredentials({
      accessToken: "gmail-access-token",
      refreshToken: "gmail-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: mailScopes.join(" "),
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/mail`, {
    capabilityId: "context.mail.read_scoped",
    serviceId: "mail",
    status: "active",
    grantedScopes: mailScopes,
    stats: {},
  });
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    connectionId: input.connectionId,
    capabilityId: "context.mail.read_scoped",
    resourceType: "label",
    externalId: labelId,
    displayName: "Customers",
    status: "enabled",
    itemCount: 0,
    audience: { visibility: "restricted", memberIds: ["member-1"] },
    audienceRevision: 3,
    ...(input.historyId ? { historyId: input.historyId } : {}),
  });
  return connectionPath;
}

/** Route a stubbed Gmail API by path so each test only declares the pages it needs. */
function stubGmail(routes: {
  messages?: () => unknown;
  message?: (id: string) => unknown | null;
  history?: () => { status: number; body: unknown };
  profile?: () => unknown;
}): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/users/me/profile")) {
      return json(routes.profile?.() ?? { historyId: "9000" });
    }
    if (url.pathname.endsWith("/users/me/history")) {
      const result = routes.history?.() ?? { status: 200, body: {} };
      return json(result.body, result.status);
    }
    if (url.pathname.endsWith("/users/me/messages")) {
      return json(routes.messages?.() ?? {});
    }
    const messageMatch = url.pathname.match(/\/users\/me\/messages\/([^/]+)$/);
    if (messageMatch) {
      const message = routes.message?.(decodeURIComponent(messageMatch[1] ?? ""));
      return message ? json(message) : json({ error: { message: "Not Found" } }, 404);
    }
    throw new Error(`Unexpected Gmail request: ${url.pathname}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("Gmail initial import is bounded, cursored from the profile, and keeps the label audience", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionId = "google-mail-initial";
  const connectionPath = seedMailConnection(memory, { connectionId });

  let listedQuery = "";
  let listedLabel = "";
  const restore = stubGmail({
    messages: () => ({ messages: [{ id: "msg-1" }] }),
    message: (id) => (id === "msg-1"
      ? gmailMessage({
        id: "msg-1",
        subject: "Quote for renewal",
        body: "Please find the renewal quote attached.",
        historyId: "8801",
      })
      : null),
    profile: () => ({ emailAddress: "owner@example.com", historyId: "8900" }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/users/me/messages")) {
      listedQuery = url.searchParams.get("q") || "";
      listedLabel = url.searchParams.get("labelIds") || "";
    }
    return originalFetch(request as never);
  }) as typeof fetch;

  try {
    const result = await syncGoogleGmailConnection({
      companyId,
      connectionId,
      clientId: "google-client",
      clientSecret: "google-secret",
      credentialKey,
      trigger: "manual",
      requestedBy: "member-1",
      database,
      now: () => now,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.labels, 1);
    assert.equal(result.changes, 1);

    // The import is explicitly bounded rather than unbounded-and-truncated.
    assert.equal(listedQuery, "newer_than:90d");
    assert.equal(listedLabel, labelId);

    const item = memory.read(
      `companies/${companyId}/contextItems/${mailContextItemId(connectionId, "msg-1")}`,
    );
    assert.ok(item);
    assert.equal(item.kind, "mail.message");
    assert.equal(item.title, "Quote for renewal");
    assert.equal((item.source as Record<string, unknown>).resourceId, resourceId);
    assert.match(String(item.text), /Please find the renewal quote attached\./);

    // The resource audience governs the item, not a default applied at ingestion.
    assert.deepEqual(item.access, { visibility: "restricted", memberIds: ["member-1"] });
    assert.equal(item.accessRevision, 3);

    // Attachments contribute a name and reference only; nothing implies the bytes were read.
    const metadata = item.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.attachmentNames, ["quote.pdf"]);
    assert.equal(metadata.hasAttachments, true);
    assert.equal(metadata.threadId, "thread-msg-1");
    assert.equal(metadata.rfc822MessageId, "quote-msg-1@mail.example.com");
    // No reliable Gmail deep link — do not emit Open in Gmail URLs.
    assert.equal(metadata.sourceUrl, null);
    assert.deepEqual(item.participantRefs, ["sender@example.com", "owner@example.com"]);

    // The next incremental run resumes from mailbox state as of this enumeration.
    assert.equal(memory.read(`${connectionPath}/resources/${resourceId}`)?.historyId, "8900");
    const attempts = memory.list(
      `${connectionPath}/syncRuns/${result.runId}/resourceAttempts`,
    );
    assert.equal(attempts[0]?.cursorMode, "full");
    assert.equal(attempts[0]?.cursorAfter, "8900");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Gmail incremental sync removes a message that lost the selected label", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionId = "google-mail-incremental";
  const connectionPath = seedMailConnection(memory, {
    connectionId,
    historyId: "8900",
  });
  const contextPath =
    `companies/${companyId}/contextItems/${mailContextItemId(connectionId, "msg-1")}`;
  memory.seed(contextPath, {
    companyId,
    kind: "mail.message",
    source: {
      providerId: "google",
      capabilityId: "context.mail.read_scoped",
      connectionId,
      resourceId,
      externalId: "msg-1",
      version: "8801",
    },
    title: "Quote for renewal",
  });

  const restore = stubGmail({
    history: () => ({
      status: 200,
      body: {
        history: [{
          id: "9100",
          labelsRemoved: [{ message: { id: "msg-1" }, labelIds: [labelId] }],
        }],
        historyId: "9100",
      },
    }),
    // The message still exists in the mailbox; it simply no longer carries the label.
    message: (id) => (id === "msg-1"
      ? gmailMessage({
        id: "msg-1",
        subject: "Quote for renewal",
        body: "Please find the renewal quote attached.",
        historyId: "9100",
        labelIds: ["INBOX"],
      })
      : null),
  });

  try {
    const result = await syncGoogleGmailConnection({
      companyId,
      connectionId,
      clientId: "google-client",
      clientSecret: "google-secret",
      credentialKey,
      trigger: "scheduled",
      database,
      now: () => now,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(memory.read(contextPath), undefined);
    assert.equal(memory.read(`${connectionPath}/resources/${resourceId}`)?.historyId, "9100");
    const attempts = memory.list(
      `${connectionPath}/syncRuns/${result.runId}/resourceAttempts`,
    );
    assert.equal(attempts[0]?.cursorMode, "incremental");
  } finally {
    restore();
  }
});

test("Gmail expired history rebuilds completely and reconciles stale context", async () => {
  // An External app in Testing status loses its refresh token every seven days, so a
  // multi-day gap — and therefore an expired history cursor — is the common path.
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionId = "google-mail-expired";
  const connectionPath = seedMailConnection(memory, {
    connectionId,
    historyId: "1000",
  });
  const stalePath =
    `companies/${companyId}/contextItems/${mailContextItemId(connectionId, "msg-old")}`;
  memory.seed(stalePath, {
    companyId,
    kind: "mail.message",
    source: {
      providerId: "google",
      capabilityId: "context.mail.read_scoped",
      connectionId,
      resourceId,
      externalId: "msg-old",
      version: "500",
    },
    title: "Long gone",
  });

  const restore = stubGmail({
    // Gmail expires history records; the adapter must not overlay a partial delta.
    history: () => ({ status: 404, body: { error: { message: "historyId not found" } } }),
    messages: () => ({ messages: [{ id: "msg-2" }] }),
    message: (id) => (id === "msg-2"
      ? gmailMessage({
        id: "msg-2",
        subject: "Current thread",
        body: "Still in the label.",
        historyId: "9500",
      })
      : null),
    profile: () => ({ historyId: "9600" }),
  });

  try {
    const result = await syncGoogleGmailConnection({
      companyId,
      connectionId,
      clientId: "google-client",
      clientSecret: "google-secret",
      credentialKey,
      trigger: "scheduled",
      database,
      now: () => now,
    });
    assert.equal(result.status, "succeeded");

    // A complete enumeration ran, so the item absent from it is removed...
    assert.equal(memory.read(stalePath), undefined);
    // ...and the currently labelled message is stored exactly once.
    assert.ok(memory.read(
      `companies/${companyId}/contextItems/${mailContextItemId(connectionId, "msg-2")}`,
    ));
    assert.equal(
      memory.list(`companies/${companyId}/contextItems`).length,
      1,
    );

    // The obsolete cursor is replaced rather than restored.
    assert.equal(memory.read(`${connectionPath}/resources/${resourceId}`)?.historyId, "9600");
    const attempts = memory.list(
      `${connectionPath}/syncRuns/${result.runId}/resourceAttempts`,
    );
    // The attempt started incremental but reports what it actually did, matching the
    // Calendar 410 contract accepted in C5 ("completed in full cursor mode").
    assert.equal(attempts[0]?.cursorMode, "full");
    assert.equal(attempts[0]?.cursorAfter, "9600");
  } finally {
    restore();
  }
});

test("Gmail body extraction prefers text/plain and records attachments by name only", () => {
  const plain = mailMessageBody({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: base64Url("<p>HTML <b>copy</b></p>") } },
      { mimeType: "text/plain", body: { data: base64Url("Plain copy") } },
      { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "a1" } },
    ],
  });
  assert.equal(plain.text, "Plain copy");
  assert.deepEqual(plain.attachmentNames, ["logo.png"]);

  // With no text/plain part the HTML is stripped rather than indexed as markup.
  const fallback = mailMessageBody({
    mimeType: "multipart/alternative",
    parts: [{
      mimeType: "text/html",
      body: { data: base64Url("<p>Hello&nbsp;there</p><script>ignore()</script>") },
    }],
  });
  assert.equal(fallback.text, "Hello there");
  assert.deepEqual(fallback.attachmentNames, []);
});

test("Gmail stores Message-ID but does not emit a web deep link", () => {
  assert.equal(normalizeRfc822MessageId("<a.b@mail.gmail.com>"), "a.b@mail.gmail.com");
  assert.equal(normalizeRfc822MessageId("  bare@example.com  "), "bare@example.com");
  assert.equal(normalizeRfc822MessageId(""), null);

  // Hyphenated Message-IDs break rfc822msgid search; #all/ does not open either.
  assert.equal(
    mailMessageSourceUrl({
      rfc822MessageId: "9d57e3eb-af74-4ad7-91c5-a2a58151e0d2@headstart.cz",
      threadId: "19f3d5a687db2022",
      messageId: "19f3d5a687db2022",
    }),
    null,
  );
  assert.equal(mailMessageSourceUrl({ messageId: "only-msg" }), null);

  const withHeader = mailMessageContextItem({
    companyId,
    connectionId: "c1",
    resourceId,
    labelId,
    labelName: "Customers",
    message: gmailMessage({
      id: "msg-link",
      subject: "Link check",
      body: "Body",
      historyId: "1",
      messageIdHeader: "<id-1@mail.example.com>",
      threadId: "thread-link",
    }),
    audience: { visibility: "restricted", memberIds: ["member-1"] },
  });
  assert.equal((withHeader?.metadata as Record<string, unknown>).sourceUrl, null);
  assert.equal((withHeader?.metadata as Record<string, unknown>).rfc822MessageId, "id-1@mail.example.com");

  const withoutHeader = mailMessageContextItem({
    companyId,
    connectionId: "c1",
    resourceId,
    labelId,
    labelName: "Customers",
    message: gmailMessage({
      id: "msg-no-mid",
      subject: "No Message-ID",
      body: "Body",
      historyId: "1",
      messageIdHeader: null,
      threadId: "thread-no-mid",
    }),
    audience: { visibility: "restricted", memberIds: ["member-1"] },
  });
  assert.equal((withoutHeader?.metadata as Record<string, unknown>).sourceUrl, null);
  assert.equal((withoutHeader?.metadata as Record<string, unknown>).rfc822MessageId, null);
});
