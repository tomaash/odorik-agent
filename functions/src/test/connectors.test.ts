import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  calendarContextItemId,
  calendarEventContextItem,
  calendarEventsUrl,
  calendarResourceId,
  calendarSyncTokenForRun,
  type CalendarEvent,
} from "../connectors/google-calendar.js";
import {
  driveContextItem,
  driveContextItemId,
  driveFolderFilesQuery,
  folderResourceId,
  importableDriveFiles,
} from "../connectors/google-drive.js";
import {
  odorikContextItem,
  odorikContextItemId,
} from "../connectors/odorik.js";
import {
  deleteSourceConnection,
  listSources,
  prepareConnectionDeletion,
  resetGoogleConnectorData,
  setCapabilityStatus,
  setConnectionStatus,
  setResourceStatus,
  setResourceAudience,
} from "../connectors/repository.js";
import {
  capabilityGrantState,
  createGoogleWorkspaceAuthorization,
  googleWorkspaceConnectionId,
  scopesForCapabilities,
} from "../connectors/google-oauth.js";
import {
  capabilityDescriptor,
  connectorCatalog,
  googleWorkspaceCapabilityIds,
} from "../connectors/registry.js";
import { MemoryFirestore } from "./firestore-harness.js";

test("source public views retain operational state and exclude credentials", async () => {
  const memory = new MemoryFirestore();
  memory.seed("companies/explorers/connections/google-a", {
    companyId: "explorers",
    connectorId: "google_workspace",
    providerId: "google",
    providerAccountId: "google-sub-1",
    displayName: "Google Workspace",
    accountLabel: "operator@example.com",
    status: "active",
    reauthorizationRequired: false,
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      internalHint: "must-stay-private",
    },
    credentialCiphertext: "encrypted-top-secret",
    authorizedBy: {
      email: "private-operator@example.com",
    },
    stats: {
      itemCount: 3,
      lastSyncAt: "2026-07-30T10:00:00.000Z",
      lastObservedAt: "2026-07-30T09:59:00.000Z",
      lastError: null,
    },
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  });
  memory.seed("companies/explorers/connections/google-a/capabilities/drive", {
    capabilityId: "context.document.read",
    serviceId: "drive",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    stats: {
      itemCount: 3,
      lastSyncAt: "2026-07-30T10:00:00.000Z",
      lastObservedAt: "2026-07-30T09:59:00.000Z",
      lastError: null,
    },
  });
  memory.seed("companies/explorers/connections/google-a/resources/folder-a", {
    connectionId: "google-a",
    capabilityId: "context.document.read",
    resourceType: "folder",
    externalId: "provider-folder-a",
    displayName: "Customers",
    status: "enabled",
    audience: { visibility: "company" },
    audienceRevision: 1,
    itemCount: 3,
    providerSecret: "resource-secret",
    syncToken: "private-provider-cursor",
    syncLease: { runId: "private-run", token: "private-lease" },
    sync: {
      health: "retrying",
      latestRunId: "sync-run-1",
      lastAttemptAt: "2026-07-30T10:00:00.000Z",
      lastSuccessAt: "2026-07-30T09:00:00.000Z",
      lastChangeObservedAt: "2026-07-30T09:59:00.000Z",
      lastReconciledAt: "2026-07-30T09:00:00.000Z",
      nextRetryAt: "2026-07-30T10:05:00.000Z",
      lastError: "Provider temporarily unavailable",
    },
    lastObservedAt: "2026-07-30T09:59:00.000Z",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  });

  const result = await listSources("explorers", memory.asFirestore());
  const connection = result.connections[0];
  assert.ok(connection);
  assert.deepEqual({
    id: connection.id,
    companyId: connection.companyId,
    connectorId: connection.connectorId,
    providerId: connection.providerId,
    providerAccountId: connection.providerAccountId,
    displayName: connection.displayName,
    status: connection.status,
    authKind: connection.authKind,
    credentialMode: connection.credentialMode,
    accountLabel: connection.accountLabel,
    lastSyncAt: connection.lastSyncAt,
    lastObservedAt: connection.lastObservedAt,
    lastError: connection.lastError,
    itemCount: connection.itemCount,
    resourceCount: connection.resourceCount,
  }, {
    id: "google-a",
    companyId: "explorers",
    connectorId: "google_workspace",
    providerId: "google",
    providerAccountId: "google-sub-1",
    displayName: "Google Workspace",
    status: "active",
    authKind: "oauth2",
    credentialMode: "encrypted",
    accountLabel: "operator@example.com",
    lastSyncAt: "2026-07-30T10:00:00.000Z",
    lastObservedAt: "2026-07-30T09:59:00.000Z",
    lastError: null,
    itemCount: 3,
    resourceCount: 1,
  });
  assert.deepEqual(connection.resources[0], {
    id: "folder-a",
    connectionId: "google-a",
    capabilityId: "context.document.read",
    resourceType: "folder",
    externalId: "provider-folder-a",
    displayName: "Customers",
    status: "enabled",
    audience: { visibility: "company" },
    audienceRevision: 1,
    itemCount: 3,
    lastObservedAt: "2026-07-30T09:59:00.000Z",
    sync: {
      health: "retrying",
      latestRunId: "sync-run-1",
      lastAttemptAt: "2026-07-30T10:00:00.000Z",
      lastSuccessAt: "2026-07-30T09:00:00.000Z",
      lastChangeObservedAt: "2026-07-30T09:59:00.000Z",
      lastReconciledAt: "2026-07-30T09:00:00.000Z",
      nextRetryAt: "2026-07-30T10:05:00.000Z",
      lastError: "Provider temporarily unavailable",
    },
    document: {
      recursive: false,
      markdownCount: 0,
      plainTextCount: 0,
      metadataOnlyCount: 0,
    },
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  });

  const publicJson = JSON.stringify(result);
  assert.doesNotMatch(publicJson, /encrypted-top-secret/);
  assert.doesNotMatch(publicJson, /must-stay-private/);
  assert.doesNotMatch(publicJson, /private-operator/);
  assert.doesNotMatch(publicJson, /resource-secret/);
  assert.doesNotMatch(publicJson, /private-provider-cursor|private-lease|private-run/);
  assert.deepEqual(
    result.connectors.map((connector) => ({
      id: connector.id,
      availability: connector.availability,
      capabilities: connector.capabilities.map((capability) => capability.id),
    })),
    [
      {
        id: "odorik",
        availability: "available",
        capabilities: ["context.call.read"],
      },
      {
        id: "google_workspace",
        availability: "available",
        capabilities: [
          "context.calendar.read",
          "context.document.read",
          "context.mail.read_scoped",
        ],
      },
      {
        id: "github",
        availability: "available",
        capabilities: ["context.github.issue.read"],
      },
      {
        id: "grok_subscription",
        availability: "available",
        capabilities: [],
      },
    ],
  );
  assert.deepEqual(connection.capabilities.map((capability) => ({
    id: capability.id,
    capabilityId: capability.capabilityId,
    status: capability.status,
    grantedScopes: capability.grantedScopes,
    resourceCount: capability.resourceCount,
  })), [{
    id: "drive",
    capabilityId: "context.document.read",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    resourceCount: 1,
  }]);
});

test("connection and resource lifecycle preserves or removes context intentionally", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionPath = "companies/explorers/connections/odorik-a";
  const resourcePath = `${connectionPath}/resources/phone-a`;
  const contextPath = "companies/explorers/contextItems/call-a";
  const otherContextPath = "companies/explorers/contextItems/call-other";
  const callPath = "companies/explorers/calls/call-a";
  const otherCallPath = "companies/explorers/calls/call-other";

  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "odorik",
    providerId: "odorik",
    displayName: "Odorik sales",
    status: "active",
    credentialCiphertext: "encrypted-credential",
  });
  memory.seed(resourcePath, {
    connectionId: "odorik-a",
    capabilityId: "context.call.read",
    resourceType: "phone_line",
    externalId: "line:Sales",
    displayName: "Sales",
    status: "enabled",
  });
  memory.seed(contextPath, {
    source: {
      connectionId: "odorik-a",
      resourceId: "phone-a",
    },
    access: { visibility: "company" },
    indexingEnabled: true,
  });
  memory.seed(otherContextPath, {
    source: {
      connectionId: "odorik-b",
      resourceId: "phone-b",
    },
    access: { visibility: "company" },
    indexingEnabled: true,
  });
  memory.seed(callPath, {
    connectionId: "odorik-a",
    contextEnabled: true,
  });
  memory.seed(otherCallPath, {
    connectionId: "odorik-b",
    contextEnabled: true,
  });

  await setConnectionStatus(
    "explorers",
    "odorik-a",
    "disconnected",
    "admin-1",
    database,
  );
  assert.equal(memory.read(connectionPath)?.status, "disconnected");
  assert.ok(memory.read(resourcePath));
  assert.ok(memory.read(contextPath));

  await setResourceStatus({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    enabled: false,
    actorUid: "admin-1",
  }, database);
  assert.equal(memory.read(resourcePath)?.status, "disabled");
  assert.deepEqual(memory.read(contextPath)?.access, { visibility: "company" });
  assert.equal(memory.read(contextPath)?.indexingEnabled, false);
  assert.equal(memory.read(otherContextPath)?.indexingEnabled, true);

  await setResourceStatus({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    enabled: true,
    actorUid: "admin-1",
  }, database);
  assert.equal(memory.read(resourcePath)?.status, "enabled");
  assert.deepEqual(memory.read(contextPath)?.access, {
    visibility: "company",
  });
  assert.equal(memory.read(contextPath)?.indexingEnabled, true);

  assert.deepEqual(
    await prepareConnectionDeletion(
      "explorers",
      "odorik-a",
      "admin-1",
      database,
    ),
    {
      connectorId: "odorik",
      displayName: "Odorik sales",
    },
  );
  assert.equal(memory.read(connectionPath)?.status, "disconnected");
  assert.ok(memory.read(resourcePath));
  assert.ok(memory.read(contextPath));

  const result = await deleteSourceConnection({
    companyId: "explorers",
    connectionId: "odorik-a",
    actorUid: "admin-1",
    connectorId: "odorik",
    displayName: "Odorik sales",
    providerAccessRevoked: null,
  }, database);
  assert.deepEqual(result, {
    ok: true,
    connectionId: "odorik-a",
    resourcesDeleted: 1,
    contextItemsDeleted: 1,
    sourceRecordsDisabled: 1,
    providerAccessRevoked: null,
  });
  assert.equal(memory.read(connectionPath), undefined);
  assert.equal(memory.read(resourcePath), undefined);
  assert.equal(memory.read(contextPath), undefined);
  assert.ok(memory.read(otherContextPath));
  assert.equal(memory.read(callPath)?.contextEnabled, false);
  assert.equal(memory.read(callPath)?.sourceConnectionDeletedAt, "server-timestamp");
  assert.equal(memory.read(otherCallPath)?.contextEnabled, true);

  const auditEvents = memory.list("companies/explorers/auditEvents");
  assert.equal(auditEvents.length, 1);
  assert.deepEqual({
    eventType: auditEvents[0]?.eventType,
    actorUid: auditEvents[0]?.actorUid,
    connectionId: auditEvents[0]?.connectionId,
    connectorId: auditEvents[0]?.connectorId,
    resourcesDeleted: auditEvents[0]?.resourcesDeleted,
    contextItemsDeleted: auditEvents[0]?.contextItemsDeleted,
    sourceRecordsDisabled: auditEvents[0]?.sourceRecordsDisabled,
  }, {
    eventType: "source.connection_deleted",
    actorUid: "admin-1",
    connectionId: "odorik-a",
    connectorId: "odorik",
    resourcesDeleted: 1,
    contextItemsDeleted: 1,
    sourceRecordsDisabled: 1,
  });
  assert.doesNotMatch(JSON.stringify(auditEvents), /encrypted-credential/);
});

test("resource audiences validate members and re-project every call-derived retrieval record", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const base = "companies/explorers";
  const connection = `${base}/connections/odorik-a`;
  const resource = `${connection}/resources/phone-a`;
  memory.seed(connection, {
    companyId: "explorers",
    connectorId: "odorik",
    providerId: "odorik",
    status: "active",
  });
  memory.seed(resource, {
    connectionId: "odorik-a",
    capabilityId: "context.call.read",
    resourceType: "phone_line",
    externalId: "line:Sales",
    displayName: "Sales",
    status: "enabled",
    audience: { visibility: "company" },
    audienceRevision: 1,
  });
  memory.seed(`${base}/memberships/member-a`, { status: "active" });
  memory.seed(`${base}/memberships/member-b`, { status: "active" });
  memory.seed(`${base}/memberships/inactive`, { status: "disabled" });
  memory.seed(`${base}/contextItems/context-a`, {
    source: { connectionId: "odorik-a", resourceId: "phone-a" },
    access: { visibility: "company" },
    indexingEnabled: true,
  });
  memory.seed(`${base}/calls/call-a`, {
    connectionId: "odorik-a",
    resourceId: "phone-a",
    contactId: "contact-a",
    access: { visibility: "company" },
    contextEnabled: true,
    indexingEnabled: true,
  });
  memory.seed(`${base}/contacts/contact-a`, {
    origin: "call",
    createdFromCallId: "call-a",
    access: { visibility: "company" },
    indexingEnabled: true,
  });
  for (const [collection, id, link] of [
    ["workItems", "task-a", { callId: "call-a" }],
    ["cases", "case-a", { callId: "call-a" }],
    ["actionApprovals", "approval-a", { source: { callId: "call-a" } }],
    ["workflowRuns", "run-a", { contextId: "call-a" }],
    ["auditEvents", "event-a", { callId: "call-a" }],
    ["actionApprovals", "approval-issue", { source: { issueContextItemId: "context-a" } }],
    ["codingRuns", "coding-a", { github: { issueContextItemId: "context-a" } }],
  ] as const) {
    memory.seed(`${base}/${collection}/${id}`, {
      ...link,
      access: { visibility: "company" },
      indexingEnabled: true,
    });
  }

  await assert.rejects(() => setResourceAudience({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    audience: { visibility: "restricted", memberIds: ["inactive"] },
    expectedRevision: 1,
    confirmBroadening: false,
    actorUid: "admin-a",
  }, database), /inactive company member/);

  const projected = await setResourceAudience({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    audience: { visibility: "restricted", memberIds: ["member-a"] },
    expectedRevision: 1,
    confirmBroadening: false,
    actorUid: "admin-a",
  }, database);
  assert.deepEqual(projected, {
    changed: true,
    revision: 2,
    projectedItems: 1,
    projectedCalls: 1,
  });
  for (const path of [
    resource,
    `${base}/contextItems/context-a`,
    `${base}/calls/call-a`,
    `${base}/contacts/contact-a`,
    `${base}/workItems/task-a`,
    `${base}/cases/case-a`,
    `${base}/actionApprovals/approval-a`,
    `${base}/workflowRuns/run-a`,
    `${base}/auditEvents/event-a`,
    `${base}/actionApprovals/approval-issue`,
    `${base}/codingRuns/coding-a`,
  ]) {
    const data = memory.read(path);
    const audience = path === resource ? data?.audience : data?.access;
    assert.deepEqual(audience, { visibility: "restricted", memberIds: ["member-a"] }, path);
  }

  await assert.rejects(() => setResourceAudience({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    audience: { visibility: "company" },
    expectedRevision: 2,
    confirmBroadening: false,
    actorUid: "admin-a",
  }, database), /AUDIENCE_BROADENING_REQUIRES_CONFIRMATION/);

  await setResourceStatus({
    companyId: "explorers",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    enabled: false,
    actorUid: "admin-a",
  }, database);
  for (const path of [
    `${base}/contextItems/context-a`,
    `${base}/calls/call-a`,
    `${base}/contacts/contact-a`,
    `${base}/workItems/task-a`,
    `${base}/cases/case-a`,
    `${base}/actionApprovals/approval-a`,
    `${base}/workflowRuns/run-a`,
    `${base}/auditEvents/event-a`,
    `${base}/actionApprovals/approval-issue`,
    `${base}/codingRuns/coding-a`,
  ]) assert.equal(memory.read(path)?.indexingEnabled, false, path);
});

test("Calendar incremental sync keeps stable identity and deletes cancellations", () => {
  const observedAt = Timestamp.fromDate(new Date("2026-07-30T11:00:00.000Z"));
  const event: CalendarEvent = {
    id: "event-1",
    status: "confirmed",
    summary: "Customer follow-up",
    description: "Discuss contract renewal",
    htmlLink: "https://calendar.google.com/event?eid=event-1",
    updated: "2026-07-30T10:30:00.000Z",
    start: { dateTime: "2026-08-01T09:00:00+02:00" },
    end: { dateTime: "2026-08-01T09:30:00+02:00" },
    organizer: { email: "owner@example.com" },
    attendees: [{ email: "customer@example.com", responseStatus: "accepted" }],
  };
  const baseInput = {
    companyId: "explorers",
    connectionId: "calendar-connection",
    resourceId: calendarResourceId("primary@example.com"),
    calendarId: "primary@example.com",
    calendarName: "Primary",
    observedAt,
    audience: { visibility: "restricted" as const, memberIds: ["member-a"] },
    audienceRevision: 4,
  };
  const initial = calendarEventContextItem({ ...baseInput, event });
  const changed = calendarEventContextItem({
    ...baseInput,
    event: { ...event, description: "Discuss signed renewal" },
  });
  assert.ok(initial);
  assert.ok(changed);
  assert.equal(
    calendarContextItemId("calendar-connection", "primary@example.com", "event-1"),
    calendarContextItemId("calendar-connection", "primary@example.com", "event-1"),
  );
  assert.notEqual(
    calendarContextItemId("calendar-connection", "primary@example.com", "event-1"),
    calendarContextItemId("other-connection", "primary@example.com", "event-1"),
  );
  assert.deepEqual(initial.source, {
    providerId: "google",
    capabilityId: "context.calendar.read",
    connectionId: "calendar-connection",
    resourceId: calendarResourceId("primary@example.com"),
    externalId: "event-1",
    version: "2026-07-30T10:30:00.000Z",
  });
  assert.deepEqual(initial.access, { visibility: "restricted", memberIds: ["member-a"] });
  assert.equal(initial.accessRevision, 4);
  assert.deepEqual(initial.participantRefs, [
    "owner@example.com",
    "customer@example.com",
  ]);
  assert.equal(
    (initial.provenance as Record<string, unknown>).rawRef,
    "google-calendar/primary@example.com/events/event-1",
  );
  assert.notEqual(
    (initial.provenance as Record<string, unknown>).checksum,
    (changed.provenance as Record<string, unknown>).checksum,
  );
  assert.equal(
    calendarEventContextItem({
      ...baseInput,
      event: { id: "event-1", status: "cancelled" },
    }),
    null,
  );

  const full = calendarEventsUrl({
    calendarId: "primary@example.com",
    timeMin: "2025-07-30T00:00:00.000Z",
  });
  assert.equal(full.searchParams.get("timeMin"), "2025-07-30T00:00:00.000Z");
  assert.equal(full.searchParams.get("syncToken"), null);
  assert.equal(full.searchParams.get("showDeleted"), "true");
  assert.equal(full.searchParams.get("singleEvents"), "true");

  const incremental = calendarEventsUrl({
    calendarId: "primary@example.com",
    syncToken: "sync-token-1",
    pageToken: "page-2",
    timeMin: "ignored",
  });
  assert.equal(incremental.searchParams.get("syncToken"), "sync-token-1");
  assert.equal(incremental.searchParams.get("timeMin"), null);
  assert.equal(incremental.searchParams.get("pageToken"), "page-2");

  assert.equal(
    calendarSyncTokenForRun({ syncToken: "sync-token-1" }),
    "sync-token-1",
  );
  assert.equal(
    calendarSyncTokenForRun({
      syncToken: "sync-token-1",
      requiresFullSync: true,
    }),
    "",
  );
  assert.equal(
    calendarSyncTokenForRun({ syncToken: "sync-token-1" }, true),
    "",
  );
});

test("Drive sync uses recursive listings, canonical file identity, and normalized provenance", () => {
  const query = driveFolderFilesQuery("folder-a", "page-2");
  assert.equal(query.get("q"), "'folder-a' in parents and trashed = false");
  assert.equal(query.get("pageToken"), "page-2");
  assert.equal(query.get("pageSize"), "1000");

  const importable = importableDriveFiles([
    {
      id: "doc-1",
      name: "Renewal.md",
      mimeType: "text/markdown",
    },
    {
      id: "folder-child",
      name: "Nested",
      mimeType: "application/vnd.google-apps.folder",
    },
    {
      id: "missing-name",
      mimeType: "text/plain",
    },
  ]);
  assert.deepEqual(importable.map((file) => file.id), ["doc-1"]);

  const observedAt = Timestamp.fromDate(new Date("2026-07-30T11:00:00.000Z"));
  const file = {
    id: "doc-1",
    name: "Renewal.md",
    mimeType: "text/markdown",
    modifiedTime: "2026-07-30T10:00:00.000Z",
    webViewLink: "https://drive.google.com/file/d/doc-1/view",
  };
  const item = driveContextItem({
    companyId: "explorers",
    connectionId: "drive-connection",
    folderId: "folder-a",
    file,
    contentText: "Customer requested a renewal proposal.",
    observedAt,
    audience: { visibility: "restricted", memberIds: ["member-a"] },
    audienceRevision: 5,
  });
  assert.equal(
    folderResourceId("folder-a"),
    folderResourceId("folder-a"),
  );
  assert.equal(
    driveContextItemId("drive-connection", "folder-a", "doc-1"),
    driveContextItemId("drive-connection", "folder-a", "doc-1"),
  );
  assert.equal(
    driveContextItemId("drive-connection", "folder-a", "doc-1"),
    driveContextItemId("drive-connection", "folder-b", "doc-1"),
  );
  assert.notEqual(
    driveContextItemId("drive-connection", "doc-1"),
    driveContextItemId("other-connection", "doc-1"),
  );
  assert.deepEqual(item.source, {
    providerId: "google",
    capabilityId: "context.document.read",
    connectionId: "drive-connection",
    resourceId: folderResourceId("folder-a"),
    externalId: "doc-1",
    version: "2026-07-30T10:00:00.000Z",
  });
  assert.deepEqual(item.access, { visibility: "restricted", memberIds: ["member-a"] });
  assert.equal(item.accessRevision, 5);
  assert.deepEqual(item.artifactRefs, [
    "https://drive.google.com/file/d/doc-1/view",
  ]);
  assert.deepEqual(item.provenance, {
    checksum: "0e9b432e4e6e1ed0aeef70fc4b2d6c4218cf1c15f83fa473299d23cd6e15ff49",
    ingestionVersion: "google-drive-v2",
    modifiedTime: "2026-07-30T10:00:00.000Z",
  });
});

test("Odorik context identity is connection-scoped and provenance is stable", () => {
  const call = {
    status: "completed",
    connectionId: "odorik-a",
    resourceId: "phone-a",
    from: "+420777123456",
    to: "+420222333444",
    summary: "Renewal requested.",
    transcript: "Please prepare the renewal.",
    processedAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    access: { visibility: "restricted" as const, memberIds: ["member-a"] },
    accessRevision: 6,
  };
  const first = odorikContextItem("call-1", call, "explorers");
  const second = odorikContextItem("call-1", { ...call }, "explorers");
  assert.ok(first);
  assert.ok(second);
  assert.equal(
    odorikContextItemId("odorik-a", "call-1"),
    odorikContextItemId("odorik-a", "call-1"),
  );
  assert.notEqual(
    odorikContextItemId("odorik-a", "call-1"),
    odorikContextItemId("odorik-b", "call-1"),
  );
  assert.deepEqual(first.source, second.source);
  assert.deepEqual(first.access, { visibility: "restricted", memberIds: ["member-a"] });
  assert.equal(first.accessRevision, 6);
  assert.deepEqual(first.provenance, second.provenance);
  assert.equal(
    (first.provenance as Record<string, unknown>).rawRef,
    "companies/explorers/calls/call-1",
  );
});

test("Workspace scope planning enables only explicitly requested complete grants", () => {
  assert.deepEqual(
    scopesForCapabilities(["context.calendar.read"]),
    [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  );
  assert.deepEqual(
    scopesForCapabilities([
      "context.calendar.read",
      "context.document.read",
      "context.calendar.read",
    ]),
    [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  );
  assert.deepEqual(capabilityGrantState(
    ["context.calendar.read", "context.document.read"],
    [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  ), {
    enabledCapabilityIds: ["context.calendar.read"],
    missingCapabilityIds: ["context.document.read"],
  });
  assert.equal(
    googleWorkspaceConnectionId("google-sub-1"),
    googleWorkspaceConnectionId("google-sub-1"),
  );
  assert.notEqual(
    googleWorkspaceConnectionId("google-sub-1"),
    googleWorkspaceConnectionId("google-sub-2"),
  );
});

test("scoped mail planning reuses the generic Workspace grant machinery", () => {
  // Registering the descriptor is the whole of G1.1: scope planning, partial-consent
  // fail-closed behavior, and per-capability grant state derive from the registry, so
  // mail must work through them without a mail-specific branch anywhere.
  assert.deepEqual(
    scopesForCapabilities(["context.mail.read_scoped"]),
    ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
  );
  assert.deepEqual(
    scopesForCapabilities([
      "context.calendar.read",
      "context.document.read",
      "context.mail.read_scoped",
    ]),
    [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  );

  // A Workspace grant that omits the mail scope enables the siblings and fails mail
  // closed rather than importing a mailbox on a partial consent.
  assert.deepEqual(capabilityGrantState(
    ["context.calendar.read", "context.document.read", "context.mail.read_scoped"],
    [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  ), {
    enabledCapabilityIds: ["context.calendar.read", "context.document.read"],
    missingCapabilityIds: ["context.mail.read_scoped"],
  });

  const mail = capabilityDescriptor("context.mail.read_scoped");
  assert.equal(mail.serviceId, "mail");
  assert.equal(mail.resourceType, "label");
  assert.equal(mail.direction, "observe");
  assert.equal(mail.requiresApproval, false);
});

test("reconnecting re-requests every service still enabled on the connection", async () => {
  // Google issues one credential per connection, and an External app in Testing status
  // expires refresh tokens after seven days, so this reconnect runs weekly. Consenting
  // to only the service being added would replace the envelope without the others'
  // scopes and silently downgrade them.
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionPath = "companies/explorers/connections/google-a";
  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "google_workspace",
    providerId: "google",
    accountLabel: "owner@example.com",
    status: "attention",
    reauthorizationRequired: true,
  });
  memory.seed(`${connectionPath}/capabilities/calendar`, {
    capabilityId: "context.calendar.read",
    status: "reauthorization_required",
  });
  memory.seed(`${connectionPath}/capabilities/drive`, {
    capabilityId: "context.document.read",
    status: "reauthorization_required",
  });
  memory.seed(`${connectionPath}/capabilities/mail`, {
    capabilityId: "context.mail.read_scoped",
    status: "disabled",
  });

  const { authorizationUrl } = await createGoogleWorkspaceAuthorization({
    companyId: "explorers",
    uid: "member-1",
    email: "owner@example.com",
    displayName: "Owner",
    clientId: "client-1",
    // The member is only reconnecting Calendar from the expired-connection banner.
    capabilityIds: ["context.calendar.read"],
    connectionId: "google-a",
    database,
  });
  const requestedScopes = new Set(
    (new URL(authorizationUrl).searchParams.get("scope") || "").split(" "),
  );

  // Drive was enabled, so it must come back in the same consent.
  assert.ok(requestedScopes.has("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.ok(requestedScopes.has("https://www.googleapis.com/auth/drive.readonly"));
  // Mail was explicitly disabled: reconnecting must not quietly re-acquire its grant.
  assert.ok(!requestedScopes.has("https://www.googleapis.com/auth/gmail.readonly"));
  assert.equal(new URL(authorizationUrl).searchParams.get("login_hint"), "owner@example.com");
});

test("the Workspace catalog offers every capability with a complete observe loop", () => {
  // Invariant 10 gates a capability on its operating loop. For an observe capability
  // that loop is select, ingest, cite — not the G2/G3 external-write loop, which would
  // be circular: the loop cannot be exercised without the configuration UI that shows
  // it. Mail is listed because its adapter, cursor recovery, and failure behavior exist.
  const workspace = connectorCatalog().find((entry) => entry.id === "google_workspace");
  assert.ok(workspace);
  assert.deepEqual(
    workspace.capabilities.map((capability) => capability.id),
    ["context.calendar.read", "context.document.read", "context.mail.read_scoped"],
  );
  // Grantable is deliberately wider than offered: the OAuth callback validates against
  // this set, so mail must be accepted in authorization state even while the card does
  // not offer it. Before G1 that validation was a hand-maintained literal of two IDs,
  // which silently dropped any third capability.
  assert.deepEqual([...googleWorkspaceCapabilityIds], [
    "context.calendar.read",
    "context.document.read",
    "context.mail.read_scoped",
  ]);
});

test("Workspace capability lifecycle is isolated from the account and sibling service", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const connectionPath = "companies/explorers/connections/google-a";
  const calendarCapabilityPath = `${connectionPath}/capabilities/calendar`;
  const driveCapabilityPath = `${connectionPath}/capabilities/drive`;
  const calendarResourcePath = `${connectionPath}/resources/calendar-a`;
  const driveResourcePath = `${connectionPath}/resources/folder-a`;
  const calendarContextPath = "companies/explorers/contextItems/calendar-a";
  const driveContextPath = "companies/explorers/contextItems/drive-a";

  memory.seed(connectionPath, {
    companyId: "explorers",
    connectorId: "google_workspace",
    providerId: "google",
    status: "active",
  });
  memory.seed(calendarCapabilityPath, {
    capabilityId: "context.calendar.read",
    serviceId: "calendar",
    status: "active",
  });
  memory.seed(driveCapabilityPath, {
    capabilityId: "context.document.read",
    serviceId: "drive",
    status: "active",
  });
  memory.seed(calendarResourcePath, {
    capabilityId: "context.calendar.read",
    status: "enabled",
  });
  memory.seed(driveResourcePath, {
    capabilityId: "context.document.read",
    status: "enabled",
  });
  memory.seed(calendarContextPath, {
    source: {
      connectionId: "google-a",
      capabilityId: "context.calendar.read",
    },
  });
  memory.seed(driveContextPath, {
    source: {
      connectionId: "google-a",
      capabilityId: "context.document.read",
    },
  });

  await setCapabilityStatus({
    companyId: "explorers",
    connectionId: "google-a",
    capabilityId: "context.calendar.read",
    enabled: false,
    actorUid: "admin-1",
  }, database);

  assert.equal(memory.read(connectionPath)?.status, "active");
  assert.equal(memory.read(calendarCapabilityPath)?.status, "disabled");
  assert.equal(memory.read(calendarResourcePath)?.status, "disabled");
  assert.equal(memory.read(calendarResourcePath)?.itemCount, 0);
  assert.equal(memory.read(calendarResourcePath)?.requiresFullSync, true);
  assert.equal(memory.read(calendarContextPath), undefined);
  assert.equal(memory.read(driveCapabilityPath)?.status, "active");
  assert.equal(memory.read(driveResourcePath)?.status, "enabled");
  assert.ok(memory.read(driveContextPath));

  await setCapabilityStatus({
    companyId: "explorers",
    connectionId: "google-a",
    capabilityId: "context.calendar.read",
    enabled: true,
    actorUid: "admin-1",
  }, database);

  assert.equal(memory.read(calendarCapabilityPath)?.status, "active");
  assert.equal(memory.read(calendarResourcePath)?.status, "disabled");
  assert.equal(memory.read(calendarContextPath), undefined);
  await assert.rejects(
    setConnectionStatus(
      "explorers",
      "google-a",
      "disconnected",
      "admin-1",
      database,
    ),
    /managed through authorization and revocation/,
  );
});

test("Google reset dry-runs and deletes only Google connector state", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  memory.seed("companies/explorers/connections/odorik-a", {
    connectorId: "odorik",
    credentialCiphertext: "odorik-secret",
  });
  memory.seed("companies/explorers/connections/odorik-a/resources/phone-a", {
    capabilityId: "context.call.read",
  });
  memory.seed("companies/explorers/connections/calendar-old", {
    adapterId: "google_calendar",
    credentialCiphertext: "old-google-secret",
  });
  memory.seed("companies/explorers/connections/calendar-old/resources/calendar-a", {
    resourceType: "calendar",
  });
  memory.seed("companies/explorers/connections/google-new", {
    connectorId: "google_workspace",
    credentialCiphertext: "new-google-secret",
  });
  memory.seed("companies/explorers/connections/google-new/capabilities/drive", {
    capabilityId: "context.document.read",
  });
  memory.seed("companies/explorers/connections/google-new/resources/folder-a", {
    capabilityId: "context.document.read",
  });
  memory.seed("companies/explorers/contextItems/calendar-item", {
    source: { adapterId: "google_calendar", connectionId: "calendar-old" },
  });
  memory.seed("companies/explorers/contextItems/drive-item", {
    source: { providerId: "google", connectionId: "google-new" },
  });
  memory.seed("companies/explorers/contextItems/call-item", {
    source: { providerId: "odorik", connectionId: "odorik-a" },
  });
  memory.seed("companies/explorers/cases/case-a", { title: "Preserve me" });
  memory.seed("oauthStates/google-state", {
    companyId: "explorers",
    provider: "google_workspace",
  });
  memory.seed("oauthStates/other-company", {
    companyId: "other",
    provider: "google_workspace",
  });

  assert.deepEqual(await resetGoogleConnectorData({
    companyId: "explorers",
    actorUid: "admin-1",
    apply: false,
  }, database), {
    applied: false,
    companyId: "explorers",
    connections: 2,
    capabilities: 1,
    resources: 2,
    contextItems: 2,
    oauthStates: 1,
  });
  assert.ok(memory.read("companies/explorers/connections/google-new"));

  const applied = await resetGoogleConnectorData({
    companyId: "explorers",
    actorUid: "admin-1",
    apply: true,
  }, database);
  assert.equal(applied.applied, true);
  assert.equal(memory.read("companies/explorers/connections/calendar-old"), undefined);
  assert.equal(memory.read("companies/explorers/connections/google-new"), undefined);
  assert.equal(memory.read("companies/explorers/contextItems/calendar-item"), undefined);
  assert.equal(memory.read("companies/explorers/contextItems/drive-item"), undefined);
  assert.equal(memory.read("oauthStates/google-state"), undefined);
  assert.ok(memory.read("companies/explorers/connections/odorik-a"));
  assert.ok(memory.read("companies/explorers/connections/odorik-a/resources/phone-a"));
  assert.ok(memory.read("companies/explorers/contextItems/call-item"));
  assert.ok(memory.read("companies/explorers/cases/case-a"));
  assert.ok(memory.read("oauthStates/other-company"));
  assert.equal(memory.list("companies/explorers/auditEvents").length, 1);
});
