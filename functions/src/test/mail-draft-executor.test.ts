import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFirestore } from "./firestore-harness.js";
import { mailDraftCreateActionSchema } from "../actions/contracts.js";
import {
  buildMailDraftRfc822,
  createGmailDraftExecutor,
  encodeRfc822Base64Url,
  erikDraftRfc822MessageId,
  MailDraftOutcomeUnknownError,
  MailDraftWriteGrantMissingError,
} from "../mail/executor.js";
import { createMailDraftCreateDescriptor } from "../mail/action.js";

const companyId = "company-1";
const connectionId = "google_abc";

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
          deepLink: "https://mail.google.com/mail/u/0/#drafts/msg-1",
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
        deepLink: "https://mail.google.com/mail/u/0/#drafts/msg-recovered",
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
