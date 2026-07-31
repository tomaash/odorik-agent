export const connectorIds = [
  "odorik",
  "google_workspace",
  "github",
] as const;

export type ConnectorId = typeof connectorIds[number];
export type ProviderId = "odorik" | "google" | "github";
export type ConnectionStatus = "configuring" | "active" | "attention" | "disconnected";
export type ResourceStatus = "enabled" | "disabled";
export type CapabilityStatus =
  | "active"
  | "attention"
  | "reauthorization_required"
  | "disabled";

export const sourceCapabilityIds = [
  "context.call.read",
  "context.calendar.read",
  "context.document.read",
  "context.github.issue.read",
] as const;

export type SourceCapabilityId = typeof sourceCapabilityIds[number];
export type CapabilityServiceId = "calls" | "calendar" | "drive" | "issues";
export type ResourceType = "phone_line" | "calendar" | "folder" | "repository";

export type SourceCapabilityDescriptor = {
  id: SourceCapabilityId;
  serviceId: CapabilityServiceId;
  direction: "observe";
  resourceType: ResourceType;
  requiredScopes: string[];
  syncMode: "webhook" | "incremental" | "manual";
  requiresApproval: false;
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
  authKind: "basic_upload" | "oauth2" | "github_app";
  credentialMode: "encrypted" | "legacy_secret" | "shared_secret" | "none";
  uploadUrl?: string;
  accountLabel?: string;
  grantedScopes: string[];
  lastSyncAt?: string | null;
  lastObservedAt?: string | null;
  lastError?: string | null;
  webhook?: {
    status: "pending" | "active" | "attention";
    lastDeliveryAt?: string | null;
    lastEvent?: string | null;
    lastAction?: string | null;
    lastOutcome?: string | null;
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
  itemCount: number;
  lastObservedAt?: string | null;
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
