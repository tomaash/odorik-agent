import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFirestore } from "./firestore-harness.js";
import { mailDraftCreateActionSchema } from "../actions/contracts.js";
import {
  buildMailDraftRfc822,
  createGmailDraftExecutor,
  encodeRfc822Base64Url,
  erikDraftRfc822MessageId,
  findDraftByRequestId,
  mailDraftDeepLink,
  MailDraftOutcomeUnknownError,
  MailDraftWriteGrantMissingError,
} from "../mail/executor.js";
import { createMailDraftCreateDescriptor } from "../mail/action.js";
import { GoogleApiError } from "../connectors/google-oauth.js";

const companyId = "company-1";
const connectionId = "google_abc";

/** Answer any Gmail call with one canned response and hand back the restore. */
function stubGmailFetch(
  respond: (url: URL) => { status: number; body: unknown },
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const { status, body } = respond(new URL(String(request)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const draftAction = mailDraftCreateActionSchema.parse({
  kind: "mail.draft.create",
  draftRequestId: "maildraft_abc123",
  connectionId,
  mailboxAddress: "ops@acme.cz",
  providerAccountId: "google-sub-1",
  to: ["buyer@acme.cz"],
  subject: "Following up",
  body: "Hello,\n\nThanks for the call.\n",
  threadId: null,
  inReplyToRfc822MessageId: null,
  evidence: [],
  contactId: "contact-1",
  callId: "call-1",
  context: { callerName: "ACME", callSummary: "Quote" },
});

const executionContext = {
  companyId,
  actorUid: "member-1",
  approvalId: "approval-1",
  approvedBy: "member-1",
  attemptId: "attempt-1",
  source: {
    kind: "workflow" as const,
    callId: "call-1",
    workflowId: "workflow-1",
    workflowVersion: 1,
    runId: "run-1",
    blockId: "block-1",
  },
};

test("RFC822 draft carries recipient, subject, Erik Message-ID, and body", () => {
  const rfc = buildMailDraftRfc822(draftAction);
  assert.match(rfc, /^To: buyer@acme\.cz/m);
  assert.match(rfc, /^Subject: Following up/m);
  assert.match(rfc, new RegExp(
    `^Message-ID: <${erikDraftRfc822MessageId(draftAction.draftRequestId)}>`,
    "m",
  ));
  assert.match(rfc, /^X-Erik-Draft-Request-Id: maildraft_abc123/m);
  assert.match(rfc, /Thanks for the call/);
  const encoded = encodeRfc822Base64Url(rfc);
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.equal(encoded.endsWith("="), false);
});

test("executor refuses when authorize reports missing grant", async () => {
  const memory = new MemoryFirestore();
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => {
        throw new MailDraftWriteGrantMissingError();
      },
    },
  );
  await assert.rejects(
    () => execute(executionContext, draftAction),
    MailDraftWriteGrantMissingError,
  );
});

test("executor creates a draft once and returns the same result on retry", async () => {
  const memory = new MemoryFirestore();
  let creates = 0;
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => null,
      createDraft: async () => {
        creates += 1;
        return {
          draftId: "draft-1",
          messageId: "msg-1",
          threadId: "thread-1",
          deepLink: "https://mail.google.com/mail/?authuser=ops%40acme.cz#drafts",
        };
      },
    },
  );

  const first = await execute(executionContext, draftAction);
  const second = await execute(executionContext, draftAction);
  assert.deepEqual(first, second);
  assert.equal(first.draftId, "draft-1");
  assert.equal(creates, 1, "second call must reuse the stored execution");
});

test("outcome_unknown is reconciled via findDraft without a second create", async () => {
  const memory = new MemoryFirestore();
  memory.seed(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
    {
      companyId,
      draftRequestId: draftAction.draftRequestId,
      connectionId,
      status: "outcome_unknown",
      error: "timeout",
    },
  );
  let creates = 0;
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => ({
        draftId: "draft-recovered",
        messageId: "msg-recovered",
        threadId: "thread-recovered",
        deepLink: "https://mail.google.com/mail/?authuser=ops%40acme.cz#drafts",
      }),
      createDraft: async () => {
        creates += 1;
        throw new Error("must not create after successful find");
      },
    },
  );

  const result = await execute(executionContext, draftAction);
  assert.equal(result.draftId, "draft-recovered");
  assert.equal(creates, 0);
  const stored = memory.read(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
  );
  assert.equal(stored?.status, "succeeded");
});

test("an unanswered lookup never becomes a second draft", async () => {
  const memory = new MemoryFirestore();
  memory.seed(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
    {
      companyId,
      draftRequestId: draftAction.draftRequestId,
      connectionId,
      status: "outcome_unknown",
      error: "timeout",
    },
  );
  let creates = 0;
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => {
        throw new GoogleApiError({ label: "Gmail draft lookup", status: 503, message: "backend error" });
      },
      createDraft: async () => {
        creates += 1;
        throw new Error("must not create while the earlier outcome is unknown");
      },
    },
  );

  await assert.rejects(
    () => execute(executionContext, draftAction),
    MailDraftOutcomeUnknownError,
  );
  assert.equal(creates, 0, "a failed lookup is not proof that no draft exists");
  const stored = memory.read(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
  );
  assert.equal(stored?.status, "outcome_unknown");
});

test("a confirmed absence after an unknown outcome does create the draft", async () => {
  const memory = new MemoryFirestore();
  memory.seed(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
    {
      companyId,
      draftRequestId: draftAction.draftRequestId,
      connectionId,
      status: "outcome_unknown",
      error: "timeout",
    },
  );
  let creates = 0;
  let lookups = 0;
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => {
        lookups += 1;
        return null;
      },
      createDraft: async () => {
        creates += 1;
        return {
          draftId: "draft-2",
          messageId: "msg-2",
          threadId: "thread-2",
          deepLink: mailDraftDeepLink({ mailboxAddress: draftAction.mailboxAddress }),
        };
      },
    },
  );

  const result = await execute(executionContext, draftAction);
  assert.equal(result.draftId, "draft-2");
  assert.equal(creates, 1);
  assert.equal(lookups, 1, "one confirmed absence is enough; do not ask twice");
});

test("a flaky lookup does not block the very first attempt", async () => {
  const memory = new MemoryFirestore();
  let creates = 0;
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => {
        throw new GoogleApiError({ label: "Gmail draft lookup", status: 503, message: "backend error" });
      },
      createDraft: async () => {
        creates += 1;
        return {
          draftId: "draft-3",
          messageId: "msg-3",
          threadId: "thread-3",
          deepLink: mailDraftDeepLink({ mailboxAddress: draftAction.mailboxAddress }),
        };
      },
    },
  );

  const result = await execute(executionContext, draftAction);
  assert.equal(result.draftId, "draft-3");
  assert.equal(creates, 1, "nothing exists yet for this request, so the check is advisory");
});

test("the draft lookup stays inside the compose grant and reads the real draft id", async () => {
  const requested: URL[] = [];
  const restore = stubGmailFetch((url) => {
    requested.push(url);
    return {
      status: 200,
      body: {
        drafts: [{ id: "r-draft-9", message: { id: "r-msg-9", threadId: "r-thread-9" } }],
      },
    };
  });
  try {
    const found = await findDraftByRequestId("token", draftAction.draftRequestId, "ops@acme.cz");
    assert.equal(requested.length, 1, "one call: message search needs a read scope we lack");
    assert.equal(requested[0]?.pathname, "/gmail/v1/users/me/drafts");
    assert.equal(
      requested[0]?.searchParams.get("q"),
      `rfc822msgid:${erikDraftRfc822MessageId(draftAction.draftRequestId)}`,
    );
    assert.equal(found?.draftId, "r-draft-9", "draft id must not be a message id in disguise");
    assert.equal(found?.messageId, "r-msg-9");
    assert.equal(found?.threadId, "r-thread-9");
  } finally {
    restore();
  }
});

test("an empty draft list is an absence and a failed list is an error", async () => {
  const empty = stubGmailFetch(() => ({ status: 200, body: {} }));
  try {
    assert.equal(await findDraftByRequestId("token", draftAction.draftRequestId), null);
  } finally {
    empty();
  }

  const broken = stubGmailFetch(() => ({ status: 503, body: { error: { message: "backend" } } }));
  try {
    await assert.rejects(
      () => findDraftByRequestId("token", draftAction.draftRequestId),
      GoogleApiError,
      "a lookup that failed must not read as an empty mailbox",
    );
  } finally {
    broken();
  }
});

test("the draft link opens the owning mailbox and claims no per-message anchor", () => {
  const link = mailDraftDeepLink({ mailboxAddress: "ops@acme.cz" });
  assert.equal(link, "https://mail.google.com/mail/?authuser=ops%40acme.cz#drafts");
  assert.equal(
    mailDraftDeepLink({ mailboxAddress: null }),
    "https://mail.google.com/mail/u/0/#drafts",
  );
  // `#drafts/{apiMessageId}` is the link shape already withdrawn for citations.
  assert.doesNotMatch(link, /#drafts\/./);
});

test("timeouts after provider contact become outcome_unknown on the descriptor", async () => {
  const memory = new MemoryFirestore();
  const execute = createGmailDraftExecutor(
    () => ({ clientId: "id", clientSecret: "secret", credentialKey: "key" }),
    {
      database: memory.asFirestore(),
      authorize: async () => ({ accessToken: "token" }),
      findDraft: async () => null,
      createDraft: async () => {
        throw new MailDraftOutcomeUnknownError("timeout after send");
      },
    },
  );
  const descriptor = createMailDraftCreateDescriptor(execute);
  await assert.rejects(
    () => execute(executionContext, draftAction),
    MailDraftOutcomeUnknownError,
  );
  assert.equal(
    descriptor.classifyFailure(new MailDraftOutcomeUnknownError("x"), "execution"),
    "outcome_unknown",
  );
  const stored = memory.read(
    `companies/${companyId}/mailDraftExecutions/${draftAction.draftRequestId}`,
  );
  assert.equal(stored?.status, "outcome_unknown");
});
