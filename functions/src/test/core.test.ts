import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartProcessingRun,
  normalizePhone,
  shouldProcessCallUpdate,
} from "../crm/process.js";
import { validateProposalEvidence } from "../crm/extract.js";
import {
  allowedRequestTransitions,
  canTransitionRequestStatus,
  normalizeRequestStatus,
  storedStatusesFor,
} from "../crm/lifecycle.js";
import { decryptCredentials, encryptCredentials } from "../connectors/credentials.js";
import {
  calendarAuthorizationLifetimeMs,
  revokeGoogleToken,
} from "../connectors/google-calendar.js";
import { driveAuthorizationLifetimeMs, driveScopes } from "../connectors/google-drive.js";
import {
  isThrottled,
  partnerFormSchema,
  partnerFormSubject,
  renderPartnerFormEmail,
} from "../partner-form-message.js";
import {
  defaultGoogleRedirectUri,
  googleOAuthRedirectUri,
  googleOAuthReturnUrl,
  localGoogleRedirectUri,
} from "../connectors/google-oauth-return.js";
import {
  odorikContextItem,
  odorikContextItemId,
  odorikDestinationUrl,
  odorikResourceIdentity,
} from "../connectors/odorik.js";
import {
  companyCollectionPath,
  companyDocumentPath,
} from "../tenancy.js";
import {
  digestInvitationSecret,
  formatInvitationToken,
  invitationSecretMatches,
  normalizeInvitationEmail,
  parseInvitationToken,
} from "../invitation-token.js";

test("tenant paths always include a validated company boundary", () => {
  assert.equal(
    companyCollectionPath("explorers", "contacts"),
    "companies/explorers/contacts",
  );
  assert.equal(
    companyDocumentPath("explorers", "contacts", "contact-1"),
    "companies/explorers/contacts/contact-1",
  );
  assert.throws(() => companyCollectionPath("../other", "contacts"));
  assert.throws(() => companyDocumentPath("explorers", "contacts", "../contact"));
});

test("invitation tokens are opaque, company-bound, and reject malformed input", () => {
  const secret = "a".repeat(43);
  const token = formatInvitationToken({
    companyId: "explorers",
    invitationId: "AbCdEf1234567890GhIj",
    secret,
  });
  assert.deepEqual(parseInvitationToken(token), {
    companyId: "explorers",
    invitationId: "AbCdEf1234567890GhIj",
    secret,
  });
  assert.equal(parseInvitationToken(`../other.AbCdEf1234567890GhIj.${secret}`), null);
  assert.equal(parseInvitationToken(`explorers.short.${secret}`), null);
  assert.equal(parseInvitationToken(`${token}.extra`), null);
});

test("invitation email matching and secret checks are exact and case-normalized", () => {
  assert.equal(
    normalizeInvitationEmail("  Person@Example.COM "),
    "person@example.com",
  );
  const digest = digestInvitationSecret("correct-secret");
  assert.equal(invitationSecretMatches(digest, "correct-secret"), true);
  assert.equal(invitationSecretMatches(digest, "incorrect-secret"), false);
  assert.equal(invitationSecretMatches("not-a-hex-digest", "correct-secret"), false);
});

test("normalizes Czech and international phone numbers", () => {
  assert.equal(normalizePhone("777 123 456"), "+420777123456");
  assert.equal(normalizePhone("+421 901 222 333"), "+421901222333");
  assert.equal(normalizePhone("00420 777 123 456"), "+420777123456");
});

test("drops unsupported explicit model proposals", () => {
  const result = validateProposalEvidence([
    {
      field: "address",
      value: "Prague",
      support: "explicit",
      evidence: [{ segmentIndex: 0, quote: "in Brno" }],
    },
    {
      field: "serviceType",
      value: "moving",
      support: "explicit",
      evidence: [{ segmentIndex: 0, quote: "move a wardrobe" }],
    },
  ], "Please move a wardrobe tomorrow.", [{ text: "Please move a wardrobe tomorrow." }]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.field, "serviceType");
});

test("processes only completion transitions and explicit backfills", () => {
  const timestamp = (value: number) => ({ toMillis: () => value });
  assert.equal(shouldProcessCallUpdate({ status: "processing" }, { status: "completed" }), true);
  assert.equal(shouldProcessCallUpdate(
    { status: "completed", crmBackfillRequestedAt: timestamp(1) },
    { status: "completed", crmBackfillRequestedAt: timestamp(1), crmStatus: "failed" },
  ), false);
  assert.equal(shouldProcessCallUpdate(
    { status: "completed", crmBackfillRequestedAt: timestamp(1) },
    { status: "completed", crmBackfillRequestedAt: timestamp(2) },
  ), true);
});

test("deduplicates active processing runs but permits a stale lease retry", () => {
  const now = 2_000_000;
  const timestamp = (value: number) => ({ toMillis: () => value });
  assert.equal(canStartProcessingRun(undefined, now), true);
  assert.equal(canStartProcessingRun({ status: "completed" }, now), false);
  assert.equal(canStartProcessingRun({ status: "running", updatedAt: timestamp(now - 1_000) }, now), false);
  assert.equal(canStartProcessingRun({ status: "running", updatedAt: timestamp(now - 16 * 60_000) }, now), true);
  assert.equal(canStartProcessingRun({ status: "failed" }, now), true);
});

test("normalizes legacy request statuses and expands new for queries", () => {
  assert.equal(normalizeRequestStatus("open"), "new");
  assert.equal(normalizeRequestStatus("waiting_customer"), "waiting_customer");
  assert.equal(normalizeRequestStatus("needs_review"), null);
  assert.deepEqual(storedStatusesFor(["new", "completed"]), ["new", "completed", "open"]);
});

test("allows only explicit service-request lifecycle transitions", () => {
  assert.equal(canTransitionRequestStatus("new", "in_progress"), true);
  assert.equal(canTransitionRequestStatus("new", "completed"), false);
  assert.equal(canTransitionRequestStatus("completed", "in_progress"), true);
  assert.deepEqual(allowedRequestTransitions("waiting_customer"), ["in_progress", "completed", "cancelled"]);
});

test("encrypts connector credentials with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptCredentials({ username: "line-a", password: "secret-value" }, key);
  assert.notEqual(encrypted.includes("secret-value"), true);
  assert.deepEqual(decryptCredentials(encrypted, key), {
    username: "line-a",
    password: "secret-value",
  });
  assert.throws(() => decryptCredentials(`${encrypted.slice(0, -2)}xx`, key));
});

test("keeps Google authorization state alive for a manual consent handoff", () => {
  assert.equal(calendarAuthorizationLifetimeMs, 60 * 60 * 1000);
});

test("revokes Google OAuth access with the provider revocation endpoint", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method || "GET",
      body: String(init?.body || ""),
    });
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(await revokeGoogleToken("refresh-token"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [{
    url: "https://oauth2.googleapis.com/revoke",
    method: "POST",
    body: "token=refresh-token",
  }]);
});

test("normalizes Odorik calls into connection-aware context items", () => {
  const resource = odorikResourceIdentity({ lineName: "Sales", to: "+420123456789" });
  assert.equal(resource.externalId, "line:Sales");
  assert.match(resource.resourceId, /^phone_[a-f0-9]{24}$/);
  assert.equal(
    odorikContextItemId("account-a", "call-1"),
    odorikContextItemId("account-a", "call-1"),
  );
  const item = odorikContextItem("call-1", {
    status: "completed",
    connectionId: "account-a",
    resourceId: resource.resourceId,
    from: "+420111222333",
    to: "+420123456789",
    transcript: "Please call me tomorrow.",
    summary: "Follow-up requested.",
  }, "explorers");
  assert.equal((item?.source as Record<string, unknown>).connectionId, "account-a");
  assert.equal(item?.kind, "call");
  assert.match(String(item?.text), /Please call me tomorrow/);
  assert.equal(odorikContextItem("call-2", { status: "uploaded" }, "explorers"), null);
});

test("builds the exact paste-ready Odorik recording destination", () => {
  assert.equal(
    odorikDestinationUrl(
      "https://ingest.example/webhooks/odorik/company/connection/recordings",
      "odorik-abcd",
      "secret_123",
    ),
    "https://odorik-abcd:secret_123@ingest.example/webhooks/odorik/company/connection/recordings!mp3",
  );
});

test("keeps Google Drive authorization state alive and defines drive readonly scope", () => {
  assert.equal(driveAuthorizationLifetimeMs, 60 * 60 * 1000);
  assert.deepEqual(driveScopes, ["https://www.googleapis.com/auth/drive.readonly"]);
});

test("returns Google OAuth to the requesting local app without allowing open redirects", () => {
  assert.equal(
    googleOAuthReturnUrl("http://localhost:5173"),
    "http://localhost:5173/sources",
  );
  assert.equal(
    googleOAuthReturnUrl("http://127.0.0.1:4173/anything"),
    "http://127.0.0.1:4173/sources",
  );
  assert.equal(
    googleOAuthReturnUrl("https://agent-erik-app.web.app/sources"),
    "https://agent-erik-app.web.app/sources",
  );
  assert.equal(
    googleOAuthReturnUrl("https://app.agenterik.cz/sources"),
    "https://app.agenterik.cz/sources",
  );
  assert.equal(
    googleOAuthReturnUrl("https://attacker.example"),
    "https://odorik-tx-260720-c58d.web.app/sources",
  );
  assert.equal(
    googleOAuthRedirectUri("https://agent-erik-app.web.app"),
    defaultGoogleRedirectUri,
  );
  assert.equal(
    googleOAuthRedirectUri("http://localhost:4173"),
    localGoogleRedirectUri,
  );
  assert.equal(
    googleOAuthRedirectUri("http://127.0.0.1:5173/sources"),
    "http://127.0.0.1:5173/oauth/google/callback",
  );
  assert.equal(
    googleOAuthRedirectUri("https://attacker.example"),
    defaultGoogleRedirectUri,
  );
});

test("validates partner form submissions and renders them without injecting markup", () => {
  const valid = partnerFormSchema.safeParse({
    name: "  Tomáš  ",
    email: "tomas@example.com",
    message: "  Ahoj  ",
  });
  assert.equal(valid.success, true);
  assert.equal(valid.success && valid.data.name, "Tomáš");
  assert.equal(valid.success && valid.data.message, "Ahoj");
  // Optional fields carry defaults so the email renderer never sees undefined.
  assert.equal(valid.success && valid.data.locale, "cs");
  assert.equal(valid.success && valid.data.website, "");

  assert.equal(partnerFormSchema.safeParse({ name: "A", email: "nope", message: "B" }).success, false);
  assert.equal(partnerFormSchema.safeParse({ name: "", email: "a@b.cz", message: "B" }).success, false);
  assert.equal(partnerFormSchema.safeParse({ name: "A", email: "a@b.cz", message: "" }).success, false);
  assert.equal(
    partnerFormSchema.safeParse({ name: "A", email: "a@b.cz", message: "x".repeat(4001) }).success,
    false,
  );

  const html = renderPartnerFormEmail({
    name: "<script>alert(1)</script>",
    email: "tomas@example.com",
    message: "Explorers & Co",
    locale: "cs",
    website: "",
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Explorers &amp; Co"));

  assert.equal(
    partnerFormSubject({
      name: "Tomáš",
      email: "tomas@example.com",
      message: "Ahoj",
      locale: "cs",
      website: "",
    }),
    "Pilotní partner: Tomáš",
  );
});

test("throttles repeated partner form submissions from one address", () => {
  const seen = new Map<string, number>();
  assert.equal(isThrottled("a@b.cz", 0, seen), false);
  assert.equal(isThrottled("a@b.cz", 30_000, seen), true);
  assert.equal(isThrottled("other@b.cz", 30_000, seen), false);
  // The window has passed, so the same address is allowed through again.
  assert.equal(isThrottled("a@b.cz", 61_000, seen), false);
});
