import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { googleOAuthReturnUrl } from "./google-oauth-return.js";
import { defaultCompanyId } from "./odorik.js";

export const calendarScopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

export const defaultGoogleRedirectUri =
  process.env.GOOGLE_CONNECTOR_REDIRECT_URI?.trim()
  || "https://odorik-tx-260720-c58d.web.app/oauth/google/callback";

// The consent warning for an unverified test app can require a manual handoff.
// Keep the state short-lived, but leave enough time for the user to review it.
export const calendarAuthorizationLifetimeMs = 60 * 60 * 1000;

type GoogleTokens = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

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

type CalendarEvent = {
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

type CalendarCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function connectionRef(connectionId: string) {
  return db.doc(`companies/${defaultCompanyId}/connections/${connectionId}`);
}

function calendarResourceId(calendarId: string): string {
  return `calendar_${hash(calendarId).slice(0, 24)}`;
}

function calendarContextItemId(
  connectionId: string,
  calendarId: string,
  eventId: string,
): string {
  return `calendar_${hash(`${connectionId}:${calendarId}:${eventId}`).slice(0, 32)}`;
}

function requireGoogleSuccess<T>(response: Response, body: T & { error?: unknown }): T {
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : JSON.stringify(body.error || body);
    throw new Error(`Google API failed (${response.status}): ${message.slice(0, 1000)}`);
  }
  return body;
}

export async function revokeGoogleToken(token: string): Promise<boolean> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return true;
  // Google returns 400 when the token is already invalid or revoked. Either
  // way, it no longer grants this application access.
  if (response.status === 400) return false;
  throw new Error(`Google token revocation failed (${response.status})`);
}

export async function revokeGoogleCalendarAuthorization(input: {
  connectionId: string;
  credentialKey: string;
}): Promise<boolean> {
  const connection = await connectionRef(input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== "google_calendar"
    || typeof data.credentialCiphertext !== "string"
  ) return false;
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as CalendarCredential;
  const token = credentials.refreshToken || credentials.accessToken;
  return token ? revokeGoogleToken(token) : false;
}

export async function createCalendarAuthorization(input: {
  uid: string;
  email: string;
  displayName: string;
  clientId: string;
  returnOrigin?: string;
}): Promise<{ authorizationUrl: string }> {
  const state = randomBytes(32).toString("base64url");
  const stateHash = hash(state);
  const now = Timestamp.now();
  await db.doc(`companies/${defaultCompanyId}/oauthStates/${stateHash}`).set({
    provider: "google_calendar",
    uid: input.uid,
    email: input.email,
    displayName: input.displayName,
    redirectUri: defaultGoogleRedirectUri,
    returnUrl: googleOAuthReturnUrl(input.returnOrigin),
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + calendarAuthorizationLifetimeMs),
  });
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: defaultGoogleRedirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: calendarScopes.join(" "),
    state,
  });
  return {
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
  };
}

export async function exchangeGoogleAuthorization(input: {
  code: string;
  state: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ connectionId: string }> {
  const stateRef = db.doc(
    `companies/${defaultCompanyId}/oauthStates/${hash(input.state)}`,
  );
  const stateSnapshot = await stateRef.get();
  const stateData = stateSnapshot.data();
  const expiresAt = stateData?.expiresAt instanceof Timestamp
    ? stateData.expiresAt.toMillis()
    : 0;
  if (
    !stateSnapshot.exists
    || stateData?.provider !== "google_calendar"
    || expiresAt < Date.now()
  ) {
    throw new Error("The Google authorization request is invalid or expired");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: String(stateData.redirectUri || defaultGoogleRedirectUri),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = requireGoogleSuccess(
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token || !tokenBody.refresh_token) {
    throw new Error("Google did not return the required offline refresh token");
  }

  const calendarEntries = await allCalendarEntries(tokenBody.access_token);
  const providerAccountId = String(
    calendarEntries.find((entry) => entry.primary)?.id
    || stateData.email
    || "unknown Google account",
  );
  const connections = db.collection(`companies/${defaultCompanyId}/connections`);
  const existingConnections = await connections
    .where("adapterId", "==", "google_calendar")
    .get();
  const existingConnection = existingConnections.docs.find(
    (document) => document.data().providerAccountId === providerAccountId,
  );
  const connection = existingConnection?.ref || connections.doc();
  const now = Timestamp.now();
  const credentials: CalendarCredential = {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || calendarScopes.join(" "),
  };
  const batch = db.batch();
  batch.delete(stateRef);
  batch.set(connection, {
    companyId: defaultCompanyId,
    adapterId: "google_calendar",
    displayName: "Google Calendar",
    accountLabel: providerAccountId,
    providerAccountId,
    status: "active",
    auth: {
      kind: "oauth2",
      credentialMode: "encrypted",
      scopes: calendarScopes,
    },
    credentialCiphertext: encryptCredentials(credentials, input.credentialKey),
    stats: { itemCount: 0, lastError: null },
    createdBy: existingConnection?.data().createdBy || stateData.uid,
    authorizedBy: {
      email: stateData.email || null,
      displayName: stateData.displayName || null,
    },
    ...(!existingConnection ? { createdAt: now } : { reauthorizedAt: now }),
    updatedAt: now,
  }, { merge: true });
  await batch.commit();
  return { connectionId: connection.id };
}

async function authorizedConnection(input: {
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ accessToken: string; connection: FirebaseFirestore.DocumentSnapshot }> {
  const connection = await connectionRef(input.connectionId).get();
  const data = connection.data();
  if (
    !connection.exists
    || data?.adapterId !== "google_calendar"
    || !["active", "attention"].includes(String(data?.status))
    || typeof data.credentialCiphertext !== "string"
  ) {
    throw new Error("Active Google Calendar connection not found");
  }
  const credentials = decryptCredentials(
    data.credentialCiphertext,
    input.credentialKey,
  ) as CalendarCredential;
  if (
    credentials.accessToken
    && new Date(credentials.expiresAt).getTime() > Date.now() + 60_000
  ) {
    return { accessToken: credentials.accessToken, connection };
  }
  if (!credentials.refreshToken) throw new Error("Google refresh token is missing");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: credentials.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokenBody = requireGoogleSuccess(
    response,
    await response.json() as GoogleTokens,
  );
  if (!tokenBody.access_token) throw new Error("Google access token refresh failed");
  const updated: CalendarCredential = {
    ...credentials,
    accessToken: tokenBody.access_token,
    expiresAt: new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString(),
    scope: tokenBody.scope || credentials.scope,
  };
  await connection.ref.set({
    credentialCiphertext: encryptCredentials(updated, input.credentialKey),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { accessToken: updated.accessToken, connection };
}

async function googleGet<T>(url: URL, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(60_000),
  });
  return requireGoogleSuccess(response, await response.json() as T & { error?: unknown });
}

async function allCalendarEntries(accessToken: string): Promise<CalendarListEntry[]> {
  const entries: CalendarListEntry[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleGet<CalendarListResponse>(url, accessToken);
    entries.push(...(page.items || []).filter((item) => !item.deleted && item.id));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return entries;
}

export async function listGoogleCalendars(input: {
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<SelectableCalendar[]> {
  const { accessToken, connection } = await authorizedConnection(input);
  const [entries, resources] = await Promise.all([
    allCalendarEntries(accessToken),
    connection.ref.collection("resources").get(),
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

function eventContextItem(input: {
  connectionId: string;
  resourceId: string;
  calendarId: string;
  calendarName: string;
  event: CalendarEvent;
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
  const checksum = hash(JSON.stringify(input.event));
  return {
    companyId: defaultCompanyId,
    kind: "calendar.event",
    source: {
      adapterId: "google_calendar",
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: input.event.id,
      version: input.event.updated || checksum.slice(0, 16),
    },
    title,
    text: body,
    occurredAt: start,
    observedAt: Timestamp.now(),
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

async function syncCalendarResource(input: {
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
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "true");
    if (storedSyncToken) {
      url.searchParams.set("syncToken", storedSyncToken);
    } else {
      url.searchParams.set(
        "timeMin",
        new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let page: EventsResponse;
    try {
      page = await googleGet<EventsResponse>(url, input.accessToken);
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
      const itemRef = db.doc(
        `companies/${defaultCompanyId}/contextItems/${calendarContextItemId(
          input.connectionId,
          calendarId,
          event.id,
        )}`,
      );
      const contextItem = eventContextItem({
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

  const itemCount = (await db.collection(
    `companies/${defaultCompanyId}/contextItems`,
  ).where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count()
    .get()).data().count;
  await input.resource.ref.set({
    syncToken: nextSyncToken || data.syncToken || null,
    lastSyncAt: FieldValue.serverTimestamp(),
    itemCount,
    lastError: null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return synced;
}

export async function syncGoogleCalendarConnection(input: {
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ calendars: number; changes: number }> {
  const { accessToken, connection } = await authorizedConnection(input);
  const resources = await connection.ref.collection("resources")
    .where("status", "==", "enabled")
    .get();
  let changes = 0;
  try {
    for (const resource of resources.docs) {
      changes += await syncCalendarResource({
        connectionId: input.connectionId,
        resource,
        accessToken,
      });
    }
    const itemCount = (await db.collection(
      `companies/${defaultCompanyId}/contextItems`,
    ).where("source.connectionId", "==", input.connectionId).count().get()).data().count;
    const updated = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(connection.ref);
      if (
        !current.exists
        || !["active", "attention"].includes(String(current.data()?.status))
      ) return false;
      transaction.set(connection.ref, {
        status: "active",
        stats: {
          itemCount,
          lastSyncAt: FieldValue.serverTimestamp(),
          lastObservedAt: FieldValue.serverTimestamp(),
          lastError: null,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return true;
    });
    if (!updated) throw new Error("Google Calendar connection was disconnected during synchronization");
    return { calendars: resources.size, changes };
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(connection.ref);
      if (
        !current.exists
        || !["active", "attention"].includes(String(current.data()?.status))
      ) return;
      transaction.set(connection.ref, {
        status: "attention",
        stats: {
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1500),
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    throw error;
  }
}

export async function selectGoogleCalendars(input: {
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
  const connection = connectionRef(input.connectionId);
  const resources = await connection.collection("resources").get();
  const batch = db.batch();
  const now = Timestamp.now();
  for (const calendar of calendars) {
    const resourceRef = connection.collection("resources").doc(
      calendarResourceId(calendar.id),
    );
    batch.set(resourceRef, {
      connectionId: input.connectionId,
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
    const items = await db.collection(`companies/${defaultCompanyId}/contextItems`)
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
}): Promise<Array<{ connectionId: string; ok: boolean; error?: string }>> {
  const connections = await db.collection(
    `companies/${defaultCompanyId}/connections`,
  ).where("adapterId", "==", "google_calendar")
    .where("status", "in", ["active", "attention"])
    .get();
  const results: Array<{ connectionId: string; ok: boolean; error?: string }> = [];
  for (const connection of connections.docs) {
    try {
      await syncGoogleCalendarConnection({ ...input, connectionId: connection.id });
      results.push({ connectionId: connection.id, ok: true });
    } catch (error) {
      results.push({
        connectionId: connection.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
