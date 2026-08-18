import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import { encryptCredentials } from "../connectors/credentials.js";
import {
  outlookCalendarContextItemId,
  outlookCalendarResourceId,
  selectMicrosoftOutlookCalendars,
  syncMicrosoftOutlookCalendarConnection,
} from "../connectors/microsoft-outlook-calendar.js";
import { MemoryFirestore } from "./firestore-harness.js";

const companyId = "company-outlook-calendar";
const connectionId = "microsoft-calendar-1";
const calendarId = "calendar-provider-id";
const credentialKey = Buffer.alloc(32, 23).toString("base64");
const now = Timestamp.fromDate(new Date("2026-08-18T10:00:00.000Z"));
const connectionPath = `companies/${companyId}/connections/${connectionId}`;

function seedConnection(memory: MemoryFirestore): void {
  memory.seed(connectionPath, {
    companyId,
    connectorId: "microsoft_365",
    status: "active",
    createdBy: "member-owner",
    tenantId: "consumer-tenant",
    credentialRevision: 1,
    credentialCiphertext: encryptCredentials({
      accessToken: "calendar-access-token",
      refreshToken: "calendar-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      accessTokenScopes: "openid profile offline_access User.Read Calendars.Read",
      consentedScopes: "openid profile offline_access User.Read Calendars.Read",
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/calendar`, {
    capabilityId: "context.calendar.read",
    serviceId: "calendar",
    status: "permission_granted",
    grantedScopes: ["Calendars.Read"],
    stats: {},
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Outlook Calendar selects explicitly, redacts private details, and resumes opaque delta", async () => {
  const memory = new MemoryFirestore();
  seedConnection(memory);
  const requested: URL[] = [];
  let incremental = false;
  const request = (async (value: string | URL | Request) => {
    const url = new URL(String(value));
    requested.push(url);
    if (url.pathname === "/v1.0/me/calendars") {
      return json({ value: [{
        id: calendarId,
        name: "Personal calendar",
        isDefaultCalendar: true,
        canEdit: true,
        canViewPrivateItems: true,
        owner: { address: "owner@outlook.com" },
      }] });
    }
    if (incremental) {
      assert.equal(url.searchParams.get("$deltatoken"), "calendar-cursor-1");
      return json({
        value: [{
          id: "event-private",
          changeKey: "event-v2",
          subject: "Still secret",
          sensitivity: "private",
          isCancelled: true,
          start: { dateTime: "2026-08-20T09:00:00.0000000", timeZone: "Europe/Prague" },
          end: { dateTime: "2026-08-20T10:00:00.0000000", timeZone: "Europe/Prague" },
          lastModifiedDateTime: "2026-08-18T10:05:00.000Z",
        }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/x/calendarView/delta?$deltatoken=calendar-cursor-2",
      });
    }
    assert.match(url.pathname, /\/calendarView\/delta$/);
    assert.ok(url.searchParams.has("startDateTime"));
    assert.ok(url.searchParams.has("endDateTime"));
    assert.equal(url.searchParams.has("$select"), false, "calendarView delta does not support $select");
    return json({
      value: [{
        id: "event-private",
        changeKey: "event-v1",
        subject: "Acquisition secret",
        body: { contentType: "html", content: "<p>Do not expose this</p>" },
        sensitivity: "private",
        type: "occurrence",
        seriesMasterId: "series-1",
        recurrence: { pattern: { type: "weekly", interval: 1 } },
        start: { dateTime: "2026-08-20T09:00:00.0000000", timeZone: "Europe/Prague" },
        end: { dateTime: "2026-08-20T10:00:00.0000000", timeZone: "Europe/Prague" },
        organizer: { emailAddress: { address: "owner@outlook.com" } },
        attendees: [{
          emailAddress: { address: "guest@example.com" },
          type: "required",
          status: { response: "accepted", time: "2026-08-18T09:00:00Z" },
        }],
        webLink: "https://outlook.live.com/calendar/item/private",
        lastModifiedDateTime: "2026-08-18T09:55:00.000Z",
      }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/x/calendarView/delta?$deltatoken=calendar-cursor-1",
    });
  }) as typeof fetch;

  const first = await selectMicrosoftOutlookCalendars({
    companyId,
    connectionId,
    calendarIds: [calendarId],
    actorUid: "member-owner",
    clientId: "client",
    clientSecret: "secret",
    credentialKey,
    database: memory.asFirestore(),
    fetch: request,
    now: () => now,
  });
  assert.equal(first.status, "succeeded");
  assert.equal(first.selected, 1);
  const resourceId = outlookCalendarResourceId(calendarId);
  const resource = memory.read(`${connectionPath}/resources/${resourceId}`);
  assert.deepEqual(resource?.audience, { visibility: "restricted", memberIds: ["member-owner"] });
  assert.equal(memory.read(`${connectionPath}/capabilities/calendar`)?.status, "active");
  assert.match(String(resource?.deltaLink), /calendar-cursor-1/);

  const itemPath = `companies/${companyId}/contextItems/${outlookCalendarContextItemId(
    connectionId, calendarId, "event-private",
  )}`;
  const item = memory.read(itemPath);
  assert.equal(item?.title, "Private calendar event");
  assert.match(String(item?.text), /Date: Thursday, August 20, 2026/);
  assert.doesNotMatch(String(item?.text), /Acquisition|Do not expose|guest@example/);
  assert.deepEqual(item?.participantRefs, []);
  assert.equal((item?.metadata as Record<string, unknown>).restrictedDetails, true);
  assert.equal((item?.metadata as Record<string, unknown>).seriesMasterId, "series-1");

  incremental = true;
  const second = await syncMicrosoftOutlookCalendarConnection({
    companyId,
    connectionId,
    clientId: "client",
    clientSecret: "secret",
    credentialKey,
    database: memory.asFirestore(),
    fetch: request,
    now: () => now,
  });
  assert.equal(second.status, "succeeded");
  assert.equal((memory.read(itemPath)?.metadata as Record<string, unknown>).status, "cancelled");
  assert.match(String(memory.read(`${connectionPath}/resources/${resourceId}`)?.deltaLink), /calendar-cursor-2/);
  assert.equal(requested.filter((url) => url.pathname === "/v1.0/me/calendars").length, 1);
});

test("an expired Outlook Calendar cursor rebuilds the bounded calendar window", async () => {
  const memory = new MemoryFirestore();
  seedConnection(memory);
  const resourceId = outlookCalendarResourceId(calendarId);
  memory.seed(`${connectionPath}/capabilities/calendar`, {
    capabilityId: "context.calendar.read",
    serviceId: "calendar",
    status: "active",
    grantedScopes: ["Calendars.Read"],
  });
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    connectionId,
    capabilityId: "context.calendar.read",
    status: "enabled",
    externalId: calendarId,
    displayName: "Calendar",
    audience: { visibility: "restricted", memberIds: ["member-owner"] },
    audienceRevision: 1,
    deltaLink: "https://graph.microsoft.com/v1.0/me/calendars/x/calendarView/delta?$deltatoken=expired",
    windowAnchoredAt: now,
  });
  let calls = 0;
  const request = (async (value: string | URL | Request) => {
    calls += 1;
    const url = new URL(String(value));
    if (calls === 1) return json({ error: { code: "SyncStateNotFound", message: "expired" } }, 410);
    assert.ok(url.searchParams.has("startDateTime"));
    assert.ok(url.searchParams.has("endDateTime"));
    return json({ value: [], "@odata.deltaLink": `${url.origin}${url.pathname}?$deltatoken=fresh` });
  }) as typeof fetch;
  const result = await syncMicrosoftOutlookCalendarConnection({
    companyId,
    connectionId,
    clientId: "client",
    clientSecret: "secret",
    credentialKey,
    database: memory.asFirestore(),
    fetch: request,
    now: () => now,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2);
  assert.match(String(memory.read(`${connectionPath}/resources/${resourceId}`)?.deltaLink), /fresh/);
});
