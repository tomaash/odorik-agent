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
