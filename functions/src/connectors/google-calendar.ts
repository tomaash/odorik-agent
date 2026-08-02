import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedGoogleCapability,
  connectionRef,
  googleGet,
} from "./google-oauth.js";
import { calendarScopes } from "./registry.js";
import {
  acquireConnectorSyncLease,
  claimConnectorSyncRun,
  classifyConnectorSyncError,
  commitConnectorSyncWrites,
  completeConnectorSyncResource,
  completeConnectorSyncRun,
  connectorSyncRetryAt,
  createConnectorSyncRun,
  failConnectorSyncResource,
  sanitizeConnectorSyncError,
  type ConnectorSyncDependencies,
  type ConnectorSyncResourceResult,
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
  recurringEventId?: string;
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
    access: { visibility: "company" },
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
      recurringEventId: input.event.recurringEventId || null,
      iCalUID: input.event.iCalUID || null,
      sourceUrl: input.event.htmlLink || null,
      conferenceLinks,
      visibility: input.event.visibility || "default",
    },
    provenance: {
      rawRef: `google-calendar/${input.calendarId}/events/${input.event.id}`,
      checksum,
      ingestionVersion: "google-calendar-v1",
    },
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

async function syncCalendarResource(input: {
  companyId: string;
  connectionId: string;
  resource: FirebaseFirestore.QueryDocumentSnapshot;
  accessToken: string;
  lease: import("./sync-runtime.js").ConnectorSyncLease;
  attemptRef: FirebaseFirestore.DocumentReference;
  dependencies: ConnectorSyncDependencies;
  forceFullSync?: boolean;
}): Promise<{ changes: number; itemCount: number }> {
  const data = input.resource.data();
  const calendarId = String(data.externalId);
  const calendarName = String(data.displayName || calendarId);
  let pageToken = "";
  let nextSyncToken = "";
  let synced = 0;
  const storedSyncToken = calendarSyncTokenForRun(data, input.forceFullSync);
  do {
    const url = calendarEventsUrl({
      calendarId,
      syncToken: storedSyncToken,
      pageToken,
      timeMin: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });

    let page: EventsResponse;
    try {
      page = await googleGet<EventsResponse>(
        calendarDisplayName,
        url,
        input.accessToken,
      );
    } catch (error) {
      if (storedSyncToken && error instanceof Error && error.message.includes("(410)")) {
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
      const contextItem = calendarEventContextItem({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        calendarId,
        calendarName,
        event,
      });
      writes.push({ ref: itemRef, value: contextItem });
      synced += 1;
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

  const itemCount = (await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count()
    .get()).data().count;
  const finalSyncToken = nextSyncToken || (storedSyncToken ? String(data.syncToken || "") : "");
  await completeConnectorSyncResource({
    companyId: input.companyId,
    connectionId: input.connectionId,
    resourceId: input.resource.id,
    lease: input.lease,
    attemptRef: input.attemptRef,
    changes: synced,
    itemCount,
    cursorAfter: finalSyncToken || null,
    cursorMode: storedSyncToken ? "incremental" : "full",
    resourcePatch: {
      // Never restore the obsolete cursor after a forced rebuild. Google
      // normally returns nextSyncToken on the last full-sync page; null keeps
      // the following run full if it does not.
      syncToken: finalSyncToken || null,
    },
  }, input.dependencies);
  return { changes: synced, itemCount };
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
  return {
    runId,
    status: data.status || "queued",
    attempt: Number(data.attempt || 0),
    resources: Number(data.resources || data.resourceIds?.length || 0),
    calendars: Number(data.resources || data.resourceIds?.length || 0),
    succeeded: Number(data.succeeded || 0),
    failed: Number(data.failed || 0),
    changes: Number(data.changes || 0),
    nextAttemptAt: data.nextAttemptAt?.toDate?.().toISOString?.()
      || data.nextAttemptAt
      || null,
  };
}

async function executeGoogleCalendarSyncRun(
  input: CalendarSyncInput & { runId: string },
): Promise<CalendarSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const runRef = database.doc(
    `companies/${input.companyId}/connections/${input.connectionId}/syncRuns/${input.runId}`,
  );
  const claimed = await claimConnectorSyncRun(input, dependencies);
  if (!claimed.claimed) {
    const current = await runRef.get();
    return calendarRunResult(input.runId, current.data() || claimed.data);
  }
  const configuredResourceIds = (claimed.attempt > 1
    ? claimed.data.failedResourceIds
    : claimed.data.resourceIds) as unknown;
  const resourceIds = Array.isArray(configuredResourceIds)
    ? configuredResourceIds.map(String)
    : [];
  const results: ConnectorSyncResourceResult[] = [];
  let resources: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  try {
    const { accessToken, connection } = await authorizedConnection(input);
    const resourcesSnapshot = await connection.ref.collection("resources")
      .where("capabilityId", "==", calendarCapabilityId)
      .where("status", "==", "enabled")
      .get();
    resources = resourcesSnapshot.docs.filter(
      (resource) => resourceIds.length === 0 || resourceIds.includes(resource.id),
    );
    for (const resource of resources) {
      const claim = await acquireConnectorSyncLease({
        companyId: input.companyId,
        connectionId: input.connectionId,
        capabilityId: calendarCapabilityId,
        serviceId: "calendar",
        resourceId: resource.id,
        runId: input.runId,
        attempt: claimed.attempt,
        cursorBefore: calendarSyncTokenForRun(resource.data()) || null,
        cursorMode: calendarSyncTokenForRun(resource.data()) ? "incremental" : "full",
      }, dependencies);
      if (!claim.acquired || !claim.lease) {
        results.push({
          resourceId: resource.id,
          status: claim.reason === "busy" ? "retry_scheduled" : "skipped",
          changes: 0,
          ...(claim.reason === "busy" ? {
            failureKind: "transient" as const,
            error: "Another synchronization attempt still owns this resource",
          } : {}),
        });
        continue;
      }
      try {
        const result = await syncCalendarResource({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resource,
          accessToken,
          lease: claim.lease,
          attemptRef: claim.attemptRef,
          dependencies,
        });
        results.push({
          resourceId: resource.id,
          status: "succeeded",
          ...result,
        });
      } catch (error) {
        const failureKind = classifyConnectorSyncError(error);
        const retryAt = failureKind === "transient"
          ? connectorSyncRetryAt(claimed.attempt, input.now?.() || Timestamp.now())
          : null;
        await failConnectorSyncResource({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: resource.id,
          lease: claim.lease,
          attemptRef: claim.attemptRef,
          error,
          failureKind,
          retryAt,
        }, dependencies);
        results.push({
          resourceId: resource.id,
          status: retryAt ? "retry_scheduled" : "attention",
          changes: 0,
          failureKind,
          error: sanitizeConnectorSyncError(error),
        });
      }
    }
    const completed = await completeConnectorSyncRun({
      companyId: input.companyId,
      connectionId: input.connectionId,
      runId: input.runId,
      attempt: claimed.attempt,
      results,
    }, dependencies);
    return { ...completed, calendars: resources.length };
  } catch (error) {
    const failureKind = classifyConnectorSyncError(error);
    const completed = await completeConnectorSyncRun({
      companyId: input.companyId,
      connectionId: input.connectionId,
      runId: input.runId,
      attempt: claimed.attempt,
      results,
      preparationError: error,
      preparationFailureKind: failureKind,
    }, dependencies);
    return { ...completed, calendars: resources.length };
  }
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
  if (!created.created) {
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
  const prior = await db.doc(
    `companies/${input.companyId}/connections/${input.connectionId}/syncRuns/${input.runId}`,
  ).get();
  if (
    !prior.exists
    || prior.data()?.companyId !== input.companyId
    || prior.data()?.connectionId !== input.connectionId
    || prior.data()?.capabilityId !== calendarCapabilityId
    || prior.data()?.status !== "attention"
  ) throw new Error("Only an attention-required Calendar sync run can be replayed");
  const failedResourceIds = Array.isArray(prior.data()?.failedResourceIds)
    ? prior.data()!.failedResourceIds.map(String)
    : [];
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
}): Promise<Array<CalendarSyncResult & { companyId: string; connectionId: string }>> {
  const now = Timestamp.now();
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const [queued, scheduled, abandoned] = await Promise.all([
    db.collectionGroup("syncRuns")
      .where("serviceId", "==", "calendar")
      .where("status", "==", "queued")
      .where("queuedAt", "<=", Timestamp.fromMillis(now.toMillis() - 60_000))
      .limit(limit)
      .get(),
    db.collectionGroup("syncRuns")
      .where("serviceId", "==", "calendar")
      .where("status", "==", "retry_scheduled")
      .where("nextAttemptAt", "<=", now)
      .limit(limit)
      .get(),
    db.collectionGroup("syncRuns")
      .where("serviceId", "==", "calendar")
      .where("status", "==", "running")
      .where("executionLeaseExpiresAt", "<=", now)
      .limit(limit)
      .get(),
  ]);
  const due = new Map(
    [...queued.docs, ...scheduled.docs, ...abandoned.docs].map((run) => [run.ref.path, run]),
  );
  const results: Array<CalendarSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of [...due.values()].slice(0, limit)) {
    const data = run.data();
    const companyId = String(data.companyId || "");
    const connectionId = String(data.connectionId || "");
    if (!companyId || !connectionId) continue;
    const result = await executeGoogleCalendarSyncRun({
      companyId,
      connectionId,
      runId: run.id,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      credentialKey: input.credentialKey,
      trigger: "retry",
    });
    results.push({ companyId, connectionId, ...result });
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
