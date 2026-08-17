import assert from "node:assert/strict";
import test from "node:test";

import { mailDraftCreateActionSchema } from "../actions/contracts.js";
import {
  createOutlookDraftExecutor,
  createOutlookDraftViaApi,
  erikOutlookDraftPropertyId,
  OutlookDraftApiError,
} from "../mail/outlook-executor.js";
import { MailDraftOutcomeUnknownError } from "../mail/executor.js";
import { createProviderMailDraftExecutor } from "../mail/provider-executor.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "company-outlook";
const connectionId = "microsoft-1";
const action = mailDraftCreateActionSchema.parse({
  kind: "mail.draft.create",
  draftRequestId: "maildraft_outlook_1",
  connectionId,
  mailboxAddress: "tomas.holas@outlook.com",
  providerAccountId: "consumer-subject",
  to: ["recipient@example.com"],
  subject: "A safe Outlook draft",
  body: "Hello from Erik.\n",
  threadId: null,
  inReplyToRfc822MessageId: null,
  evidence: [],
  contactId: null,
  callId: "call-1",
  context: { callerName: "Test", callSummary: "Draft only" },
});
const context = {
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

test("Outlook create-message writes exactly one marked draft and never calls send", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const request = (async (value: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(value);
    calledBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "draft-1",
      conversationId: "conversation-1",
      internetMessageId: "<draft-1@outlook.com>",
      webLink: "https://outlook.live.com/mail/0/deeplink/compose/id/draft-1",
      isDraft: true,
    }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await createOutlookDraftViaApi({ accessToken: "token", action, request });
  assert.equal(new URL(calledUrl).pathname, "/v1.0/me/messages");
  assert.doesNotMatch(calledUrl, /send/i);
  assert.deepEqual(calledBody.toRecipients, [{ emailAddress: { address: "recipient@example.com" } }]);
  assert.equal((calledBody.body as Record<string, unknown>).content, "Hello from Erik.\n");
  assert.deepEqual(calledBody.singleValueExtendedProperties, [{
    id: erikOutlookDraftPropertyId,
    value: action.draftRequestId,
  }]);
  assert.equal(result.draftId, "draft-1");
});

test("Outlook executor stores success once and reuses it on retry", async () => {
  const memory = new MemoryFirestore();
  let creates = 0;
  const execute = createOutlookDraftExecutor(undefined, {
    database: memory.asFirestore(),
    authorize: async () => ({ accessToken: "token" }),
    findDraft: async () => null,
    createDraft: async () => {
      creates += 1;
      return { draftId: "draft-1", messageId: "message-1", threadId: "thread-1", deepLink: "https://outlook/draft-1" };
    },
  });
  assert.equal((await execute(context, action)).draftId, "draft-1");
  assert.equal((await execute(context, action)).draftId, "draft-1");
  assert.equal(creates, 1);
});

test("an ambiguous Outlook retry must reconcile before it can create again", async () => {
  const memory = new MemoryFirestore();
  memory.seed(`companies/${companyId}/mailDraftExecutions/${action.draftRequestId}`, {
    companyId, connectionId, draftRequestId: action.draftRequestId,
    status: "outcome_unknown", error: "timeout",
  });
  let creates = 0;
  const execute = createOutlookDraftExecutor(undefined, {
    database: memory.asFirestore(),
    authorize: async () => ({ accessToken: "token" }),
    findDraft: async () => {
      throw new OutlookDraftApiError(503, "ServiceUnavailable", "lookup failed");
    },
    createDraft: async () => {
      creates += 1;
      throw new Error("must not create");
    },
  });
  await assert.rejects(() => execute(context, action), MailDraftOutcomeUnknownError);
  assert.equal(creates, 0);
  assert.equal(memory.read(`companies/${companyId}/mailDraftExecutions/${action.draftRequestId}`)?.status, "outcome_unknown");
});

test("the provider adapter routes the same action envelope by connection", async () => {
  const memory = new MemoryFirestore();
  memory.seed(`companies/${companyId}/connections/${connectionId}`, { connectorId: "microsoft_365" });
  let outlookCalls = 0;
  const execute = createProviderMailDraftExecutor({
    database: memory.asFirestore(),
    gmail: async () => { throw new Error("wrong provider"); },
    outlook: async () => {
      outlookCalls += 1;
      return { draftId: "outlook", messageId: "message", threadId: "thread", deepLink: "https://outlook" };
    },
  });
  assert.equal((await execute(context, action)).draftId, "outlook");
  assert.equal(outlookCalls, 1);
});
