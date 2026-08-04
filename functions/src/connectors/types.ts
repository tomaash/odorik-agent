export const connectorIds = [
  "odorik",
  "google_workspace",
  "github",
  "grok_subscription",
] as const;

export type ConnectorId = typeof connectorIds[number];
export type ProviderId = "odorik" | "google" | "github" | "grok";
export type ConnectionStatus = "configuring" | "active" | "attention" | "disconnected";
export type ResourceStatus = "enabled" | "disabled";
export type ResourceAudience =
  | { visibility: "company" }
  | { visibility: "restricted"; memberIds: string[] };
export type CapabilityStatus =
  | "active"
  | "attention"
  | "reauthorization_required"
  | "disabled";

export type SyncOperationalPublicView = {
  health:
    | "never_synced"
    | "syncing"
    | "retrying"
    | "fresh"
    | "stale"
    | "attention"
    | "unmeasured";
  latestRunId?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastChangeObservedAt?: string | null;
  lastReconciledAt?: string | null;
  nextRetryAt?: string | null;
  lastError?: string | null;
};

export const sourceCapabilityIds = [
  "context.call.read",
  "context.calendar.read",
  "context.document.read",
  "context.mail.read_scoped",
  "context.github.issue.read",
  // Write grant only: creates Gmail drafts after approval. No observe/sync resources.
  "action.mail.draft.create",
] as const;

export type SourceCapabilityId = typeof sourceCapabilityIds[number];
export type CapabilityServiceId =
  | "calls"
  | "calendar"
  | "drive"
  | "mail"
  | "mail_draft"
  | "issues";
export type ResourceType =
  | "phone_line"
  | "calendar"
  | "folder"
  | "label"
  | "repository"
  | "mailbox";
export type CapabilityDirection = "observe" | "act";

export type SourceCapabilityDescriptor = {
  id: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  direction: CapabilityDirection;
  resourceType: ResourceType;
  requiredScopes: string[];
  syncMode: "webhook" | "incremental" | "reconcile" | "manual";
  /**
   * Observe capabilities never require per-item approval. Act capabilities name
   * an external effect that is still approval-gated through the action registry
   * (this flag is informational for catalog UI).
   */
  requiresApproval: boolean;
};

export type CapabilityConfigurationPublicView = {
  id: CapabilityServiceId;
  capabilityId: SourceCapabilityId;
  status: CapabilityStatus;
  grantedScopes: string[];
  requiredScopes: string[];
  itemCount: number;
  resourceCount: number;
  lastSyncAt?: string | null;
  lastObservedAt?: string | null;
  lastError?: string | null;
  sync?: SyncOperationalPublicView;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ConnectionPublicView = {
  id: string;
  companyId: string;
  connectorId: ConnectorId;
  providerId: ProviderId;
  providerAccountId?: string;
  tenantId?: string;
  displayName: string;
  status: ConnectionStatus;
  authKind: "basic_upload" | "oauth2" | "github_app" | "subscription_oauth";
  credentialMode:
    | "encrypted"
    | "legacy_secret"
    | "shared_secret"
    | "managed_secret"
    | "none";
  uploadUrl?: string;
  accountLabel?: string;
  grantedScopes: string[];
  lastSyncAt?: string | null;
  lastObservedAt?: string | null;
  lastError?: string | null;
  sync?: SyncOperationalPublicView;
  webhook?: {
    status: "pending" | "active" | "attention";
    lastDeliveryAt?: string | null;
    lastEvent?: string | null;
    lastAction?: string | null;
    lastOutcome?: string | null;
    lastError?: string | null;
  };
  subscription?: {
    state:
      | "connecting"
      | "waiting_for_user"
      | "active"
      | "attention"
      | "disconnecting"
      | "disconnected";
    currentAuthSessionId?: string | null;
    teamId?: string | null;
    lastAuthenticatedAt?: string | null;
    sessionExpiresAt?: string | null;
    lastSuccessfulRunAt?: string | null;
    lastDisconnectedAt?: string | null;
    lastError?: string | null;
  };
  /** The provider grant is gone; only fresh consent restores the connection. */
  reauthorizationRequired: boolean;
  itemCount: number;
  resourceCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  capabilities: CapabilityConfigurationPublicView[];
  resources: ConnectionResourcePublicView[];
};

export type ConnectionResourcePublicView = {
  id: string;
  connectionId: string;
  capabilityId: SourceCapabilityId;
  resourceType: ResourceType;
  externalId: string;
  displayName: string;
  status: ResourceStatus;
  audience: ResourceAudience;
  audienceRevision: number;
  itemCount: number;
  lastObservedAt?: string | null;
  sync?: SyncOperationalPublicView;
  document?: {
    recursive: boolean;
    markdownCount: number;
    plainTextCount: number;
    metadataOnlyCount: number;
  };
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ConnectorDescriptor = {
  id: ConnectorId;
  name: string;
  description: string;
  availability: "available" | "needs_configuration";
  capabilities: SourceCapabilityDescriptor[];
};

export interface SourceAdapter<TSource = unknown> {
  readonly descriptor: ConnectorDescriptor;
  normalize(source: TSource): Record<string, unknown>;
}
