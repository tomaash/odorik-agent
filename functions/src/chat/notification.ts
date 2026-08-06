import type { ResourceAudience } from "../connectors/types.js";

/**
 * What Erik is willing to say out loud in a chat channel about a pending approval.
 *
 * A channel's membership is not an Erik audience. Erik does not know who is in the
 * channel, cannot enforce who joins it later, and cannot revoke a message someone
 * already read. So the channel receives a pointer and never a payload: the kind of
 * decision, who must make it, and a link. What that person may actually see is
 * decided by Erik's own access control when they follow the link.
 *
 * This is deliberately a projection of the stored approval rather than a set of
 * caller-supplied strings — a caller cannot widen it by passing more fields.
 */
export type ApprovalNotification = {
  approvalId: string;
  /** Short human line. Carries no payload from the action. */
  text: string;
  /** Where the decision is actually made. */
  linkUrl: string;
};

/**
 * Human labels for the action kinds that can be waiting. An unregistered kind still
 * notifies — a decision nobody hears about is worse than a vague one — but it says
 * nothing about the action beyond that it exists.
 */
const actionKindLabels: Record<string, string> = {
  "mail.draft.create": "Email draft",
  "task.create": "Task",
  "case.create": "Case",
  "case.move": "Case move",
};

function actionKindLabel(kind: unknown): string {
  const key = typeof kind === "string" ? kind : "";
  return actionKindLabels[key] || "Action";
}

/**
 * Approvals have no route of their own; they render on the case page when they
 * belong to a case and on the task list otherwise. Link where the card actually is,
 * rather than minting a URL that looks precise and resolves nowhere.
 */
export function approvalNotificationLink(input: {
  appOrigin: string;
  caseId?: unknown;
}): string {
  const origin = input.appOrigin.replace(/\/+$/, "");
  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  return caseId ? `${origin}/cases/${encodeURIComponent(caseId)}` : `${origin}/tasks`;
}

function isCompanyWide(audience: unknown): boolean {
  if (!audience || typeof audience !== "object") return false;
  return (audience as ResourceAudience).visibility === "company";
}

/**
 * Compose the notification for one stored approval, or `null` when Erik must stay
 * quiet.
 *
 * Silence is required when the approval is restricted to named members: a shared
 * channel cannot carry a restricted item, and even the bare fact that one exists is
 * more than its audience agreed to. Silence is also required once a decision has
 * been made, so a replayed or retried emission cannot announce settled work.
 */
export function composeApprovalNotification(
  approval: Record<string, unknown>,
  options: { appOrigin: string },
): ApprovalNotification | null {
  const approvalId = typeof approval.id === "string" ? approval.id.trim() : "";
  if (!approvalId) return null;
  if (approval.decisionStatus !== "pending") return null;
  if (!isCompanyWide(approval.access)) return null;

  const action = (approval.action || {}) as Record<string, unknown>;
  const scope = (approval.scope || {}) as Record<string, unknown>;
  const approverName = typeof approval.approverName === "string"
    ? approval.approverName.trim()
    : "";
  const label = actionKindLabel(action.kind);
  const decider = approverName ? ` — ${approverName} decides` : "";
  return {
    approvalId,
    text: `Approval waiting: ${label}${decider}`,
    linkUrl: approvalNotificationLink({
      appOrigin: options.appOrigin,
      caseId: scope.caseId,
    }),
  };
}
