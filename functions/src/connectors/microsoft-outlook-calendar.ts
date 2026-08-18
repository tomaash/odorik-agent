import { Timestamp } from "firebase-admin/firestore";

import { audienceEquals, normalizeResourceAudience } from "../access.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedMicrosoftCapability,
  MicrosoftAuthorizationError,
} from "./microsoft-oauth.js";
import {
  commitConnectorSyncWrites,
  connectorSyncRunResultFromData,
  createConnectorSyncRun,
  executeConnectorSyncRun,
  listDueConnectorSyncRuns,
  replayableConnectorSyncResources,
  type ConnectorSyncDependencies,
  type ConnectorSyncExecutionResource,
  type ConnectorSyncLease,
  type ConnectorSyncResourceCompletion,
  type ConnectorSyncRunResult,
  type ConnectorSyncTrigger,
} from "./sync-runtime.js";

const capabilityId = "context.calendar.read" as const;
const serviceId = "calendar" as const;
export const outlookCalendarPastDays = 365;
export const outlookCalendarFutureDays = 730;
export const outlookCalendarRebaseDays = 30;

type GraphCalendar = {
  id?: string;
  name?: string;
  color?: string;
  hexColor?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  canShare?: boolean;
  canViewPrivateItems?: boolean;
  owner?: { name?: string; address?: string };
};

type GraphCalendarList = {
  value?: GraphCalendar[];
  "@odata.nextLink"?: string;
  error?: { code?: string; message?: string };
};

type GraphDateTime = { dateTime?: string; timeZone?: string };
type GraphRecipient = { emailAddress?: { name?: string; address?: string } };

export type OutlookCalendarEvent = {
  id?: string;
  changeKey?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  type?: string;
  sensitivity?: string;
  showAs?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  responseRequested?: boolean;
  start?: GraphDateTime;
  end?: GraphDateTime;
  originalStart?: string;
  originalStartTimeZone?: string;
  originalEndTimeZone?: string;
  location?: { displayName?: string; locationType?: string; uniqueId?: string; address?: unknown };
  locations?: Array<{ displayName?: string; locationType?: string; uniqueId?: string; address?: unknown }>;
  organizer?: GraphRecipient;
  attendees?: Array<GraphRecipient & {
    type?: string;
    status?: { response?: string; time?: string };
  }>;
  recurrence?: unknown;
  seriesMasterId?: string;
  iCalUId?: string;
  transactionId?: string;
  categories?: string[];
  webLink?: string;
  onlineMeetingUrl?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string; conferenceId?: string; phones?: unknown[] };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  hideAttendees?: boolean;
  "@removed"?: { reason?: string };
};

type GraphEventDelta = {
  value?: OutlookCalendarEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  error?: { code?: string; message?: string };
};

export type SelectableOutlookCalendar = {
  id: string;
  displayName: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
  selected: boolean;
  canViewPrivateItems: boolean;
};

export class MicrosoftGraphCalendarError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Microsoft Graph calendar failed (${status}, ${code}): ${message}`);
    this.name = "MicrosoftGraphCalendarError";
  }
}

export function outlookCalendarResourceId(calendarId: string): string {
  return `outlook_calendar_${sha256Hex(calendarId).slice(0, 24)}`;
}

export function outlookCalendarContextItemId(
  connectionId: string,
  calendarId: string,
  eventId: string,
): string {
  return `calendar_${sha256Hex(`${connectionId}:${calendarId}:${eventId}`).slice(0, 32)}`;
}

function contextItems(companyId: string, database: FirebaseFirestore.Firestore = db) {
  return database.collection(companyCollectionPath(companyId, "contextItems"));
}

async function graphGet<T extends { error?: { code?: string; message?: string } }>(input: {
  url: string;
  accessToken: string;
  request: typeof fetch;
}): Promise<T> {
  const response = await input.request(input.url, {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      prefer: 'IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=100',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as T;
  if (!response.ok) throw new MicrosoftGraphCalendarError(
    response.status,
    String(body.error?.code || "GRAPH_ERROR"),
    String(body.error?.message || "calendar request failed"),
  );
  return body;
}

async function authorized(input: CalendarSyncInput) {
  return authorizedMicrosoftCapability(capabilityId, {
    companyId: input.companyId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    credentialKey: input.credentialKey,
    dependencies: { database: input.database || db, fetch: input.fetch || fetch },
  });
}

async function allCalendars(accessToken: string, request: typeof fetch): Promise<GraphCalendar[]> {
  let url = "https://graph.microsoft.com/v1.0/me/calendars"
    + "?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,canShare,canViewPrivateItems,owner";
  const calendars: GraphCalendar[] = [];
  do {
    const page = await graphGet<GraphCalendarList>({ url, accessToken, request });
    calendars.push(...(page.value || []).filter((calendar) => Boolean(calendar.id)));
    url = page["@odata.nextLink"] || "";
  } while (url);
  return calendars;
}

export async function listMicrosoftOutlookCalendars(input: CalendarSyncInput): Promise<SelectableOutlookCalendar[]> {
  const database = input.database || db;
  const request = input.fetch || fetch;
  const [authorization, connection] = await Promise.all([
    authorized(input),
    database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId)).get(),
  ]);
  const [calendars, resources] = await Promise.all([
    allCalendars(authorization.accessToken, request),
    connection.ref.collection("resources").where("capabilityId", "==", capabilityId).get(),
  ]);
  const selected = new Set(resources.docs
    .filter((resource) => resource.data().status === "enabled")
    .map((resource) => String(resource.data().externalId)));
  return calendars.map((calendar) => ({
    id: String(calendar.id),
    displayName: String(calendar.name || calendar.id),
    description: calendar.owner?.address ? `Owner: ${calendar.owner.address}` : null,
    primary: calendar.isDefaultCalendar === true,
    accessRole: calendar.canEdit ? "editor" : "reader",
    timeZone: null,
    selected: selected.has(String(calendar.id)),
    canViewPrivateItems: calendar.canViewPrivateItems === true,
  })).sort((left, right) => Number(right.primary) - Number(left.primary)
    || left.displayName.localeCompare(right.displayName));
}

function address(recipient?: GraphRecipient): string {
  return String(recipient?.emailAddress?.address || "").trim().toLocaleLowerCase();
}

function plainText(body?: OutlookCalendarEvent["body"]): string {
  const content = String(body?.content || "");
  if (String(body?.contentType || "").toLocaleLowerCase() !== "html") return content.trim();
  return content
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function outlookCalendarEventContextItem(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  calendarId: string;
  calendarName: string;
  event: OutlookCalendarEvent;
  audience?: unknown;
  audienceRevision?: number;
  observedAt?: Timestamp;
  observation?: {
    runId: string;
    trigger: ConnectorSyncTrigger;
    providerUpdatedAt: string | null;
    providerVersion: string;
    freshnessEligible: boolean;
  };
}): Record<string, unknown> | null {
  const eventId = String(input.event.id || "");
  if (!eventId || input.event["@removed"]) return null;
  const sensitivity = String(input.event.sensitivity || "normal").toLocaleLowerCase();
  const restrictedDetails = sensitivity === "private" || sensitivity === "confidential";
  const organizer = address(input.event.organizer);
  const attendees = (input.event.attendees || []).map((attendee) => ({
    email: address(attendee) || null,
    displayName: attendee.emailAddress?.name || null,
    type: attendee.type || null,
    responseStatus: attendee.status?.response || null,
    responseTime: attendee.status?.time || null,
  }));
  const participantRefs = [...new Set([
    organizer,
    ...attendees.map((attendee) => attendee.email || ""),
  ].filter(Boolean))];
  const start = input.event.start?.dateTime || null;
  const end = input.event.end?.dateTime || null;
  const location = input.event.location?.displayName || null;
  const description = plainText(input.event.body) || String(input.event.bodyPreview || "").trim();
  const title = restrictedDetails
    ? "Private calendar event"
    : String(input.event.subject || "Untitled calendar event");
  const status = input.event.isCancelled ? "cancelled" : "confirmed";
  const text = [
    `Calendar: ${input.calendarName}`,
    `Status: ${status}`,
    `Starts: ${start || "unknown"} (${input.event.start?.timeZone || "unknown time zone"})`,
    `Ends: ${end || "unknown"} (${input.event.end?.timeZone || "unknown time zone"})`,
    !restrictedDetails && location && `Location: ${location}`,
    !restrictedDetails && description && `Description:\n${description}`,
    !restrictedDetails && participantRefs.length && `Participants: ${participantRefs.join(", ")}`,
    restrictedDetails && "Details are hidden because the provider marks this event private.",
  ].filter(Boolean).join("\n");
  const checksum = sha256Hex(JSON.stringify(input.event));
  const conferenceLinks = [...new Set([
    input.event.onlineMeetingUrl,
    input.event.onlineMeeting?.joinUrl,
  ].filter((value): value is string => Boolean(value)))];
  return {
    companyId: input.companyId,
    kind: "calendar.event",
    source: {
      providerId: "microsoft",
      capabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: eventId,
      version: input.event.changeKey || input.event.lastModifiedDateTime || checksum.slice(0, 16),
    },
    title,
    text,
    occurredAt: start,
    observedAt: input.observedAt || Timestamp.now(),
    artifactRefs: [],
    participantRefs: restrictedDetails ? [] : participantRefs,
    access: normalizeResourceAudience(input.audience),
    accessRevision: Math.max(1, Number(input.audienceRevision || 1)),
    metadata: {
      calendarId: input.calendarId,
      calendarName: input.calendarName,
      start,
      end,
      startTimeZone: input.event.start?.timeZone || null,
      endTimeZone: input.event.end?.timeZone || null,
      originalStart: input.event.originalStart || null,
      originalStartTimeZone: input.event.originalStartTimeZone || null,
      originalEndTimeZone: input.event.originalEndTimeZone || null,
      allDay: input.event.isAllDay === true,
      location: restrictedDetails ? null : input.event.location || null,
      locations: restrictedDetails ? [] : input.event.locations || [],
      attendees: restrictedDetails ? [] : attendees,
      organizer: restrictedDetails ? null : input.event.organizer || null,
      status,
      responseRequested: input.event.responseRequested === true,
      isOrganizer: input.event.isOrganizer === true,
      eventType: input.event.type || "singleInstance",
      showAs: input.event.showAs || null,
      sensitivity,
      restrictedDetails,
      seriesMasterId: input.event.seriesMasterId || null,
      recurrence: input.event.recurrence || null,
      iCalUID: input.event.iCalUId || null,
      categories: input.event.categories || [],
      sourceUrl: input.event.webLink || null,
      conferenceLinks: restrictedDetails ? [] : conferenceLinks,
      onlineMeetingProvider: input.event.onlineMeetingProvider || null,
      hideAttendees: input.event.hideAttendees === true,
    },
    provenance: {
      rawRef: `microsoft-outlook/calendars/${input.calendarId}/events/${eventId}`,
      checksum,
      ingestionVersion: "microsoft-outlook-calendar-v1",
    },
    observation: input.observation ? { ...input.observation, observedAt: input.observedAt || Timestamp.now() } : null,
    indexingEnabled: true,
  };
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

function initialDeltaUrl(calendarId: string, now: Timestamp): { url: string; start: string; end: string } {
  const start = new Date(now.toMillis() - outlookCalendarPastDays * 86_400_000).toISOString();
  const end = new Date(now.toMillis() + outlookCalendarFutureDays * 86_400_000).toISOString();
  const url = new URL(
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`,
  );
  url.searchParams.set("startDateTime", start);
  url.searchParams.set("endDateTime", end);
  return { url: url.toString(), start, end };
}

function usableDeltaLink(resource: Record<string, unknown>, now: Timestamp, forceFull = false): string {
  if (forceFull || resource.requiresFullSync === true) return "";
  const anchor = timestampMillis(resource.windowAnchoredAt);
  if (!anchor || now.toMillis() - anchor >= outlookCalendarRebaseDays * 86_400_000) return "";
  return typeof resource.deltaLink === "string" ? resource.deltaLink : "";
}

function contextMatches(existing: FirebaseFirestore.DocumentData | undefined, next: Record<string, unknown>): boolean {
  const source = next.source as Record<string, unknown>;
  const provenance = next.provenance as Record<string, unknown>;
  return existing?.source?.version === source.version
    && existing?.provenance?.checksum === provenance.checksum
    && existing?.title === next.title
    && existing?.text === next.text
    && audienceEquals(existing?.access, next.access)
    && Number(existing?.accessRevision || 1) === Number(next.accessRevision || 1)
    && existing?.indexingEnabled !== false;
}

async function syncCalendar(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: ConnectorSyncLease;
  trigger: ConnectorSyncTrigger;
  dependencies: ConnectorSyncDependencies;
  request: typeof fetch;
  forceFull?: boolean;
}): Promise<ConnectorSyncResourceCompletion> {
  const now = input.dependencies.now?.() || Timestamp.now();
  const calendarId = String(input.resource.data.externalId || "");
  const calendarName = String(input.resource.data.displayName || calendarId);
  const storedDelta = usableDeltaLink(input.resource.data, now, input.forceFull);
  const full = !storedDelta;
  const initial = initialDeltaUrl(calendarId, now);
  let url = storedDelta || initial.url;
  let deltaLink = "";
  let changes = 0;
  const observed = new Set<string>();
  const existing = await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id).get();
  const existingById = new Map(existing.docs.map((doc) => [doc.id, doc]));
  try {
    do {
      const page = await graphGet<GraphEventDelta>({ url, accessToken: input.accessToken, request: input.request });
      const writes: Array<{ ref: FirebaseFirestore.DocumentReference; value: Record<string, unknown> | null }> = [];
      for (const event of page.value || []) {
        if (!event.id) continue;
        const itemId = outlookCalendarContextItemId(input.connectionId, calendarId, event.id);
        const ref = input.dependencies.database.doc(companyDocumentPath(input.companyId, "contextItems", itemId));
        if (event["@removed"]) {
          if (existingById.has(itemId)) writes.push({ ref, value: null });
          continue;
        }
        observed.add(itemId);
        const value = outlookCalendarEventContextItem({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: input.resource.id,
          calendarId,
          calendarName,
          event,
          audience: input.resource.data.audience,
          audienceRevision: Number(input.resource.data.audienceRevision || 1),
          observedAt: now,
          observation: {
            runId: input.lease.runId,
            trigger: input.trigger,
            providerUpdatedAt: event.lastModifiedDateTime || null,
            providerVersion: event.changeKey || event.lastModifiedDateTime || sha256Hex(JSON.stringify(event)).slice(0, 16),
            freshnessEligible: true,
          },
        });
        if (!value || contextMatches(existingById.get(itemId)?.data(), value)) continue;
        writes.push({ ref, value });
      }
      for (let offset = 0; offset < writes.length; offset += 400) {
        const batch = writes.slice(offset, offset + 400);
        await commitConnectorSyncWrites({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: input.resource.id,
          lease: input.lease,
          apply: (transaction) => batch.forEach((write) => {
            if (write.value) transaction.set(write.ref, write.value, { merge: false });
            else transaction.delete(write.ref);
          }),
        }, input.dependencies);
        changes += batch.length;
      }
      url = page["@odata.nextLink"] || "";
      deltaLink = page["@odata.deltaLink"] || deltaLink;
    } while (url);
  } catch (error) {
    if (!full && error instanceof MicrosoftGraphCalendarError && [404, 410].includes(error.status)) {
      return syncCalendar({ ...input, forceFull: true });
    }
    throw error;
  }
  if (!deltaLink) throw new Error("Microsoft Graph calendar delta sync returned no durable cursor");
  if (full) {
    const stale = existing.docs.filter((doc) => !observed.has(doc.id));
    for (let offset = 0; offset < stale.length; offset += 400) {
      const batch = stale.slice(offset, offset + 400);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => batch.forEach((doc) => transaction.delete(doc.ref)),
      }, input.dependencies);
      changes += batch.length;
    }
  }
  const itemCount = (await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id).count().get()).data().count;
  return {
    changes,
    itemCount,
    cursorAfter: sha256Hex(deltaLink).slice(0, 16),
    cursorMode: full ? "full" : "incremental",
    resourcePatch: {
      deltaLink,
      requiresFullSync: false,
      ...(full ? {
        windowStart: initial.start,
        windowEnd: initial.end,
        windowAnchoredAt: now,
      } : {}),
    },
  };
}

export type CalendarSyncInput = {
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
  fetch?: typeof fetch;
  now?: () => Timestamp;
};

export type OutlookCalendarSyncResult = ConnectorSyncRunResult & { calendars: number };

async function executeRun(input: CalendarSyncInput & { runId: string }): Promise<OutlookCalendarSyncResult> {
  const database = input.database || db;
  const request = input.fetch || fetch;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const completed = await executeConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId,
    serviceId,
    prepare: () => authorized(input),
    listResources: async () => {
      const snapshot = await database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId))
        .collection("resources").where("capabilityId", "==", capabilityId)
        .where("status", "==", "enabled").get();
      return snapshot.docs.map((resource) => ({ id: resource.id, data: resource.data() }));
    },
    cursorBefore: (resource) => {
      const delta = usableDeltaLink(resource.data, input.now?.() || Timestamp.now());
      return delta ? sha256Hex(delta).slice(0, 16) : null;
    },
    cursorMode: (resource) => usableDeltaLink(resource.data, input.now?.() || Timestamp.now()) ? "incremental" : "full",
    synchronizeResource: ({ preparation, resource, trigger, lease, dependencies: runDependencies }) => syncCalendar({
      companyId: input.companyId,
      connectionId: input.connectionId,
      resource,
      accessToken: preparation.accessToken,
      lease,
      trigger,
      dependencies: runDependencies,
      request,
    }),
    classifyError: (error) => {
      if (error instanceof MicrosoftAuthorizationError) return "reauthorization_required";
      if (error instanceof MicrosoftGraphCalendarError) {
        if ([401, 403].includes(error.status)) return "reauthorization_required";
        if (error.status === 429 || error.status >= 500) return "transient";
        return "permanent";
      }
      return "transient";
    },
  }, dependencies);
  return { ...completed, calendars: completed.resources };
}

export async function syncMicrosoftOutlookCalendarConnection(input: CalendarSyncInput): Promise<OutlookCalendarSyncResult> {
  const database = input.database || db;
  const connection = database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId));
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", capabilityId).where("status", "==", "enabled").get();
  const selected = input.resourceIds?.filter((id) => resources.docs.some((doc) => doc.id === id))
    || resources.docs.map((doc) => doc.id);
  const created = await createConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId,
    serviceId,
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy,
    resourceIds: selected,
    replayOfRunId: input.replayOfRunId,
  }, { database, now: input.now });
  if (!created.created || created.deferred) {
    const run = await connection.collection("syncRuns").doc(created.runId).get();
    const result = connectorSyncRunResultFromData(created.runId, run.data() || {});
    return { ...result, calendars: result.resources };
  }
  return executeRun({ ...input, runId: created.runId });
}

export async function selectMicrosoftOutlookCalendars(input: CalendarSyncInput & {
  calendarIds: string[];
  actorUid: string;
}): Promise<{ selected: number } & OutlookCalendarSyncResult> {
  const database = input.database || db;
  const calendars = await listMicrosoftOutlookCalendars(input);
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const selectedIds = [...new Set(input.calendarIds)];
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new Error("One or more selected Outlook calendars are no longer accessible");
  }
  const connection = database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId));
  const [connectionSnapshot, resources] = await Promise.all([
    connection.get(),
    connection.collection("resources").where("capabilityId", "==", capabilityId).get(),
  ]);
  if (!connectionSnapshot.exists || connectionSnapshot.data()?.connectorId !== "microsoft_365") {
    throw new Error("Microsoft connection not found");
  }
  const selectedSet = new Set(selectedIds);
  const batch = database.batch();
  const now = input.now?.() || Timestamp.now();
  for (const calendarId of selectedIds) {
    const calendar = byId.get(calendarId)!;
    const ref = connection.collection("resources").doc(outlookCalendarResourceId(calendarId));
    const existing = resources.docs.find((resource) => resource.id === ref.id);
    batch.set(ref, {
      connectionId: input.connectionId,
      capabilityId,
      resourceType: "calendar",
      externalId: calendarId,
      displayName: calendar.displayName,
      description: calendar.description,
      primary: calendar.primary,
      accessRole: calendar.accessRole,
      canViewPrivateItems: calendar.canViewPrivateItems,
      status: "enabled",
      ...(existing ? {} : {
        audience: { visibility: "restricted", memberIds: [connectionSnapshot.data()?.createdBy].filter(Boolean) },
        audienceRevision: 1,
        requiresFullSync: true,
        createdAt: now,
      }),
      updatedBy: input.actorUid,
      updatedAt: now,
    }, { merge: true });
  }
  const removed = resources.docs.filter((resource) => !selectedSet.has(String(resource.data().externalId)));
  removed.forEach((resource) => batch.delete(resource.ref));
  batch.set(connection.collection("capabilities").doc(serviceId), {
    status: selectedIds.length ? "active" : "permission_granted",
    updatedAt: now,
  }, { merge: true });
  await batch.commit();
  for (const resource of removed) {
    const items = await contextItems(input.companyId, database)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id).get();
    for (let offset = 0; offset < items.docs.length; offset += 400) {
      const deleteBatch = database.batch();
      items.docs.slice(offset, offset + 400).forEach((item) => deleteBatch.delete(item.ref));
      await deleteBatch.commit();
    }
  }
  const result = await syncMicrosoftOutlookCalendarConnection({
    ...input,
    trigger: "selection",
    requestedBy: input.actorUid,
  });
  return { selected: selectedIds.length, ...result };
}

export async function replayMicrosoftOutlookCalendarSyncRun(input: CalendarSyncInput & {
  runId: string;
  actorUid: string;
}): Promise<OutlookCalendarSyncResult> {
  const database = input.database || db;
  const resourceIds = await replayableConnectorSyncResources({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId,
    serviceId,
  }, { database });
  return syncMicrosoftOutlookCalendarConnection({
    ...input,
    trigger: "operator_replay",
    requestedBy: input.actorUid,
    replayOfRunId: input.runId,
    resourceIds,
  });
}

export async function retryDueMicrosoftOutlookCalendarSyncRuns(
  input: Omit<CalendarSyncInput, "companyId" | "connectionId"> & { limit?: number },
) {
  const database = input.database || db;
  const due = await listDueConnectorSyncRuns({ serviceId, limit: input.limit }, { database, now: input.now });
  const results: Array<OutlookCalendarSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of due) {
    const connection = await database.doc(companyDocumentPath(run.companyId, "connections", run.connectionId)).get();
    if (connection.data()?.connectorId !== "microsoft_365") continue;
    results.push({ companyId: run.companyId, connectionId: run.connectionId, ...await executeRun({
      ...input,
      companyId: run.companyId,
      connectionId: run.connectionId,
      runId: run.runId,
      trigger: "retry",
    }) });
  }
  return results;
}

export async function syncAllMicrosoftOutlookCalendarConnections(
  input: Omit<CalendarSyncInput, "companyId" | "connectionId">,
) {
  const database = input.database || db;
  const companies = await database.collection("companies").get();
  const results: Array<{ companyId: string; connectionId: string; ok: boolean; error?: string }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "microsoft_365")
      .where("status", "in", ["active", "attention"]).get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc(serviceId).get();
      if (!capability.exists || !["active", "attention"].includes(String(capability.data()?.status))) continue;
      try {
        const result = await syncMicrosoftOutlookCalendarConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
          trigger: "scheduled",
          requestedBy: "scheduler:outlook-calendar",
        });
        results.push({ companyId: company.id, connectionId: connection.id, ok: result.status !== "attention" });
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
