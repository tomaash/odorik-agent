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
    syncMode: "manual",
    requiresApproval: false,
  },
};

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
    description: "Selected calendars and Drive folders from one Google account.",
    availability: "available",
    capabilities: [
      sourceCapabilities["context.calendar.read"],
      sourceCapabilities["context.document.read"],
    ],
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
