import { createHash } from "node:crypto";
import { z } from "zod";

import { requestWorkflowActionApproval } from "../approvals/repository.js";
import { canMemberAccess, normalizeResourceAudience } from "../access.js";
import { companyDocumentPath } from "../tenancy.js";
import type { ConversationContextSnapshot } from "./conversation-memory.js";
import type { AgentModel, GeminiContent, ModelUsage } from "./gemini.js";
import type { ToolCitation } from "./types.js";
import {
  CompanyFactTools,
  factToolDeclarations,
  type AgentToolExecutor,
} from "./tools.js";
import { FirestoreCompanyData } from "./knowledge.js";
import { qdrantFromEnvironment } from "./search.js";
import { GeminiRestAgentModel } from "./gemini.js";
import { conversationApprovalPolicy } from "../actions/conversation-policy.js";

const proposalSchema = z.object({
  title: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(5_000).nullable(),
  callId: z.string().trim().min(1).max(500),
  dueAt: z.string().datetime().nullable(),
  citationIds: z.array(z.string()).min(1).max(20),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict();

export type PreparedTaskProposal = {
  approvalId: string;
  approval: Record<string, unknown>;
  action: {
    kind: "task.create";
    taskId: string;
    title: string;
    instructions: string | null;
    assigneeUid: string;
    assigneeName: string;
    dueAt: string | null;
    contactId: string | null;
    caseId: null;
    caseTitle: null;
    callId: string;
    subject: { kind: "internal" };
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

export type TaskProposalDependencies = {
  model?: AgentModel;
  tools?: AgentToolExecutor;
  requestApproval?: typeof requestWorkflowActionApproval;
};

const finalProposalSchema = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    instructions: { type: "STRING", nullable: true },
    callId: { type: "STRING" },
    dueAt: { type: "STRING", nullable: true },
    citationIds: { type: "ARRAY", items: { type: "STRING" } },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["title", "instructions", "callId", "dueAt", "citationIds", "assumptions"],
};

const taskProposalInstruction = `You prepare one exact internal task proposal from a private company conversation.

Rules:
- Use company-data tools before proposing. Resolve every referenced person, call, customer, and prior discussion against current authorized records.
- This slice may create only one internal task assigned to the requesting member. It cannot send messages, edit records, create cases, or approve anything.
- Select one accessible completed call as the evidence anchor. Return its exact record ID in callId.
- Preserve relative due-date language in instructions unless the user stated an unambiguous calendar date. Set dueAt only when an exact ISO timestamp is supported by the request.
- Keep the title concise and action-oriented. Put necessary execution detail in instructions.
- Include every citation ID supporting the task. Do not invent IDs or facts.
- Put unresolved details in assumptions. If the request is materially ambiguous or no accessible call supports it, do not guess: omit a valid call/citation and validation will refuse the proposal.
- You only prepare a proposal. A separately authenticated named approval is required before execution.

Return only the required JSON object.`;

function addUsage(total: ModelUsage, value: ModelUsage): void {
  total.promptTokens += value.promptTokens;
  total.outputTokens += value.outputTokens;
  total.thinkingTokens += value.thinkingTokens;
  total.totalTokens += value.totalTokens;
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 28)}`;
}

function textFromTurn(content: GeminiContent): string {
  return content.parts.map((part) => part.text || "").join("").trim();
}

export async function runTaskProposalAgent(input: {
  request: string;
  priorMessages: ConversationContextSnapshot["priorMessages"];
  conversationStateInstruction?: string;
  model: AgentModel;
  tools: AgentToolExecutor;
  maxTurns?: number;
}): Promise<{
  proposal: z.infer<typeof proposalSchema>;
  citations: ToolCitation[];
  toolTrace: Array<{ name: string; args: Record<string, unknown>; citationIds: string[] }>;
  usage: ModelUsage;
}> {
  const contents: GeminiContent[] = input.priorMessages.map((message) => ({
    role: message.role,
    parts: [{ text: message.text.slice(0, 6_000) }],
  }));
  contents.push({ role: "user", parts: [{ text: input.request.trim() }] });
  const usage: ModelUsage = {
    promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0,
  };
  const toolTrace: Array<{ name: string; args: Record<string, unknown>; citationIds: string[] }> = [];
  const maxTurns = Math.min(8, Math.max(2, input.maxTurns || 6));
  let finalText = "";

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    const forceFinal = turnIndex === maxTurns - 1;
    const turn = await input.model.generate({
      systemInstruction: [taskProposalInstruction, input.conversationStateInstruction || ""]
        .filter(Boolean).join("\n\n"),
      contents,
      tools: forceFinal ? [] : [...factToolDeclarations],
      toolMode: forceFinal ? "NONE" : (toolTrace.length === 0 ? "ANY" : "AUTO"),
      responseSchema: forceFinal || toolTrace.length > 0 ? finalProposalSchema : undefined,
    });
    addUsage(usage, turn.usage);
    contents.push(turn.content);
    const calls = turn.content.parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
    if (calls.length === 0) {
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
        return {
          functionResponse: {
            name,
            id: call.id,
            response: { error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) },
          },
        };
      }
    }));
    contents.push({ role: "user", parts: responses });
  }

  const proposal = proposalSchema.parse(JSON.parse(finalText));
  const citations = input.tools.citations.resolve(proposal.citationIds);
  if (citations.length !== new Set(proposal.citationIds).size) {
    throw new Error("The task proposal contains unknown evidence citations.");
  }
  if (!toolTrace.length) throw new Error("A task proposal requires fresh company evidence.");
  const anchoredCall = citations.find((citation) => (
    citation.kind === "call" && citation.recordId === proposal.callId
  ));
  if (!anchoredCall) {
    throw new Error("The task proposal must cite its exact source call.");
  }
  return { proposal, citations, toolTrace, usage };
}

function nullableString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

export async function prepareConversationTaskProposal(input: {
  companyId: string;
  actorUid: string;
  threadId: string;
  sessionId: string;
  inboundMessageId: string;
  request: string;
  context: ConversationContextSnapshot;
  geminiApiKey: string;
  database: FirebaseFirestore.Firestore;
  lineage?: {
    rootApprovalId: string;
    version: number;
    supersedesApprovalId: string;
    revisionNote: string;
  };
  dependencies?: TaskProposalDependencies;
}): Promise<PreparedTaskProposal> {
  const repository = new FirestoreCompanyData(input.database, input.companyId, input.actorUid);
  const tools = input.dependencies?.tools || new CompanyFactTools(
    repository,
    qdrantFromEnvironment({
      geminiApiKey: input.geminiApiKey,
      companyId: input.companyId,
      memberId: input.actorUid,
    }).search,
  );
  const generated = await runTaskProposalAgent({
    request: input.request,
    priorMessages: input.context.priorMessages,
    conversationStateInstruction: input.context.stateVersion > 0
      ? `Conversation state for reference resolution only:\n${input.context.state.summary}\nRe-check every fact with tools.`
      : "",
    model: input.dependencies?.model || new GeminiRestAgentModel(input.geminiApiKey),
    tools,
  });
  // Evidence returned by a model/tool loop is still a pointer, not authority.
  // Load the exact record and re-check it on the transactional source of truth.
  const call = await input.database.doc(companyDocumentPath(
    input.companyId,
    "calls",
    generated.proposal.callId,
  )).get();
  if (!call.exists || call.data()?.status !== "completed" || call.data()?.indexingEnabled === false) {
    throw new Error("The task proposal's source call is unavailable.");
  }
  if (!canMemberAccess(call.data()?.access, input.actorUid)) {
    throw new Error("The task proposal's source call is not accessible.");
  }
  const member = await input.database.doc(
    `companies/${input.companyId}/memberships/${input.actorUid}`,
  ).get();
  if (!member.exists || member.data()?.status !== "active") {
    throw new Error("The named approver is no longer active.");
  }
  const stableKey = `${input.companyId}:${input.threadId}:${input.sessionId}:${input.inboundMessageId}`;
  const approvalId = input.lineage
    ? deterministicId("approval", `${input.lineage.rootApprovalId}:v${input.lineage.version}`)
    : deterministicId("approval", stableKey);
  const rootApprovalId = input.lineage?.rootApprovalId || approvalId;
  const proposalVersion = input.lineage?.version || 1;
  const taskId = input.lineage
    ? deterministicId("task", approvalId)
    : deterministicId("task", stableKey);
  const callData = call.data() || {};
  const action = {
    kind: "task.create" as const,
    taskId,
    title: generated.proposal.title,
    instructions: generated.proposal.instructions,
    assigneeUid: input.actorUid,
    assigneeName: String(member.data()?.displayName || member.data()?.email || "Team member"),
    dueAt: generated.proposal.dueAt,
    contactId: null,
    caseId: null,
    caseTitle: null,
    callId: generated.proposal.callId,
    subject: { kind: "internal" as const },
    context: {
      callerName: null,
      callerPhone: nullableString(callData.from, 100),
      callSummary: nullableString(callData.summary, 2_000),
      transcriptExcerpt: nullableString(callData.transcript, 500),
    },
  };
  const requestApproval = input.dependencies?.requestApproval || requestWorkflowActionApproval;
  const approval = await requestApproval({
    companyId: input.companyId,
    actorUid: input.actorUid,
    approvalId,
    approverUid: input.actorUid,
    approverName: action.assigneeName,
    action,
    source: {
      kind: "conversation",
      surface: "slack_dm",
      threadId: input.threadId,
      sessionId: input.sessionId,
      messageId: input.inboundMessageId,
      callId: generated.proposal.callId,
      proposalRootId: rootApprovalId,
      proposalVersion,
      ...(input.lineage ? { supersedesApprovalId: input.lineage.supersedesApprovalId } : {}),
    },
    policy: conversationApprovalPolicy("task.create"),
    proposalLineage: {
      rootApprovalId,
      version: proposalVersion,
      supersedesApprovalId: input.lineage?.supersedesApprovalId || null,
      revisionNote: input.lineage?.revisionNote || null,
    },
    access: normalizeResourceAudience(callData.access),
  }, {
    database: input.database,
    resolveActiveMember: async (companyId, uid) => {
      if (companyId !== input.companyId || uid !== input.actorUid) {
        throw new Error("The named approver changed while preparing the proposal.");
      }
      return {
        uid,
        displayName: action.assigneeName,
        email: String(member.data()?.email || ""),
      };
    },
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
