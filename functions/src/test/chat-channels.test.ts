import assert from "node:assert/strict";
import test from "node:test";

import { slackConversationsListUrl } from "../chat/channels.js";

test("H1 lists public member channels without silently requiring private-channel read", () => {
  const url = slackConversationsListUrl("next-page");
  assert.equal(url.pathname, "/api/conversations.list");
  assert.equal(url.searchParams.get("types"), "public_channel");
  assert.equal(url.searchParams.get("cursor"), "next-page");
  assert.equal(url.searchParams.get("exclude_archived"), "true");
});
