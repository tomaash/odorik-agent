export const adapterIds = [
  "odorik",
  "google_calendar",
  "google_drive",
  "gmail",
  "github",
] as const;

export type AdapterId = typeof adapterIds[number];
export type ConnectionStatus = "configuring" | "active" | "attention" | "disconnected";
export type ResourceStatus = "enabled" | "disabled";

export type ConnectionPublicView = {
  id: string;
  companyId: string;
  adapterId: AdapterId;
  displayName: string;
  status: ConnectionStatus;
  authKind: "basic_upload" | "oauth2" | "github_app";
  credentialMode: "encrypted" | "legacy_secret" | "none";
  uploadUrl?: string;
  accountLabel?: string;
  lastSyncAt?: string | null;
  lastObservedAt?: string | null;
  lastError?: string | null;
  /** Google revoked or expired the grant; only a fresh consent restores it. */
  reauthorizationRequired: boolean;
  itemCount: number;
  resourceCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  resources: ConnectionResourcePublicView[];
};

export type ConnectionResourcePublicView = {
  id: string;
  connectionId: string;
  resourceType: "phone_line" | "calendar" | "folder" | "label" | "repository";
  externalId: string;
  displayName: string;
  status: ResourceStatus;
  itemCount: number;
  lastObservedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type AdapterDescriptor = {
  id: AdapterId;
  name: string;
  description: string;
  resourceNoun: string;
  available: boolean;
  availability: "available" | "needs_configuration" | "planned";
  readOnly: boolean;
};

export interface SourceAdapter<TSource = unknown> {
  readonly descriptor: AdapterDescriptor;
  normalize(source: TSource): Record<string, unknown>;
}

