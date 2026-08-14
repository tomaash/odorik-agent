import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareConversationMailDraftProposal,
  runMailDraftProposalAgent,
} from "../agent/mail-draft-proposal.js";
import type { AgentModel, ModelTurn } from "../agent/gemini.js";
import { CitationRegistry, type AgentToolExecutor } from "../agent/tools.js";
import { MemoryFirestore } from "./firestore-harness.js";

const zeroUsage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };

class ScriptedModel implements AgentModel {
  private index = 0;
  constructor(private readonly turns: ModelTurn[]) {}
  async generate(): Promise<ModelTurn> {
    const turn = this.turns[this.index++];
    if (!turn) throw new Error("Script exhausted");
    return turn;
  }
}

class MailTools implements AgentToolExecutor {
  readonly citations = new CitationRegistry();
  async execute(): Promise<{ result: Record<string, unknown>; citationIds: string[] }> {
    const call = this.citations.add({
      kind: "call",
      recordId: "call-1",
      sourcePath: "companies/acme/calls/call-1",
      title: "Buyer call",
      excerpt: "The buyer asked for the revised offer.",
      occurredAt: null,
    });
    const contact = this.citations.add({
      kind: "contact",
      recordId: "contact-1",
      sourcePath: "companies/acme/contacts/contact-1",
      title: "Buyer",
      excerpt: "buyer@example.test",
      occurredAt: null,
    });
    return {
      result: { found: true, call: call.recordId, contact: contact.recordId },
      citationIds: [call.citationId, contact.citationId],
    };
  }
}

function proposalTurns(input: {
  to?: string;
  contactId?: string | null;
  callId?: string;
  citationIds?: string[];
} = {}): ModelTurn[] {
  return [{
    content: {
      role: "model",
      parts: [{ functionCall: {
        id: "tool-1",
        name: "get_company_record",
        args: { kind: "call", record_id: "call-1" },
      } }],
    },
    usage: zeroUsage,
  }, {
    content: {
      role: "model",
      parts: [{ text: JSON.stringify({
        to: input.to || "buyer@example.test",
        subject: "Revised offer",
        body: "Hello,\n\nHere is the revised offer we discussed.",
        callId: input.callId || "call-1",
        contactId: input.contactId === undefined ? "contact-1" : input.contactId,
        citationIds: input.citationIds || ["C1", "C2"],
        assumptions: [],
      }) }],
    },
    usage: zeroUsage,
  }];
}

function seedMailSurface(memory: MemoryFirestore) {
  memory.seed("companies/acme/connections/gmail-1", {
    connectorId: "google_workspace",
    status: "active",
    accountLabel: "tom@example.com",
    providerAccountId: "google-account-1",
  });
  memory.seed("companies/acme/connections/gmail-1/capabilities/mail_draft", {
    capabilityId: "action.mail.draft.create",
    status: "active",
  });
  memory.seed("companies/acme/calls/call-1", {
    status: "completed",
    access: { visibility: "company" },
    from: "+420777123456",
    summary: "The buyer asked for the revised offer.",
    transcript: "Please email the revised offer.",
  });
  memory.seed("companies/acme/contacts/contact-1", {
    displayName: "Buyer",
    email: "buyer@example.test",
    access: { visibility: "company" },
  });
  memory.seed("companies/acme/memberships/member-1", {
    status: "active",
    displayName: "Tom",
    email: "tom@example.com",
  });
}

const context = {
  sessionId: "session-1",
  memoryGeneration: 0,
  stateVersion: 0,
  state: {
    subject: null,
    entities: [],
    unresolvedQuestions: [],
    corrections: [],
    decisions: [],
    summary: "Nothing retained.",
  },
  priorMessages: [],
  estimatedTokens: 0,
  selectedMemoryIds: [],
};

test("mail draft generation requires fresh exact call and contact citations", async () => {
  const generated = await runMailDraftProposalAgent({
    request: "Draft the revised offer to Buyer",
    priorMessages: [],
    mailboxAddress: "tom@example.com",
    model: new ScriptedModel(proposalTurns()),
    tools: new MailTools(),
  });
  assert.equal(generated.proposal.to, "buyer@example.test");
  assert.deepEqual(generated.citations.map((citation) => citation.kind), ["call", "contact"]);

  await assert.rejects(() => runMailDraftProposalAgent({
    request: "Draft the revised offer",
    priorMessages: [],
    mailboxAddress: "tom@example.com",
    model: new ScriptedModel(proposalTurns({ callId: "other-call" })),
    tools: new MailTools(),
  }), /cite its exact source call/);
});

test("conversation mail proposals pin one mailbox, one recipient, and a draft-only policy", async () => {
  const memory = new MemoryFirestore();
  seedMailSurface(memory);
  const requested: Array<Record<string, unknown>> = [];
  const proposed = await prepareConversationMailDraftProposal({
    companyId: "acme",
    actorUid: "member-1",
    threadId: "slack-T1-U1",
    sessionId: "session-1",
    inboundMessageId: "message-1",
    request: "Draft the revised offer to Buyer",
    context,
    geminiApiKey: "unused",
    database: memory.asFirestore(),
    dependencies: {
      model: new ScriptedModel(proposalTurns()),
      tools: new MailTools(),
      requestApproval: async (input) => {
        requested.push(input as unknown as Record<string, unknown>);
        return { id: input.approvalId, effectDigest: "digest-1" } as never;
      },
    },
  });
  assert.deepEqual(proposed.action.to, ["buyer@example.test"]);
  assert.equal(proposed.action.kind, "mail.draft.create");
  assert.equal((requested[0]?.policy as { effectBoundary?: string }).effectBoundary,
    "Creates exactly one Gmail draft and never sends email.");
  assert.equal((requested[0]?.proposalLineage as { version?: number }).version, 1);
  assert.equal((requested[0]?.source as { surface?: string }).surface, "slack_dm");
});

test("conversation mail proposals reject invented or stale recipients before approval", async () => {
  const memory = new MemoryFirestore();
  seedMailSurface(memory);
  await assert.rejects(() => prepareConversationMailDraftProposal({
    companyId: "acme",
    actorUid: "member-1",
    threadId: "slack-T1-U1",
    sessionId: "session-1",
    inboundMessageId: "message-1",
    request: "Draft the revised offer to Buyer",
    context,
    geminiApiKey: "unused",
    database: memory.asFirestore(),
    dependencies: {
      model: new ScriptedModel(proposalTurns({ to: "attacker@example.test" })),
      tools: new MailTools(),
      requestApproval: async () => { throw new Error("approval must not be reached"); },
    },
  }), /recipient no longer matches the cited contact/);
});
