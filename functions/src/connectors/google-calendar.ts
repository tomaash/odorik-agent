import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  audienceEquals,
  companyAudience,
  normalizeResourceAudience,
} from "../access.js";
import {
  authorizedGoogleCapability,
  GoogleApiError,
  connectionRef,
  googleGet,
} from "./google-oauth.js";
import { calendarScopes } from "./registry.js";
import {
  commitConnectorSyncWrites,
  connectorSyncRunResultFromData,
  createConnectorSyncRun,
  executeConnectorSyncRun,
  listDueConnectorSyncRuns,
  replayableConnectorSyncResources,
  type ConnectorSyncDependencies,
  type ConnectorSyncExecutionResource,
  type ConnectorSyncResourceCompletion,
  type ConnectorSyncRunResult,
  type ConnectorSyncTrigger,
} from "./sync-runtime.js";

export { calendarScopes };
const calendarCapabilityId = "context.calendar.read" as const;
const calendarDisplayName = "Google Calendar";

type CalendarListEntry = {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  deleted?: boolean;
};

type CalendarListResponse = {
  items?: CalendarListEntry[];
  nextPageToken?: string;
};

export type CalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  visibility?: string;
  created?: string;
  updated?: string;
  sequence?: number;
  eventType?: string;
  recurringEventId?: string;
  recurrence?: string[];
  iCalUID?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  };
};

type EventsResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type SelectableCalendar = {
  id: string;
  displayName: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
  selected: boolean;
};

export function calendarResourceId(calendarId: string): string {
  return `calendar_${sha256Hex(calendarId).slice(0, 24)}`;
}

export function calendarContextItemId(
  connectionId: string,
  calendarId: string,
  eventId: string,
): string {
  return `calendar_${sha256Hex(`${connectionId}:${calendarId}:${eventId}`).slice(0, 32)}`;
}

function contextItems(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.collection(companyCollectionPath(companyId, "contextItems"));
}

async function allCalendarEntries(accessToken: string): Promise<CalendarListEntry[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleGet<CalendarListResponse>(
      calendarDisplayName,
      url,
      accessToken,
    );
    entries.push(...(page.items || []).filter((item) => !item.deleted && item.id));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return entries;
}

async function authorizedConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}) {
  return authorizedGoogleCapability(calendarCapabilityId, input);
}

export async function listGoogleCalendars(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<SelectableCalendar[]> {
  const { accessToken, connection } = await authorizedConnection(input);
  const [entries, resources] = await Promise.all([
    allCalendarEntries(accessToken),
    connection.ref.collection("resources")
      .where("capabilityId", "==", calendarCapabilityId)
      .get(),
  ]);
  const selectedIds = new Set(
    resources.docs
      .filter((resource) => resource.data().status === "enabled")
      .map((resource) => String(resource.data().externalId)),
  );
  return entries.map((entry) => ({
    id: String(entry.id),
    displayName: entry.summaryOverride || entry.summary || String(entry.id),
    description: entry.description || null,
    primary: entry.primary === true,
    accessRole: entry.accessRole || "reader",
    timeZone: entry.timeZone || null,
    selected: selectedIds.has(String(entry.id)),
  })).sort((a, b) => Number(b.primary) - Number(a.primary)
    || a.displayName.localeCompare(b.displayName));
}

export function calendarEventContextItem(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  calendarId: string;
  calendarName: string;
  event: CalendarEvent;
  observedAt?: Timestamp;
  audience?: unknown;
  audienceRevision?: number;
  observation?: {
    runId: string;
    trigger: ConnectorSyncTrigger;
    providerUpdatedAt: string | null;
    providerVersion: string;
    freshnessEligible: boolean;
  };
}): Record<string, unknown> | null {
  if (!input.event.id || input.event.status === "cancelled") return null;
  const start = input.event.start?.dateTime || input.event.start?.date || null;
  const end = input.event.end?.dateTime || input.event.end?.date || null;
  const attendees = (input.event.attendees || []).map((attendee) => ({
    email: attendee.email || null,
    displayName: attendee.displayName || null,
    responseStatus: attendee.responseStatus || null,
    self: attendee.self === true,
  }));
  const participantRefs = [
    input.event.organizer?.email,
    input.event.creator?.email,
    ...attendees.map((attendee) => attendee.email || undefined),
  ].filter((value): value is string => Boolean(value));
  const conferenceLinks = (input.event.conferenceData?.entryPoints || [])
    .map((entry) => entry.uri)
    .filter((value): value is string => Boolean(value));
  const title = input.event.summary || "Untitled calendar event";
  const body = [
    `Calendar: ${input.calendarName}`,
    `Starts: ${start || "unknown"}`,
    `Ends: ${end || "unknown"}`,
    input.event.location && `Location: ${input.event.location}`,
    input.event.description && `Description:\n${input.event.description}`,
    participantRefs.length && `Participants: ${participantRefs.join(", ")}`,
  ].filter(Boolean).join("\n");
  const checksum = sha256Hex(JSON.stringify(input.event));
  return {
    companyId: input.companyId,
    kind: "calendar.event",
    source: {
      providerId: "google",
      capabilityId: calendarCapabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: input.event.id,
      version: input.event.updated || checksum.slice(0, 16),
    },
    title,
    text: body,
    occurredAt: start,
    observedAt: input.observedAt || Timestamp.now(),
    artifactRefs: [],
    participantRefs,
    access: normalizeResourceAudience(input.audience),
    accessRevision: Math.max(1, Number(input.audienceRevision || 1)),
    metadata: {
      calendarId: input.calendarId,
      calendarName: input.calendarName,
      start,
      end,
      allDay: Boolean(input.event.start?.date && !input.event.start?.dateTime),
      location: input.event.location || null,
      attendees,
      organizer: input.event.organizer || null,
      status: input.event.status || "confirmed",
      eventType: input.event.eventType || "default",
      sequence: Number(input.event.sequence || 0),
      recurringEventId: input.event.recurringEventId || null,
      recurrence: input.event.recurrence || [],
      originalStartTime: input.event.originalStartTime || null,
      iCalUID: input.event.iCalUID || null,
      sourceUrl: input.event.htmlLink || null,
      conferenceLinks,
      visibility: input.event.visibility || "default",
    },
    provenance: {
      rawRef: `google-calendar/${input.calendarId}/events/${input.event.id}`,
      checksum,
      ingestionVersion: "google-calendar-v2",
    },
    observation: input.observation ? {
      ...input.observation,
      observedAt: input.observedAt || Timestamp.now(),
    } : null,
    indexingEnabled: true,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function calendarEventsUrl(input: {
  calendarId: string;
  syncToken?: string;
  pageToken?: string;
  timeMin: string;
}): URL {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
  );
  url.searchParams.set("maxResults", "2500");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("singleEvents", "true");
  if (input.syncToken) {
    url.searchParams.set("syncToken", input.syncToken);
  } else {
    url.searchParams.set("timeMin", input.timeMin);
  }
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

export function calendarSyncTokenForRun(
  resource: Record<string, unknown>,
  forceFullSync = false,
): string {
  if (forceFullSync || resource.requiresFullSync === true) return "";
  return typeof resource.syncToken === "string" ? resource.syncToken : "";
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function calendarContextMatches(
  existing: FirebaseFirestore.DocumentData | undefined,
  next: Record<string, unknown>,
): boolean {
  const existingSource = nestedRecord(existing?.source);
  const nextSource = nestedRecord(next.source);
  const existingProvenance = nestedRecord(existing?.provenance);
  const nextProvenance = nestedRecord(next.provenance);
  return existingSource.version === nextSource.version
    && existingSource.resourceId === nextSource.resourceId
    && existingProvenance.checksum === nextProvenance.checksum
    && existing?.title === next.title
    && existing?.text === next.text
    && audienceEquals(existing?.access, next.access)
    && Number(existing?.accessRevision || 1) === Number(next.accessRevision || 1)
    && existing?.indexingEnabled !== false;
}

async function syncCalendarResource(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: import("./sync-runtime.js").ConnectorSyncLease;
  dependencies: ConnectorSyncDependencies;
  forceFullSync?: boolean;
  trigger: ConnectorSyncTrigger;
}): Promise<ConnectorSyncResourceCompletion> {
  const data = input.resource.data;
  const calendarId = String(data.externalId);
  const calendarName = String(data.displayName || calendarId);
  let pageToken = "";
  let nextSyncToken = "";
  let changes = 0;
  const storedSyncToken = calendarSyncTokenForRun(data, input.forceFullSync);
  const isFullSync = !storedSyncToken;
  const now = input.dependencies.now?.() || Timestamp.now();
  const existing = await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .get();
  const existingById = new Map(existing.docs.map((item) => [item.id, item]));
  const observedContextIds = new Set<string>();
  do {
    const url = calendarEventsUrl({
      calendarId,
      syncToken: storedSyncToken,
      pageToken,
      timeMin: new Date(
        now.toMillis()
          - 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    let page: EventsResponse;
    try {
      page = await googleGet<EventsResponse>(
        calendarDisplayName,
        url,
        input.accessToken,
      );
    } catch (error) {
      if (storedSyncToken && error instanceof GoogleApiError && error.status === 410) {
        return syncCalendarResource({ ...input, forceFullSync: true });
      }
      throw error;
    }

    const writes: Array<{
      ref: FirebaseFirestore.DocumentReference;
      value: Record<string, unknown> | null;
    }> = [];
    for (const event of page.items || []) {
      if (!event.id) continue;
      const itemRef = input.dependencies.database.doc(companyDocumentPath(
        input.companyId,
        "contextItems",
        calendarContextItemId(input.connectionId, calendarId, event.id),
      ));
      observedContextIds.add(itemRef.id);
      const contextItem = calendarEventContextItem({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        calendarId,
        calendarName,
        event,
        observedAt: now,
        audience: input.resource.data.audience,
        audienceRevision: Number(input.resource.data.audienceRevision || 1),
        observation: {
          runId: input.lease.runId,
          trigger: input.trigger,
          providerUpdatedAt: event.updated || null,
          providerVersion: event.updated || sha256Hex(JSON.stringify(event)).slice(0, 16),
          freshnessEligible: (() => {
            const providerUpdatedAt = timestampMillis(event.updated);
            const lastSuccessAt = timestampMillis(
              nestedRecord(input.resource.data.sync).lastSuccessAt
                || input.resource.data.lastSyncAt,
            );
            return providerUpdatedAt !== null
              && lastSuccessAt !== null
              && providerUpdatedAt >= lastSuccessAt;
          })(),
        },
      });
      if (contextItem) {
        if (calendarContextMatches(existingById.get(itemRef.id)?.data(), contextItem)) continue;
        writes.push({ ref: itemRef, value: contextItem });
        changes += 1;
      } else if (existingById.has(itemRef.id)) {
        writes.push({ ref: itemRef, value: null });
        changes += 1;
      }
    }
    for (let offset = 0; offset < writes.length; offset += 400) {
      const pageWrites = writes.slice(offset, offset + 400);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => {
          for (const write of pageWrites) {
            if (write.value) transaction.set(write.ref, write.value, { merge: false });
            else transaction.delete(write.ref);
          }
        },
      }, input.dependencies);
    }
    pageToken = page.nextPageToken || "";
    nextSyncToken = page.nextSyncToken || nextSyncToken;
  } while (pageToken);

  if (isFullSync) {
    const staleItems = existing.docs.filter((item) => !observedContextIds.has(item.id));
    for (let offset = 0; offset < staleItems.length; offset += 400) {
      const pageDeletes = staleItems.slice(offset, offset + 400);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => {
          for (const item of pageDeletes) transaction.delete(item.ref);
        },
      }, input.dependencies);
    }
    changes += staleItems.length;
  }

  const itemCount = (await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count()
    .get()).data().count;
  const finalSyncToken = nextSyncToken || (storedSyncToken ? String(data.syncToken || "") : "");
  return {
    changes,
    itemCount,
    cursorAfter: finalSyncToken || null,
    cursorMode: storedSyncToken ? "incremental" : "full",
    resourcePatch: {
      // Never restore the obsolete cursor after a forced rebuild. Google
      // normally returns nextSyncToken on the last full-sync page; null keeps
      // the following run full if it does not.
      syncToken: finalSyncToken || null,
    },
  };
}

type CalendarSyncInput = {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  trigger?: ConnectorSyncTrigger;
  requestedBy?: string | null;
  resourceIds?: string[];
  replayOfRunId?: string | null;
  database?: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
};

export type CalendarSyncResult = ConnectorSyncRunResult & {
  calendars: number;
};

function calendarRunResult(
  runId: string,
  data: FirebaseFirestore.DocumentData,
): CalendarSyncResult {
  const result = connectorSyncRunResultFromData(runId, data);
  return { ...result, calendars: result.resources };
}

async function executeGoogleCalendarSyncRun(
  input: CalendarSyncInput & { runId: string },
): Promise<CalendarSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const completed = await executeConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: calendarCapabilityId,
    serviceId: "calendar",
    prepare: () => authorizedConnection(input),
    listResources: async ({ connection }) => {
      const snapshot = await connection.ref.collection("resources")
        .where("capabilityId", "==", calendarCapabilityId)
        .where("status", "==", "enabled")
        .get();
      return snapshot.docs.map((resource) => ({ id: resource.id, data: resource.data() }));
    },
    cursorBefore: (resource) => calendarSyncTokenForRun(resource.data) || null,
    cursorMode: (resource) => calendarSyncTokenForRun(resource.data) ? "incremental" : "full",
    synchronizeResource: ({
      preparation,
      resource,
      trigger,
      lease,
      dependencies: runDependencies,
    }) => (
      syncCalendarResource({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resource,
        accessToken: preparation.accessToken,
        lease,
        trigger,
        dependencies: runDependencies,
      })
    ),
  }, dependencies);
  return { ...completed, calendars: completed.resources };
}

export async function syncGoogleCalendarConnection(
  input: CalendarSyncInput,
): Promise<CalendarSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const connection = database.doc(
    companyDocumentPath(input.companyId, "connections", input.connectionId),
  );
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", calendarCapabilityId)
    .where("status", "==", "enabled")
    .get();
  const selectedResourceIds = input.resourceIds?.filter(
    (resourceId) => resources.docs.some((resource) => resource.id === resourceId),
  ) || resources.docs.map((resource) => resource.id);
  const created = await createConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId: calendarCapabilityId,
    serviceId: "calendar",
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy,
    resourceIds: selectedResourceIds,
    replayOfRunId: input.replayOfRunId,
  }, dependencies);
  if (!created.created || created.deferred) {
    const current = await connection.collection("syncRuns").doc(created.runId).get();
    return calendarRunResult(created.runId, current.data() || {});
  }
  return executeGoogleCalendarSyncRun({ ...input, runId: created.runId });
}

export async function selectGoogleCalendars(input: {
  companyId: string;
  connectionId: string;
  calendarIds: string[];
  actorUid: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ selected: number } & CalendarSyncResult> {
  const calendars = await listGoogleCalendars(input);
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const selectedIds = [...new Set(input.calendarIds)];
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new Error("One or more selected calendars are no longer accessible");
  }
  const selectedSet = new Set(selectedIds);
  const connection = connectionRef(input.companyId, input.connectionId);
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", calendarCapabilityId)
    .get();
  const batch = db.batch();
  const now = Timestamp.now();
  for (const calendarId of selectedIds) {
    const calendar = byId.get(calendarId)!;
    const resourceRef = connection.collection("resources").doc(
      calendarResourceId(calendar.id),
    );
    batch.set(resourceRef, {
      connectionId: input.connectionId,
      capabilityId: calendarCapabilityId,
      resourceType: "calendar",
      externalId: calendar.id,
      displayName: calendar.displayName,
      description: calendar.description,
      primary: calendar.primary,
      accessRole: calendar.accessRole,
      timeZone: calendar.timeZone,
      status: "enabled",
      ...(!resources.docs.some((resource) => resource.id === resourceRef.id)
        ? { audience: companyAudience, audienceRevision: 1 }
        : {}),
      updatedBy: input.actorUid,
      ...(!resources.docs.some((resource) => resource.id === resourceRef.id)
        ? { createdAt: now }
        : {}),
      updatedAt: now,
    }, { merge: true });
  }
  const removedResources = resources.docs.filter(
    (resource) => !selectedSet.has(String(resource.data().externalId)),
  );
  for (const resource of removedResources) batch.delete(resource.ref);
  await batch.commit();

  for (const resource of removedResources) {
    const items = await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id)
      .get();
    for (let offset = 0; offset < items.docs.length; offset += 400) {
      const deleteBatch = db.batch();
      for (const item of items.docs.slice(offset, offset + 400)) deleteBatch.delete(item.ref);
      await deleteBatch.commit();
    }
  }
  const result = await syncGoogleCalendarConnection({
    ...input,
    trigger: "selection",
    requestedBy: input.actorUid,
  });
  return { selected: selectedIds.length, ...result };
}

export async function replayGoogleCalendarSyncRun(input: {
  companyId: string;
  connectionId: string;
  runId: string;
  actorUid: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<CalendarSyncResult> {
  const failedResourceIds = await replayableConnectorSyncResources({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: calendarCapabilityId,
    serviceId: "calendar",
  }, { database: db });
  return syncGoogleCalendarConnection({
    ...input,
    trigger: "operator_replay",
    requestedBy: input.actorUid,
    replayOfRunId: input.runId,
    resourceIds: failedResourceIds,
  });
}

export async function retryDueGoogleCalendarSyncRuns(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  limit?: number;
  database?: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
}): Promise<Array<CalendarSyncResult & { companyId: string; connectionId: string }>> {
  const database = input.database || db;
  const dependencies = { database, now: input.now };
  const due = await listDueConnectorSyncRuns({ serviceId: "calendar", limit: input.limit }, dependencies);
  const results: Array<CalendarSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of due) {
    const result = await executeGoogleCalendarSyncRun({
      companyId: run.companyId,
      connectionId: run.connectionId,
      runId: run.runId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      credentialKey: input.credentialKey,
      trigger: "retry",
      database,
      now: input.now,
    });
    results.push({ companyId: run.companyId, connectionId: run.connectionId, ...result });
  }
  return results;
}

export async function syncAllGoogleCalendarConnections(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<Array<{ companyId: string; connectionId: string; ok: boolean; error?: string }>> {
  const companies = await db.collection("companies").get();
  const results: Array<{
    companyId: string;
    connectionId: string;
    ok: boolean;
    error?: string;
  }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "google_workspace")
      .where("status", "in", ["active", "attention"])
      .get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc("calendar").get();
      if (!capability.exists || capability.data()?.status !== "active") continue;
      try {
        const run = await syncGoogleCalendarConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
          trigger: "scheduled",
          requestedBy: "scheduler:calendar",
        });
        results.push({
          companyId: company.id,
          connectionId: connection.id,
          ok: run.status !== "attention",
          ...(run.status === "attention" ? { error: "Calendar synchronization needs attention" } : {}),
        });
      } catch (error) {
        results.push({
          companyId: company.id,
          connectionId: connection.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}
