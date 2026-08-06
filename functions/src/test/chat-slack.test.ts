import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySlackDeliveryFailure,
  postApprovalNotification,
  SlackApiError,
  SlackDeliveryOutcomeUnknownError,
} from "../chat/slack.js";

const notification = {
  approvalId: "approval-1",
  text: "Approval waiting: Email draft — Tomáš Holas decides",
  linkUrl: "https://app.agenterik.cz/cases/case-9",
};

type SlackRoute = (method: string, body: Record<string, unknown>) => {
  status: number;
  body: unknown;
};

function stubSlack(route: SlackRoute): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(request)).pathname.replace("/api/", "");
    const parsed = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    const { status, body } = route(method, parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("a delivery records the message Slack actually kept", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stubSlack((method, body) => {
    sent.push({ method, ...body });
    if (method === "chat.postMessage") {
      return { status: 200, body: { ok: true, ts: "1717.0001", channel: "C123" } };
    }
    return {
      status: 200,
      body: { ok: true, permalink: "https://acme.slack.com/archives/C123/p17170001" },
    };
  });
  try {
    const result = await postApprovalNotification({
      token: "xoxb-test",
      channelId: "C123",
      notification,
    });
    assert.deepEqual(result, {
      channelId: "C123",
      messageTs: "1717.0001",
      permalink: "https://acme.slack.com/archives/C123/p17170001",
    });
    assert.equal(sent[0]?.text, `${notification.text}\n${notification.linkUrl}`);
    assert.equal(sent[0]?.unfurl_links, false, "a pointer must not unfurl into a preview");
  } finally {
    restore();
  }
});

test("ok:false on an HTTP 200 is a failure, not a delivery", async () => {
  const restore = stubSlack(() => ({
    status: 200,
    body: { ok: false, error: "channel_not_found" },
  }));
  try {
    await assert.rejects(
      () => postApprovalNotification({ token: "xoxb-test", channelId: "C404", notification }),
      (error: unknown) => error instanceof SlackApiError
        && error.slackError === "channel_not_found",
    );
  } finally {
    restore();
  }
});

test("a missing permalink does not undo a delivered message", async () => {
  const restore = stubSlack((method) => {
    if (method === "chat.postMessage") {
      return { status: 200, body: { ok: true, ts: "1717.0002", channel: "C123" } };
    }
    return { status: 200, body: { ok: false, error: "message_not_found" } };
  });
  try {
    const result = await postApprovalNotification({
      token: "xoxb-test",
      channelId: "C123",
      notification,
    });
    assert.equal(result.messageTs, "1717.0002");
    assert.equal(result.permalink, null, "the message exists; only its link is missing");
  } finally {
    restore();
  }
});

test("an accepted post with no timestamp is an unknown outcome", async () => {
  const restore = stubSlack(() => ({ status: 200, body: { ok: true, channel: "C123" } }));
  try {
    await assert.rejects(
      () => postApprovalNotification({ token: "xoxb-test", channelId: "C123", notification }),
      SlackDeliveryOutcomeUnknownError,
    );
  } finally {
    restore();
  }
});

test("failures are classified by whether Slack could have posted", () => {
  const retryable = ["channel_not_found", "not_in_channel", "missing_scope", "invalid_auth"];
  for (const slackError of retryable) {
    assert.equal(
      classifySlackDeliveryFailure(
        new SlackApiError({ label: "post", status: 200, slackError }),
      ),
      "failed_safe_to_retry",
      `${slackError} is answered before anything is posted`,
    );
  }
  for (const slackError of ["ratelimited", "server_error"]) {
    assert.equal(
      classifySlackDeliveryFailure(
        new SlackApiError({ label: "post", status: 429, slackError }),
      ),
      "failed_safe_to_retry",
    );
  }
  assert.equal(
    classifySlackDeliveryFailure(new Error("fetch failed")),
    "outcome_unknown",
    "a dead connection may have carried the message",
  );
  assert.equal(
    classifySlackDeliveryFailure(
      new SlackApiError({ label: "post", status: 200, slackError: "some_new_error" }),
    ),
    "outcome_unknown",
    "an unrecognized provider error is not an excuse for optimism",
  );
});
