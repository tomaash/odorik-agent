import type { ApprovalNotification } from "./notification.js";

/**
 * Slack answers `HTTP 200` with `{ ok: false, error }` for most failures, so the
 * status code alone never means success. Every response passes through here.
 */
export type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  permalink?: string;
};

export class SlackApiError extends Error {
  readonly slackError: string;
  readonly status: number;

  constructor(input: { label: string; status: number; slackError: string }) {
    super(`${input.label} failed (${input.status}): ${input.slackError}`);
    this.name = "SlackApiError";
    this.slackError = input.slackError;
    this.status = input.status;
  }
}

export class SlackDeliveryOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackDeliveryOutcomeUnknownError";
  }
}

/**
 * Slack errors that will never succeed on retry, however many times we ask.
 *
 * Everything absent from this list is treated as retryable or ambiguous, because
 * inventing optimism about an unrecognized provider error is how duplicate effects
 * happen.
 */
const terminalSlackErrors = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "no_permission",
  "missing_scope",
  "restricted_action",
  "msg_too_long",
]);

export function slackErrorIsTerminal(slackError: string): boolean {
  return terminalSlackErrors.has(slackError);
}

async function slackPost(
  label: string,
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse> {
  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SlackDeliveryOutcomeUnknownError(
      `Slack request outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A 429 or 5xx never reached the point of posting; a parse failure might have.
  if (response.status === 429 || response.status >= 500) {
    throw new SlackApiError({
      label,
      status: response.status,
      slackError: response.status === 429 ? "ratelimited" : "server_error",
    });
  }
  const payload = await response.json().catch(() => ({})) as SlackApiResponse;
  if (!payload.ok) {
    throw new SlackApiError({
      label,
      status: response.status,
      slackError: String(payload.error || "unknown_error"),
    });
  }
  return payload;
}

export async function postSlackText(input: {
  token: string;
  channelId: string;
  text: string;
  clientMessageId?: string;
  blocks?: unknown[];
}): Promise<{ channelId: string; messageTs: string }> {
  const posted = await slackPost("Slack chat.postMessage", "chat.postMessage", input.token, {
    channel: input.channelId,
    text: input.text.slice(0, 39_000),
    unfurl_links: false,
    unfurl_media: false,
    ...(input.clientMessageId ? { client_msg_id: input.clientMessageId } : {}),
    ...(input.blocks?.length ? { blocks: input.blocks } : {}),
  });
  const messageTs = String(posted.ts || "").trim();
  if (!messageTs) {
    throw new SlackDeliveryOutcomeUnknownError(
      "Slack accepted the message but did not return its timestamp.",
    );
  }
  return {
    channelId: String(posted.channel || input.channelId).trim(),
    messageTs,
  };
}

export async function updateSlackMessage(input: {
  token: string;
  channelId: string;
  messageTs: string;
  text: string;
  blocks?: unknown[];
}): Promise<void> {
  await slackPost("Slack chat.update", "chat.update", input.token, {
    channel: input.channelId,
    ts: input.messageTs,
    text: input.text.slice(0, 39_000),
    ...(input.blocks ? { blocks: input.blocks } : {}),
  });
}

export async function openSlackModal(input: {
  token: string;
  triggerId: string;
  view: Record<string, unknown>;
}): Promise<void> {
  await slackPost("Slack views.open", "views.open", input.token, {
    trigger_id: input.triggerId,
    view: input.view,
  });
}

export type SlackDeliveryResult = {
  channelId: string;
  messageTs: string;
  permalink: string | null;
};

/**
 * Post one approval notification and return what Slack recorded.
 *
 * The permalink is a convenience, not part of the effect: if `chat.getPermalink`
 * fails, the message still exists and the delivery still succeeded. Failing the
 * whole delivery over a link would invite a retry that posts a second message.
 */
export async function postApprovalNotification(input: {
  token: string;
  channelId: string;
  notification: ApprovalNotification;
}): Promise<SlackDeliveryResult> {
  const posted = await slackPost("Slack chat.postMessage", "chat.postMessage", input.token, {
    channel: input.channelId,
    text: `${input.notification.text}\n${input.notification.linkUrl}`,
    unfurl_links: false,
    unfurl_media: false,
  });
  const messageTs = String(posted.ts || "").trim();
  const channelId = String(posted.channel || input.channelId).trim();
  if (!messageTs) {
    throw new SlackDeliveryOutcomeUnknownError(
      "Slack accepted the message but did not return its timestamp.",
    );
  }

  let permalink: string | null = null;
  try {
    const link = await slackPost("Slack chat.getPermalink", "chat.getPermalink", input.token, {
      channel: channelId,
      message_ts: messageTs,
    });
    permalink = String(link.permalink || "").trim() || null;
  } catch {
    permalink = null;
  }
  return { channelId, messageTs, permalink };
}

/**
 * Classify a delivery failure the same way G3 classifies a Gmail failure.
 *
 * Slack has no dedupe key on `chat.postMessage`, and reconciling an ambiguous
 * delivery would need `channels:history` — read access to the whole channel, which
 * a notification-only capability has no business holding. So an unknown outcome
 * stays unknown and waits for a human, who can simply look at the channel. That is
 * a smaller cost than either a duplicate notice or a permanent read grant.
 */
export function classifySlackDeliveryFailure(
  error: unknown,
): "failed_safe_to_retry" | "outcome_unknown" {
  if (error instanceof SlackDeliveryOutcomeUnknownError) return "outcome_unknown";
  if (error instanceof SlackApiError) {
    if (slackErrorIsTerminal(error.slackError)) return "failed_safe_to_retry";
    // Rate limits and server errors are answered before Slack posts anything.
    if (error.slackError === "ratelimited" || error.slackError === "server_error") {
      return "failed_safe_to_retry";
    }
    return "outcome_unknown";
  }
  if (
    error instanceof Error
    && /timeout|network|fetch failed|ECONNRESET|aborted/i.test(error.message)
  ) {
    // The request may have been delivered before the connection died.
    return "outcome_unknown";
  }
  return "outcome_unknown";
}
