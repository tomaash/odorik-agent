import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFirestore } from "./firestore-harness.js";
import { actionEffectDigest, mailDraftCreateActionSchema } from "../actions/contracts.js";
import {
  createMailDraftCreateDescriptor,
  mailDraftCreateDescriptor,
  MailDraftExecutionUnavailableError,
} from "../mail/action.js";
import { proposedPayloads } from "../workflow/runtime.js";
import {
  createCallTaskWorkflow,
  createMailDraftBlock,
  previewWorkflow,
} from "@agent-erik/workflow";

const companyId = "company-1";
const connectionId = "google_abc";

const draftAction = mailDraftCreateActionSchema.parse({
  kind: "mail.draft.create",
  draftRequestId: "maildraft_1",
  connectionId,
  mailboxAddress: "ops@acme.cz",
  providerAccountId: "google-sub-1",
  to: ["buyer@acme.cz"],
  subject: "Following up on your call",
  body: "Hello ACME,\n\nAsked for a quote.\n",
  threadId: null,
  inReplyToRfc822MessageId: null,
  evidence: [],
  contactId: "contact-1",
  callId: "call-1",
  context: { callerName: "ACME", callSummary: "Asked for a quote." },
});

function seedMailbox(memory: MemoryFirestore, overrides: {
  connectionStatus?: string;
  capabilityStatus?: string;
  accountLabel?: string;
} = {}) {
  const path = `companies/${companyId}/connections/${connectionId}`;
  memory.seed(path, {
    connectorId: "google_workspace",
    status: overrides.connectionStatus || "active",
    accountLabel: overrides.accountLabel || "ops@acme.cz",
    providerAccountId: "google-sub-1",
  });
  memory.seed(`${path}/capabilities/mail`, {
    capabilityId: "context.mail.read_scoped",
    serviceId: "mail",
    status: overrides.capabilityStatus || "active",
  });
  return path;
}

async function assertPreconditions(memory: MemoryFirestore, action = draftAction) {
  const database = memory.asFirestore();
  await database.runTransaction(async (transaction) => {
    await mailDraftCreateDescriptor.assertRequestPreconditions(
      { companyId, database, transaction },
      action,
    );
  });
}

test("the mail draft descriptor declares an external effect it cannot yet perform", () => {
  assert.equal(mailDraftCreateDescriptor.category, "external.write");
  assert.equal(mailDraftCreateDescriptor.capabilityId, "action.mail.draft.create");
  assert.equal(mailDraftCreateDescriptor.authorization.requiresApproval, true);
  assert.equal(
    mailDraftCreateDescriptor.authorization.providerCapabilityId,
    "google.gmail.drafts.write",
  );
  // The registry only admits external actions that can be reconciled, and a
  // draft is deletable, so the effect is compensatable rather than final.
  assert.equal(mailDraftCreateDescriptor.idempotency, "provider_aware");
  assert.equal(mailDraftCreateDescriptor.reconciliation, "required_before_retry");
  assert.equal(mailDraftCreateDescriptor.reversibility, "compensatable");
});

test("approving a draft fails closed instead of reaching Google", async () => {
  await assert.rejects(
    () => mailDraftCreateDescriptor.execute({
      companyId,
      actorUid: "member-1",
      approvalId: "approval-1",
      approvedBy: "member-1",
      attemptId: "attempt-1",
      source: {
        kind: "workflow",
        callId: "call-1",
        workflowId: "workflow-1",
        workflowVersion: 1,
        runId: "run-1",
        blockId: "block-1",
      },
    }, draftAction),
    MailDraftExecutionUnavailableError,
  );

  // G3 swaps the executor in without changing anything else about the record.
  const wired = createMailDraftCreateDescriptor(async () => ({
    draftId: "draft-1",
    messageId: "message-1",
    threadId: "thread-1",
    deepLink: "https://mail.google.com/mail/u/0/#drafts",
  }));
  const result = await wired.execute({
    companyId,
    actorUid: "member-1",
    approvalId: "approval-1",
    approvedBy: "member-1",
    attemptId: "attempt-1",
    source: {
      kind: "workflow",
      callId: "call-1",
      workflowId: "workflow-1",
      workflowVersion: 1,
      runId: "run-1",
      blockId: "block-1",
    },
  }, draftAction);
  assert.equal(wired.resultId(draftAction, result), "draft-1");
  assert.deepEqual(wired.resultReference(draftAction, result), {
    kind: "mail_draft",
    id: "draft-1",
  });
});

test("preparation binds the mailbox the provider would actually send from", async () => {
  const memory = new MemoryFirestore();
  seedMailbox(memory, { accountLabel: "real-ops@acme.cz" });

  const prepared = await mailDraftCreateDescriptor.prepareForApproval(
    {
      companyId,
      actorUid: "member-1",
      database: memory.asFirestore(),
      resolveActiveMember: async (_companyId, uid) => ({
        uid,
        displayName: "Member",
        email: `${uid}@example.com`,
      }),
    },
    { ...draftAction, mailboxAddress: "stale@acme.cz" },
  );

  assert.equal(prepared.mailboxAddress, "real-ops@acme.cz");
  // The rewrite happens before the digest is taken, so the approval binds the
  // authoritative address rather than whatever the workflow carried.
  assert.notEqual(
    actionEffectDigest(prepared),
    actionEffectDigest({ ...draftAction, mailboxAddress: "stale@acme.cz" }),
  );
});

test("the draft is refused when the mailbox is no longer usable", async () => {
  const active = new MemoryFirestore();
  seedMailbox(active);
  await assertPreconditions(active);

  const disconnected = new MemoryFirestore();
  seedMailbox(disconnected, { connectionStatus: "disconnected" });
  await assert.rejects(() => assertPreconditions(disconnected), /connection for this mailbox/);

  const mailOff = new MemoryFirestore();
  seedMailbox(mailOff, { capabilityStatus: "disabled" });
  await assert.rejects(() => assertPreconditions(mailOff), /Mail is not enabled/);

  const renamed = new MemoryFirestore();
  seedMailbox(renamed, { accountLabel: "someone-else@acme.cz" });
  await assert.rejects(() => assertPreconditions(renamed), /connection for this mailbox/);

  const missing = new MemoryFirestore();
  await assert.rejects(() => assertPreconditions(missing), /connection for this mailbox/);
});

test("cited evidence must still read exactly as it did when the draft was composed", async () => {
  const memory = new MemoryFirestore();
  seedMailbox(memory);
  memory.seed(`companies/${companyId}/contextItems/mail_1`, {
    kind: "mail.message",
    source: { version: "history-1" },
    provenance: { checksum: "checksum-1" },
  });

  const cited = mailDraftCreateActionSchema.parse({
    ...draftAction,
    evidence: [{ contextItemId: "mail_1", version: "history-1", checksum: "checksum-1" }],
  });
  await assertPreconditions(memory, cited);

  memory.patch(`companies/${companyId}/contextItems/mail_1`, {
    provenance: { checksum: "checksum-2" },
  });
  await assert.rejects(() => assertPreconditions(memory, cited), /Evidence for this draft changed/);
});

test("every field that could reach Gmail moves the effect digest", () => {
  const baseline = actionEffectDigest(draftAction);

  const mutations: Array<[string, Record<string, unknown>]> = [
    ["recipient", { to: ["someone-else@acme.cz"] }],
    ["subject", { subject: "Something else entirely" }],
    ["body", { body: "A different message." }],
    ["mailbox", { mailboxAddress: "other@acme.cz" }],
    ["provider account", { providerAccountId: "google-sub-2" }],
    ["thread", { threadId: "thread-9" }],
    ["reply header", { inReplyToRfc822MessageId: "<abc@mail>" }],
    ["idempotency key", { draftRequestId: "maildraft_2" }],
    ["connection", { connectionId: "google_other" }],
  ];

  for (const [label, patch] of mutations) {
    const mutated = mailDraftCreateActionSchema.parse({ ...draftAction, ...patch });
    assert.notEqual(actionEffectDigest(mutated), baseline, `${label} must change the digest`);
  }

  // Key order is not part of the effect; the canonical digest sorts recursively.
  assert.equal(
    actionEffectDigest({ ...draftAction }),
    actionEffectDigest(Object.fromEntries(
      Object.entries(draftAction).reverse(),
    )),
  );
});

test("the payload admits exactly one recipient and no undisclosed fields", () => {
  assert.throws(() => mailDraftCreateActionSchema.parse({
    ...draftAction,
    to: ["one@acme.cz", "two@acme.cz"],
  }));
  assert.throws(() => mailDraftCreateActionSchema.parse({ ...draftAction, to: [] }));
  // An undisclosed field would reach the provider without appearing on the card.
  assert.throws(() => mailDraftCreateActionSchema.parse({ ...draftAction, bcc: ["x@acme.cz"] }));
});

test("a history preview and a real run propose the identical payload", () => {
  const spec = createCallTaskWorkflow({ assigneeUid: "user-1", assigneeName: "Tomáš" });
  spec.blocks = [createMailDraftBlock({
    approverUid: "user-1",
    approverName: "Tomáš",
    connectionId,
    recipient: { kind: "literal", email: "buyer@acme.cz" },
  })];

  const context = {
    callerHasContact: true,
    callerName: "ACME",
    callSummary: "Asked for a quote.",
    mailConnections: [{
      connectionId,
      address: "ops@acme.cz",
      providerAccountId: "google-sub-1",
      active: true,
    }],
  };

  const build = () => proposedPayloads({
    companyId,
    workflow: { id: "workflow-1", version: 3 },
    callId: "call-1",
    contactId: "contact-1",
    actions: previewWorkflow(spec, context).actions,
  });

  // The dry run and the run call this with the same arguments, so the property
  // the epic asks for reduces to: the builder is deterministic, and it produces
  // a payload the action schema accepts.
  const [dryRun] = build();
  const [realRun] = build();
  assert.ok(dryRun && realRun);
  assert.deepEqual(dryRun.action, realRun.action);
  assert.equal(dryRun.effectDigest, realRun.effectDigest);
  assert.equal(dryRun.approvalId, realRun.approvalId);

  const parsed = mailDraftCreateActionSchema.parse(dryRun.action);
  assert.equal(parsed.mailboxAddress, "ops@acme.cz");
  assert.equal(parsed.providerAccountId, "google-sub-1");
  assert.deepEqual(parsed.to, ["buyer@acme.cz"]);
  assert.equal(parsed.draftRequestId, dryRun.objectId);
  assert.equal(actionEffectDigest(parsed), dryRun.effectDigest);

  // A different workflow version is a different proposal, which is why a dry
  // run over an unsaved draft cannot claim to match a saved run byte for byte.
  const [otherVersion] = proposedPayloads({
    companyId,
    workflow: { id: "workflow-1", version: 4 },
    callId: "call-1",
    contactId: "contact-1",
    actions: previewWorkflow(spec, context).actions,
  });
  assert.notEqual(otherVersion?.effectDigest, dryRun.effectDigest);
});
