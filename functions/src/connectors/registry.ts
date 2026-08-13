import type {
  ConnectorDescriptor,
  ConnectorId,
  SourceCapabilityDescriptor,
  SourceCapabilityId,
} from "./types.js";

export const calendarScopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

export const driveScopes = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

/**
 * Google publishes no label-scoped mail read scope, so this grant covers the whole
 * mailbox. Erik's label selection is an application boundary over that grant, never a
 * claim that the provider itself was scoped to the selected labels.
 */
export const mailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

/**
 * Google does not publish a draft-only scope. `gmail.compose` can also send;
 * Erik never calls send — product policy, not a provider boundary.
 */
export const mailDraftScopes = [
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

/**
 * `chat:write` posts as the bot; `channels:read` lists channels so an administrator
 * can choose one. Neither grants any view of a conversation — H1 writes only.
 */
export const chatNotifyScopes = [
  "chat:write",
  "channels:read",
] as const;

/** Receives only messages sent directly to the bot, never channel history. */
export const chatDirectScopes = ["im:history"] as const;

export const slackScopes = [...chatNotifyScopes, ...chatDirectScopes] as const;

export const sourceCapabilities: Record<SourceCapabilityId, SourceCapabilityDescriptor> = {
  "context.call.read": {
    id: "context.call.read",
    serviceId: "calls",
    direction: "observe",
    resourceType: "phone_line",
    requiredScopes: [],
    syncMode: "webhook",
    requiresApproval: false,
  },
  "context.calendar.read": {
    id: "context.calendar.read",
    serviceId: "calendar",
    direction: "observe",
    resourceType: "calendar",
    requiredScopes: [...calendarScopes],
    syncMode: "incremental",
    requiresApproval: false,
  },
  "context.document.read": {
    id: "context.document.read",
    serviceId: "drive",
    direction: "observe",
    resourceType: "folder",
    requiredScopes: [...driveScopes],
    syncMode: "reconcile",
    requiresApproval: false,
  },
  "context.mail.read_scoped": {
    id: "context.mail.read_scoped",
    serviceId: "mail",
    direction: "observe",
    resourceType: "label",
    requiredScopes: [...mailScopes],
    syncMode: "incremental",
    requiresApproval: false,
  },
  "action.mail.draft.create": {
    id: "action.mail.draft.create",
    serviceId: "mail_draft",
    direction: "act",
    resourceType: "mailbox",
    requiredScopes: [...mailDraftScopes],
    syncMode: "manual",
    requiresApproval: true,
  },
  "action.chat.notify": {
    id: "action.chat.notify",
    serviceId: "chat_notify",
    direction: "act",
    resourceType: "channel",
    requiredScopes: [...chatNotifyScopes],
    syncMode: "manual",
    // Delivery is authorized once, when the destination is configured. Approving
    // each notice about a pending approval would be circular.
    requiresApproval: false,
  },
  "context.chat.direct": {
    id: "context.chat.direct",
    serviceId: "chat_direct",
    direction: "observe",
    resourceType: "direct_message",
    requiredScopes: [...chatDirectScopes],
    syncMode: "webhook",
    requiresApproval: false,
  },
  "context.github.issue.read": {
    id: "context.github.issue.read",
    serviceId: "issues",
    direction: "observe",
    resourceType: "repository",
    requiredScopes: [
      "contents:write",
      "issues:read",
      "metadata:read",
      "pull_requests:write",
    ],
    syncMode: "webhook",
    requiresApproval: false,
  },
};

/**
 * Every capability that can be granted on a Google Workspace connection.
 *
 * This is deliberately separate from what the catalog *offers*: a capability is
 * grantable once its scopes and grant state are modeled, but it is only listed on the
 * connector card once its operating loop exists. Validation of OAuth state must use
 * this set rather than a hand-maintained literal, so adding a Google capability never
 * needs a second edit in the callback.
 */
export const googleWorkspaceCapabilityIds: readonly SourceCapabilityId[] = [
  "context.calendar.read",
  "context.document.read",
  "context.mail.read_scoped",
  "action.mail.draft.create",
] as const;

const descriptors: Record<ConnectorId, ConnectorDescriptor> = {
  odorik: {
    id: "odorik",
    name: "Odorik",
    description: "Recorded calls received through an authenticated upload destination.",
    availability: "available",
    capabilities: [sourceCapabilities["context.call.read"]],
  },
  google_workspace: {
    id: "google_workspace",
    name: "Google Workspace",
    description:
      "Selected calendars, Drive folders, and mail labels from one Google account.",
    availability: "available",
    // Invariant 10 gates a capability on its *operating loop*, which for an observe
    // capability is select a resource, ingest it, and cite it in an answer — plus the
    // failure behavior around that. It is not the external-write loop; requiring G2/G3
    // before the mail card could even be configured would be circular, since the loop
    // cannot be exercised without the configuration UI that shows it.
    capabilities: [
      sourceCapabilities["context.calendar.read"],
      sourceCapabilities["context.document.read"],
      sourceCapabilities["context.mail.read_scoped"],
      sourceCapabilities["action.mail.draft.create"],
    ],
  },
  github: {
    id: "github",
    name: "GitHub",
    description: "Issues and comments from explicitly selected repositories.",
    availability: "available",
    capabilities: [sourceCapabilities["context.github.issue.read"]],
  },
  slack: {
    id: "slack",
    name: "Slack",
    description:
      "Posts pending-approval notices to explicitly selected Slack channels.",
    availability: "available",
    // H2 direct conversation remains a prototype. Do not expose its read grant
    // in the connector setup until the ordered conversation runtime is accepted.
    capabilities: [sourceCapabilities["action.chat.notify"]],
  },
  grok_subscription: {
    id: "grok_subscription",
    name: "Grok subscription",
    description: "Subscription OAuth used only by the isolated coding runner.",
    availability: "available",
    capabilities: [],
  },
};

export function connectorCatalog(): ConnectorDescriptor[] {
  return Object.values(descriptors);
}

export function capabilityDescriptor(
  capabilityId: SourceCapabilityId,
): SourceCapabilityDescriptor {
  return sourceCapabilities[capabilityId];
}
