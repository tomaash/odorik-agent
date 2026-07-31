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
  markCapabilityAttention,
  markCapabilitySynced,
  writeResourceSyncState,
} from "./sync-state.js";

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

function contextItems(companyId: string) {
  return db.collection(companyCollectionPath(companyId, "contextItems"));
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

async function syncCalendarResource(input: {
  companyId: string;
  connectionId: string;
  resource: FirebaseFirestore.QueryDocumentSnapshot;
  accessToken: string;
  forceFullSync?: boolean;
}): Promise<number> {
  const data = input.resource.data();
  const calendarId = String(data.externalId);
  const calendarName = String(data.displayName || calendarId);
  let pageToken = "";
  let nextSyncToken = "";
  let synced = 0;
  const storedSyncToken = !input.forceFullSync && typeof data.syncToken === "string"
    ? data.syncToken
    : "";
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
        await input.resource.ref.set({
          syncToken: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return syncCalendarResource({ ...input, forceFullSync: true });
      }
      throw error;
    }

    const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
    for (const event of page.items || []) {
      if (!event.id) continue;
      const itemRef = db.doc(companyDocumentPath(
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
      if (contextItem) writes.push((batch) => batch.set(itemRef, contextItem, { merge: false }));
      else writes.push((batch) => batch.delete(itemRef));
      synced += 1;
    }
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch();
      for (const write of writes.slice(offset, offset + 400)) write(batch);
      await batch.commit();
    }
    pageToken = page.nextPageToken || "";
    nextSyncToken = page.nextSyncToken || nextSyncToken;
  } while (pageToken);

  const itemCount = (await contextItems(input.companyId)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count()
    .get()).data().count;
  await writeResourceSyncState({
    resource: input.resource.ref,
    itemCount,
    extra: { syncToken: nextSyncToken || data.syncToken || null },
  });
  return synced;
}

export async function syncGoogleCalendarConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ calendars: number; changes: number }> {
  const { accessToken, connection, capability } = await authorizedConnection(input);
  const resources = await connection.ref.collection("resources")
    .where("capabilityId", "==", calendarCapabilityId)
    .where("status", "==", "enabled")
    .get();
  let changes = 0;
  try {
    for (const resource of resources.docs) {
      changes += await syncCalendarResource({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resource,
        accessToken,
      });
    }
    const itemCount = (await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.capabilityId", "==", calendarCapabilityId)
      .count()
      .get()).data().count;
    const updated = await markCapabilitySynced({
      connection: connection.ref,
      capability: capability.ref,
      itemCount,
    });
    if (!updated) {
      throw new Error("Google Calendar connection was disconnected during synchronization");
    }
    return { calendars: resources.size, changes };
  } catch (error) {
    await markCapabilityAttention({
      connection: connection.ref,
      capability: capability.ref,
      error,
    });
    throw error;
  }
}

export async function selectGoogleCalendars(input: {
  companyId: string;
  connectionId: string;
  calendarIds: string[];
  actorUid: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ selected: number; calendars: number; changes: number }> {
  const calendars = await listGoogleCalendars(input);
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const selectedIds = [...new Set(input.calendarIds)];
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new Error("One or more selected calendars are no longer accessible");
  }
  const connection = connectionRef(input.companyId, input.connectionId);
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", calendarCapabilityId)
    .get();
  const batch = db.batch();
  const now = Timestamp.now();
  for (const calendar of calendars) {
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
      status: selectedIds.includes(calendar.id) ? "enabled" : "disabled",
      updatedBy: input.actorUid,
      ...(!resources.docs.some((resource) => resource.id === resourceRef.id)
        ? { createdAt: now }
        : {}),
      updatedAt: now,
    }, { merge: true });
  }
  await batch.commit();

  const disabledResources = calendars
    .filter((calendar) => !selectedIds.includes(calendar.id))
    .map((calendar) => calendarResourceId(calendar.id));
  for (const resourceId of disabledResources) {
    const items = await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resourceId)
      .get();
    for (let offset = 0; offset < items.docs.length; offset += 400) {
      const deleteBatch = db.batch();
      for (const item of items.docs.slice(offset, offset + 400)) deleteBatch.delete(item.ref);
      await deleteBatch.commit();
    }
  }
  const result = await syncGoogleCalendarConnection(input);
  return { selected: selectedIds.length, ...result };
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
        await syncGoogleCalendarConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
        });
        results.push({ companyId: company.id, connectionId: connection.id, ok: true });
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
