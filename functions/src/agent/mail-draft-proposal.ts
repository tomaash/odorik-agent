import { createHash } from "node:crypto";
import { z } from "zod";

import { canMemberAccess, normalizeResourceAudience, type ResourceAudience } from "../access.js";
import { conversationApprovalPolicy } from "../actions/conversation-policy.js";
import type { ConversationSurface } from "../actions/conversation-policy.js";
import { requestWorkflowActionApproval } from "../approvals/repository.js";
import { companyDocumentPath } from "../tenancy.js";
import type { ConversationContextSnapshot } from "./conversation-memory.js";
import { GeminiRestAgentModel, type AgentModel, type GeminiContent, type ModelUsage } from "./gemini.js";
import { FirestoreCompanyData } from "./knowledge.js";
import { qdrantFromEnvironment } from "./search.js";
import { CompanyFactTools, factToolDeclarations, type AgentToolExecutor } from "./tools.js";
import type { ToolCitation } from "./types.js";

const proposalSchema = z.object({
  to: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(50_000),
  callId: z.string().trim().min(1).max(500),
  contactId: z.string().trim().min(1).max(500).nullable(),
  citationIds: z.array(z.string()).min(1).max(20),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict();

const responseSchema = {
  type: "OBJECT",
  properties: {
    to: { type: "STRING" },
    subject: { type: "STRING" },
    body: { type: "STRING" },
    callId: { type: "STRING" },
    contactId: { type: "STRING", nullable: true },
    citationIds: { type: "ARRAY", items: { type: "STRING" } },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["to", "subject", "body", "callId", "contactId", "citationIds", "assumptions"],
};

const instruction = `You prepare one exact email draft proposal from a private company conversation.

Rules:
- Use company-data tools before proposing. Resolve every referenced person, call, customer, and prior discussion against current authorized records.
- Select one accessible completed call as the evidence anchor and return its exact record ID in callId.
- This action creates a draft only. It never sends mail, adds recipients, attaches files, or changes company records.
- There must be exactly one recipient. Use a literal address stated by the user or an exact current email on one cited contact. Never infer an address.
- Preserve the user's intent and current evidence in a concise subject and complete body. Do not promise facts the evidence does not support.
- Include every citation ID supporting the recipient and draft. Put unresolved details in assumptions.
- If the recipient, source call, or requested content is materially ambiguous, do not guess: return values that validation will refuse.
- You only prepare a proposal. A separately authenticated named approval is required before the selected mail provider is contacted.

Return only the required JSON object.`;

export type PreparedMailDraftProposal = {
  approvalId: string;
  approval: Record<string, unknown>;
  action: {
    kind: "mail.draft.create";
    draftRequestId: string;
    connectionId: string;
    mailboxAddress: string;
    providerAccountId: string;
    to: [string];
    subject: string;
    body: string;
    threadId: null;
    inReplyToRfc822MessageId: null;
    evidence: [];
    contactId: string | null;
    callId: string;
    context: {
      callerName: string | null;
      callerPhone: string | null;
      callSummary: string | null;
      transcriptExcerpt: string | null;
    };
    citationIds: string[];
    assumptions: string[];
  };
  citations: ToolCitation[];
  assumptions: string[];
  run: { usage: ModelUsage; toolTrace: Array<Record<string, unknown>> };
};

export type MailDraftProposalDependencies = {
  model?: AgentModel;
  tools?: AgentToolExecutor;
  requestApproval?: typeof requestWorkflowActionApproval;
};

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 28)}`;
}

function addUsage(total: ModelUsage, value: ModelUsage): void {
  total.promptTokens += value.promptTokens;
  total.outputTokens += value.outputTokens;
  total.thinkingTokens += value.thinkingTokens;
  total.totalTokens += value.totalTokens;
}

function textFromTurn(content: GeminiContent): string {
  return content.parts.map((part) => part.text || "").join("").trim();
}

function intersectAudience(leftValue: unknown, rightValue: unknown): ResourceAudience {
  const left = normalizeResourceAudience(leftValue);
  const right = normalizeResourceAudience(rightValue);
  if (left.visibility === "company") return right;
  if (right.visibility === "company") return left;
  const rightIds = new Set(right.memberIds);
  return { visibility: "restricted", memberIds: left.memberIds.filter((id) => rightIds.has(id)) };
}

function nullableString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function literalEmails(request: string): Set<string> {
  return new Set((request.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) || [])
    .map((value) => value.toLocaleLowerCase("en")));
}

export async function runMailDraftProposalAgent(input: {
  request: string;
  priorMessages: ConversationContextSnapshot["priorMessages"];
  conversationStateInstruction?: string;
  mailboxAddress: string;
  model: AgentModel;
  tools: AgentToolExecutor;
  maxTurns?: number;
}) {
  const contents: GeminiContent[] = input.priorMessages.map((message) => ({
    role: message.role,
    parts: [{ text: message.text.slice(0, 6_000) }],
  }));
  contents.push({ role: "user", parts: [{ text: input.request.trim() }] });
  const usage: ModelUsage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; citationIds: string[] }> = [];
  const maxTurns = Math.min(8, Math.max(2, input.maxTurns || 6));
  let finalText = "";
  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    const forceFinal = turnIndex === maxTurns - 1;
    const turn = await input.model.generate({
      systemInstruction: [
        instruction,
        `The selected sending mailbox is ${input.mailboxAddress}.`,
        input.conversationStateInstruction || "",
      ].filter(Boolean).join("\n\n"),
      contents,
      tools: forceFinal ? [] : [...factToolDeclarations],
      toolMode: forceFinal ? "NONE" : (toolTrace.length === 0 ? "ANY" : "AUTO"),
      responseSchema: forceFinal || toolTrace.length > 0 ? responseSchema : undefined,
    });
    addUsage(usage, turn.usage);
    contents.push(turn.content);
    const calls = turn.content.parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
    if (!calls.length) {
      finalText = textFromTurn(turn.content);
      break;
    }
    const responses = await Promise.all(calls.map(async (call) => {
      const name = String(call.name || "");
      const args = call.args || {};
      try {
        const execution = await input.tools.execute(name, args);
        toolTrace.push({ name, args, citationIds: execution.citationIds });
        return { functionResponse: { name, id: call.id, response: { result: execution.result } } };
      } catch (error) {
        toolTrace.push({ name, args, citationIds: [] });
        return { functionResponse: { name, id: call.id, response: {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        } } };
      }
    }));
    contents.push({ role: "user", parts: responses });
  }
  const proposal = proposalSchema.parse(JSON.parse(finalText));
  const citations = input.tools.citations.resolve(proposal.citationIds);
  if (citations.length !== new Set(proposal.citationIds).size) {
    throw new Error("The draft proposal contains unknown evidence citations.");
  }
  if (!toolTrace.length) throw new Error("A draft proposal requires fresh company evidence.");
  if (!citations.some((citation) => citation.kind === "call" && citation.recordId === proposal.callId)) {
    throw new Error("The draft proposal must cite its exact source call.");
  }
  if (proposal.contactId && !citations.some((citation) => (
    citation.kind === "contact" && citation.recordId === proposal.contactId
  ))) throw new Error("The draft proposal must cite its exact recipient contact.");
  return { proposal, citations, toolTrace, usage };
}

async function selectedMailbox(input: {
  companyId: string;
  request: string;
  database: FirebaseFirestore.Firestore;
}) {
  const connections = await input.database.collection(`companies/${input.companyId}/connections`).get();
  const candidates = (await Promise.all(connections.docs.flatMap((document) => {
    const data = document.data() || {};
    if (!["google_workspace", "microsoft_365"].includes(String(data.connectorId))
      || !["active", "attention"].includes(String(data.status))) {
      return [];
    }
    return [(async () => {
      const capability = await document.ref.collection("capabilities").doc("mail_draft").get();
      const capabilityData = capability.data() || {};
      if (!capability.exists
        || capabilityData.capabilityId !== "action.mail.draft.create"
        || !["permission_granted", "active", "attention"].includes(String(capabilityData.status))) return null;
      const mailboxAddress = String(data.accountLabel || "").trim();
      const providerAccountId = String(data.providerAccountId || "").trim();
      return mailboxAddress && providerAccountId
        ? { connectionId: document.id, mailboxAddress, providerAccountId }
        : null;
    })()];
  }))).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const mentioned = candidates.filter((candidate) => input.request
    .toLocaleLowerCase("en").includes(candidate.mailboxAddress.toLocaleLowerCase("en")));
  const selected = mentioned.length === 1 ? mentioned[0] : candidates.length === 1 ? candidates[0] : null;
  if (!selected) {
    throw new Error(candidates.length
      ? "Choose exactly one connected mailbox for this draft."
      : "Enable draft creation on a connected mail account first.");
  }
  return selected;
}

export async function prepareConversationMailDraftProposal(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  sessionId: string;
  inboundMessageId: string;
  request: string;
  context: ConversationContextSnapshot;
  geminiApiKey: string;
  database: FirebaseFirestore.Firestore;
  surface?: ConversationSurface;
  lineage?: {
    rootApprovalId: string;
    version: number;
    supersedesApprovalId: string;
    revisionNote: string;
  };
  dependencies?: MailDraftProposalDependencies;
}): Promise<PreparedMailDraftProposal> {
  const mailbox = await selectedMailbox(input);
  const repository = new FirestoreCompanyData(input.database, input.companyId, input.actorUid);
  const tools = input.dependencies?.tools || new CompanyFactTools(repository, qdrantFromEnvironment({
    geminiApiKey: input.geminiApiKey,
    companyId: input.companyId,
    memberId: input.actorUid,
  }).search);
  const generated = await runMailDraftProposalAgent({
    request: input.request,
    priorMessages: input.context.priorMessages,
    conversationStateInstruction: input.context.stateVersion > 0
      ? `Conversation state for reference resolution only:\n${input.context.state.summary}\nRe-check every fact with tools.`
      : "",
    mailboxAddress: mailbox.mailboxAddress,
    model: input.dependencies?.model || new GeminiRestAgentModel(input.geminiApiKey),
    tools,
  });
  const callRef = input.database.doc(companyDocumentPath(input.companyId, "calls", generated.proposal.callId));
  const call = await callRef.get();
  if (!call.exists || call.data()?.status !== "completed" || call.data()?.indexingEnabled === false
    || !canMemberAccess(call.data()?.access, input.actorUid)) {
    throw new Error("The draft proposal's source call is unavailable.");
  }
  let contactData: FirebaseFirestore.DocumentData | null = null;
  if (generated.proposal.contactId) {
    const contact = await input.database.doc(companyDocumentPath(
      input.companyId, "contacts", generated.proposal.contactId,
    )).get();
    if (!contact.exists || !canMemberAccess(contact.data()?.access, input.actorUid)) {
      throw new Error("The draft proposal's recipient contact is unavailable.");
    }
    contactData = contact.data() || {};
    if (String(contactData.email || "").trim().toLocaleLowerCase("en")
      !== generated.proposal.to.toLocaleLowerCase("en")) {
      throw new Error("The draft recipient no longer matches the cited contact.");
    }
  } else if (!literalEmails(input.request).has(generated.proposal.to.toLocaleLowerCase("en"))) {
    throw new Error("State the literal recipient email or identify one exact contact.");
  }
  const member = await input.database.doc(`companies/${input.companyId}/memberships/${input.actorUid}`).get();
  if (!member.exists || member.data()?.status !== "active") {
    throw new Error("The named approver is no longer active.");
  }
  const stableKey = `${input.companyId}:${input.threadId}:${input.sessionId}:${input.inboundMessageId}`;
  const approvalId = input.lineage
    ? deterministicId("approval", `${input.lineage.rootApprovalId}:v${input.lineage.version}`)
    : deterministicId("approval", stableKey);
  const rootApprovalId = input.lineage?.rootApprovalId || approvalId;
  const proposalVersion = input.lineage?.version || 1;
  const callData = call.data() || {};
  const action = {
    kind: "mail.draft.create" as const,
    draftRequestId: deterministicId("maildraft", approvalId),
    connectionId: mailbox.connectionId,
    mailboxAddress: mailbox.mailboxAddress,
    providerAccountId: mailbox.providerAccountId,
    to: [generated.proposal.to] as [string],
    subject: generated.proposal.subject,
    body: generated.proposal.body,
    threadId: null,
    inReplyToRfc822MessageId: null,
    evidence: [] as [],
    contactId: generated.proposal.contactId,
    callId: generated.proposal.callId,
    context: {
      callerName: nullableString(contactData?.displayName, 300),
      callerPhone: nullableString(callData.from, 100),
      callSummary: nullableString(callData.summary, 2_000),
      transcriptExcerpt: nullableString(callData.transcript, 500),
    },
  };
  const access = contactData
    ? intersectAudience(callData.access, contactData.access)
    : normalizeResourceAudience(callData.access);
  if (!canMemberAccess(access, input.actorUid)) throw new Error("The proposal has no valid recipient audience.");
  const requestApproval = input.dependencies?.requestApproval || requestWorkflowActionApproval;
  const approval = await requestApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    approvalId,
    approverUid: input.actorUid,
    approverName: String(member.data()?.displayName || member.data()?.email || "Team member"),
    action,
    source: {
      kind: "conversation",
      surface: input.surface || "slack_dm",
      threadId: input.threadId,
      sessionId: input.sessionId,
      messageId: input.inboundMessageId,
      callId: generated.proposal.callId,
      proposalRootId: rootApprovalId,
      proposalVersion,
      ...(input.lineage ? { supersedesApprovalId: input.lineage.supersedesApprovalId } : {}),
    },
    policy: conversationApprovalPolicy("mail.draft.create", input.surface),
    proposalLineage: {
      rootApprovalId,
      version: proposalVersion,
      supersedesApprovalId: input.lineage?.supersedesApprovalId || null,
      revisionNote: input.lineage?.revisionNote || null,
    },
    access,
  }, {
    database: input.database,
    resolveActiveMember: async () => ({
      uid: input.actorUid,
      displayName: String(member.data()?.displayName || member.data()?.email || "Team member"),
      email: String(member.data()?.email || ""),
    }),
  });
  return {
    approvalId,
    approval: approval as Record<string, unknown>,
    action: { ...action, citationIds: generated.proposal.citationIds, assumptions: generated.proposal.assumptions },
    citations: generated.citations,
    assumptions: generated.proposal.assumptions,
    run: { usage: generated.usage, toolTrace: generated.toolTrace },
  };
}
