export type ConversationApprovalPolicy = {
  version: "conversation-action-policy-v1";
  riskTier: "internal_write" | "external_draft";
  approvalMode: "named_person_each_version";
  surface: "slack_dm";
  allowedDecisions: Array<"approve" | "reject" | "request_changes">;
  effectBoundary: string;
};

const policies: Record<string, ConversationApprovalPolicy> = {
  "task.create": {
    version: "conversation-action-policy-v1",
    riskTier: "internal_write",
    approvalMode: "named_person_each_version",
    surface: "slack_dm",
    allowedDecisions: ["approve", "reject", "request_changes"],
    effectBoundary: "Creates exactly one internal task and performs no external communication.",
  },
  "mail.draft.create": {
    version: "conversation-action-policy-v1",
    riskTier: "external_draft",
    approvalMode: "named_person_each_version",
    surface: "slack_dm",
    allowedDecisions: ["approve", "reject", "request_changes"],
    effectBoundary: "Creates exactly one Gmail draft and never sends email.",
  },
};

export function conversationApprovalPolicy(actionKind: string): ConversationApprovalPolicy {
  const policy = policies[actionKind];
  if (!policy) throw new Error(`Action ${actionKind} is not allowed from a conversation.`);
  return {
    ...policy,
    allowedDecisions: [...policy.allowedDecisions],
  };
}
