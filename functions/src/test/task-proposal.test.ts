import assert from "node:assert/strict";
import test from "node:test";

import { runTaskProposalAgent } from "../agent/task-proposal.js";
import { CitationRegistry, type AgentToolExecutor } from "../agent/tools.js";
import type { AgentModel, ModelTurn } from "../agent/gemini.js";

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

class CallTools implements AgentToolExecutor {
  readonly citations = new CitationRegistry();
  async execute(): Promise<{ result: Record<string, unknown>; citationIds: string[] }> {
    const citation = this.citations.add({
      kind: "call",
      recordId: "call-1",
      sourcePath: "companies/acme/calls/call-1",
      title: "Acme call",
      excerpt: "Acme asked for revised pricing.",
      occurredAt: null,
    });
    return {
      result: { found: true, citationId: citation.citationId, record: { summary: citation.excerpt } },
      citationIds: [citation.citationId],
    };
  }
}

function modelFinal(callId = "call-1", citationIds = ["C1"]): ModelTurn {
  return {
    content: {
      role: "model",
      parts: [{ text: JSON.stringify({
        title: "Call Acme back",
        instructions: "Discuss revised pricing.",
        callId,
        dueAt: null,
        citationIds,
        assumptions: ["No due date was stated"],
      }) }],
    },
    usage: zeroUsage,
  };
}

test("task proposal generation requires fresh tools and an exact cited call anchor", async () => {
  const tools = new CallTools();
  const proposal = await runTaskProposalAgent({
    request: "Create a task to call Acme back",
    priorMessages: [],
    model: new ScriptedModel([
      {
        content: {
          role: "model",
          parts: [{ functionCall: {
            id: "tool-1", name: "get_company_record", args: { kind: "call", record_id: "call-1" },
          } }],
        },
        usage: zeroUsage,
      },
      modelFinal(),
    ]),
    tools,
  });
  assert.equal(proposal.proposal.callId, "call-1");
  assert.equal(proposal.citations[0]?.recordId, "call-1");
  assert.equal(proposal.toolTrace.length, 1);
});

test("task proposal generation rejects an uncited or mismatched source call", async () => {
  await assert.rejects(() => runTaskProposalAgent({
    request: "Create a task",
    priorMessages: [],
    model: new ScriptedModel([
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "get_company_record", args: {} } }],
        },
        usage: zeroUsage,
      },
      modelFinal("other-call"),
    ]),
    tools: new CallTools(),
  }), /cite its exact source call/);

  await assert.rejects(() => runTaskProposalAgent({
    request: "Create a task",
    priorMessages: [],
    model: new ScriptedModel([
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "get_company_record", args: {} } }],
        },
        usage: zeroUsage,
      },
      modelFinal("call-1", ["C99"]),
    ]),
    tools: new CallTools(),
  }), /unknown evidence citations/);
});
