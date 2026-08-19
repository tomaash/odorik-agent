export type ConversationApprovalPolicy = {
  version: "conversation-action-policy-v1";
  riskTier: "internal_write" | "external_draft";
  approvalMode: "named_person_each_version";
  surface: ConversationSurface;
  allowedDecisions: Array<"approve" | "reject" | "request_changes">;
  effectBoundary: string;
};

export type ConversationSurface = "slack_dm" | "teams_personal";

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

export function conversationApprovalPolicy(
  actionKind: string,
  surface: ConversationSurface = "slack_dm",
): ConversationApprovalPolicy {
  const policy = policies[actionKind];
  if (!policy) throw new Error(`Action ${actionKind} is not allowed from a conversation.`);
  return {
    ...policy,
    surface,
    allowedDecisions: [...policy.allowedDecisions],
  };
}
