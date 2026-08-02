import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  calendarContextItemId,
  calendarResourceId,
  syncGoogleCalendarConnection,
} from "../connectors/google-calendar.js";
import { encryptCredentials } from "../connectors/credentials.js";
import { calendarScopes } from "../connectors/registry.js";
import { MemoryFirestore } from "./firestore-harness.js";

test("Calendar reconciliation uses the durable run and resource lease path", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const companyId = "explorers";
  const connectionId = "google-a";
  const calendarId = "primary@example.com";
  const resourceId = calendarResourceId(calendarId);
  const connectionPath = `companies/${companyId}/connections/${connectionId}`;
  const credentialKey = Buffer.alloc(32, 7).toString("base64");
  const now = Timestamp.fromDate(new Date("2026-08-02T10:00:00.000Z"));
  memory.seed(connectionPath, {
    companyId,
    connectorId: "google_workspace",
    status: "active",
    credentialCiphertext: encryptCredentials({
      accessToken: "calendar-access-token",
      refreshToken: "calendar-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: calendarScopes.join(" "),
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/calendar`, {
    capabilityId: "context.calendar.read",
    serviceId: "calendar",
    status: "active",
    grantedScopes: calendarScopes,
    stats: {},
  });
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    connectionId,
    capabilityId: "context.calendar.read",
    resourceType: "calendar",
    externalId: calendarId,
    displayName: "Primary",
    status: "enabled",
    itemCount: 0,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    assert.match(url.pathname, /\/calendar\/v3\/calendars\/primary%40example.com\/events$/);
    assert.equal(url.searchParams.get("showDeleted"), "true");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    return new Response(JSON.stringify({
      items: [{
        id: "event-1",
        status: "confirmed",
        summary: "Production handoff",
        updated: "2026-08-02T09:55:00.000Z",
        start: { dateTime: "2026-08-03T09:00:00+02:00" },
        end: { dateTime: "2026-08-03T09:30:00+02:00" },
      }],
      nextSyncToken: "calendar-cursor-2",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await syncGoogleCalendarConnection({
      companyId,
      connectionId,
      clientId: "google-client",
      clientSecret: "google-secret",
      credentialKey,
      trigger: "manual",
      requestedBy: "admin-1",
      database,
      now: () => now,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.calendars, 1);
    assert.equal(result.changes, 1);
    assert.equal(
      memory.read(`${connectionPath}/resources/${resourceId}`)?.syncToken,
      "calendar-cursor-2",
    );
    assert.ok(memory.read(
      `companies/${companyId}/contextItems/${calendarContextItemId(connectionId, calendarId, "event-1")}`,
    ));
    const run = memory.read(`${connectionPath}/syncRuns/${result.runId}`) || {};
    assert.equal(run.status, "succeeded");
    assert.equal(run.trigger, "manual");
    const attempts = memory.list(
      `${connectionPath}/syncRuns/${result.runId}/resourceAttempts`,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.cursorBefore, null);
    assert.equal(attempts[0]?.cursorAfter, "calendar-cursor-2");
    assert.equal(attempts[0]?.cursorMode, "full");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Calendar expired cursors rebuild atomically, reconcile stale items, and retain recurrence identity", async () => {
  const memory = new MemoryFirestore();
  const database = memory.asFirestore();
  const companyId = "explorers";
  const connectionId = "google-expired";
  const calendarId = "team@example.com";
  const resourceId = calendarResourceId(calendarId);
  const connectionPath = `companies/${companyId}/connections/${connectionId}`;
  const credentialKey = Buffer.alloc(32, 8).toString("base64");
  const now = Timestamp.fromDate(new Date("2026-08-02T10:00:00.000Z"));
  memory.seed(connectionPath, {
    companyId,
    connectorId: "google_workspace",
    status: "active",
    credentialCiphertext: encryptCredentials({
      accessToken: "calendar-access-token",
      refreshToken: "calendar-refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: calendarScopes.join(" "),
    }, credentialKey),
    stats: {},
  });
  memory.seed(`${connectionPath}/capabilities/calendar`, {
    capabilityId: "context.calendar.read",
    serviceId: "calendar",
    status: "active",
    grantedScopes: calendarScopes,
    stats: {},
  });
  memory.seed(`${connectionPath}/resources/${resourceId}`, {
    connectionId,
    capabilityId: "context.calendar.read",
    resourceType: "calendar",
    externalId: calendarId,
    displayName: "Team",
    status: "enabled",
    audience: { visibility: "restricted", memberIds: ["member-a"] },
    audienceRevision: 4,
    syncToken: "expired-token",
    itemCount: 2,
  });
  const staleId = calendarContextItemId(connectionId, calendarId, "stale-event");
  const cancelledId = calendarContextItemId(connectionId, calendarId, "cancelled-instance");
  for (const [id, externalId] of [[staleId, "stale-event"], [cancelledId, "cancelled-instance"]]) {
    memory.seed(`companies/${companyId}/contextItems/${id}`, {
      companyId,
      kind: "calendar.event",
      source: { connectionId, resourceId, externalId, version: "old" },
      access: { visibility: "restricted", memberIds: ["member-a"] },
      accessRevision: 4,
      indexingEnabled: true,
    });
  }

  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const url = new URL(String(request));
    requests.push(url);
    if (url.searchParams.get("syncToken")) {
      return new Response(JSON.stringify({
        error: { code: 410, message: "Sync token is no longer valid", status: "GONE" },
      }), { status: 410, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      items: [{
        id: "series-instance-20260803",
        status: "confirmed",
        summary: "Daily handoff",
        updated: "2026-08-02T09:55:00.000Z",
        recurringEventId: "series-1",
        originalStartTime: { dateTime: "2026-08-03T09:00:00+02:00" },
        sequence: 3,
        eventType: "default",
        start: { dateTime: "2026-08-03T10:00:00+02:00" },
        end: { dateTime: "2026-08-03T10:30:00+02:00" },
      }, {
        id: "cancelled-instance",
        status: "cancelled",
        recurringEventId: "series-1",
        originalStartTime: { dateTime: "2026-08-04T09:00:00+02:00" },
      }],
      nextSyncToken: "rebuilt-token",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await syncGoogleCalendarConnection({
      companyId,
      connectionId,
      clientId: "google-client",
      clientSecret: "google-secret",
      credentialKey,
      database,
      now: () => now,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.changes, 3);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.searchParams.get("syncToken"), "expired-token");
    assert.ok(requests[1]?.searchParams.get("timeMin"));
    assert.equal(memory.read(`companies/${companyId}/contextItems/${staleId}`), undefined);
    assert.equal(memory.read(`companies/${companyId}/contextItems/${cancelledId}`), undefined);
    const instanceId = calendarContextItemId(
      connectionId,
      calendarId,
      "series-instance-20260803",
    );
    const instance = memory.read(`companies/${companyId}/contextItems/${instanceId}`) || {};
    assert.deepEqual(instance.access, {
      visibility: "restricted",
      memberIds: ["member-a"],
    });
    assert.equal(instance.accessRevision, 4);
    assert.deepEqual((instance.metadata as Record<string, unknown>).originalStartTime, {
      dateTime: "2026-08-03T09:00:00+02:00",
    });
    assert.equal((instance.metadata as Record<string, unknown>).recurringEventId, "series-1");
    assert.equal(memory.read(`${connectionPath}/resources/${resourceId}`)?.syncToken, "rebuilt-token");
    const attempts = memory.list(`${connectionPath}/syncRuns/${result.runId}/resourceAttempts`);
    assert.equal(attempts[0]?.cursorMode, "full");
    assert.equal(attempts[0]?.cursorAfter, "rebuilt-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
