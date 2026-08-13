import { Timestamp } from "firebase-admin/firestore";

import { db } from "../firestore.js";
import { connectionRef } from "../connectors/google-oauth.js";
import { authorizedSlackNotify } from "../connectors/slack-oauth.js";
import { sha256Hex } from "../hash.js";
import { SlackApiError } from "./slack.js";

export const chatNotifyCapabilityId = "action.chat.notify" as const;

export type SelectableSlackChannel = {
  id: string;
  displayName: string;
  isPrivate: boolean;
};

export function chatChannelResourceId(channelId: string): string {
  return `channel_${sha256Hex(channelId).slice(0, 24)}`;
}

type SlackConversationsListResponse = {
  ok?: boolean;
  error?: string;
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_archived?: boolean;
    is_member?: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
};

export function slackConversationsListUrl(cursor = ""): URL {
  const url = new URL("https://slack.com/api/conversations.list");
  // `channels:read` covers public channels only. Including `private_channel`
  // makes Slack reject the whole request unless the app also holds
  // `groups:read`, which H1 deliberately does not request.
  url.searchParams.set("types", "public_channel");
  url.searchParams.set("exclude_archived", "true");
  url.searchParams.set("limit", "200");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

/**
 * List the channels Erik could actually post to.
 *
 * Filtered to `is_member`, which is not cosmetic: Slack only lets the bot post
 * where it has been invited, so a channel it is not in would fail at delivery with
 * `not_in_channel`. Offering it as a destination would be a card that promises a
 * capability it does not have. The invitation happening in Slack, by a person, is
 * also the consent boundary this capability leans on — stronger than a boundary
 * Erik merely holds.
 */
export async function listSlackChannels(input: {
  companyId: string;
  connectionId: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<SelectableSlackChannel[]> {
  const { botToken } = await authorizedSlackNotify(input);
  const channels: SelectableSlackChannel[] = [];
  let cursor = "";
  // Bounded: an operator picking a destination does not need an unbounded walk of a
  // very large workspace, and an unbounded loop here is a rate-limit incident.
  for (let page = 0; page < 10; page += 1) {
    const url = slackConversationsListUrl(cursor);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as SlackConversationsListResponse;
    if (!body.ok) {
      throw new SlackApiError({
        label: "Slack conversations.list",
        status: response.status,
        slackError: String(body.error || "unknown_error"),
      });
    }
    for (const channel of body.channels || []) {
      if (!channel.id || !channel.is_member || channel.is_archived) continue;
      channels.push({
        id: channel.id,
        displayName: channel.name ? `#${channel.name}` : channel.id,
        isPrivate: Boolean(channel.is_private),
      });
    }
    cursor = String(body.response_metadata?.next_cursor || "").trim();
    if (!cursor) break;
  }
  return channels.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Record which channels may receive notifications.
 *
 * This selection is the standing authorization for H1: an administrator decides
 * here, once, and that decision is what every later delivery rests on. Selecting a
 * channel Slack no longer offers fails rather than storing a destination that
 * cannot work.
 */
export async function selectSlackChannels(input: {
  companyId: string;
  connectionId: string;
  channelIds: string[];
  actorUid: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<{ selected: number }> {
  const database = input.database || db;
  const available = await listSlackChannels(input);
  const byId = new Map(available.map((channel) => [channel.id, channel]));
  const selectedIds = [...new Set(input.channelIds)];
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new Error(
      "One or more selected channels are no longer available. Invite Erik to the channel in Slack first.",
    );
  }
  const selectedSet = new Set(selectedIds);
  const connection = connectionRef(input.companyId, input.connectionId, database);
  const existing = await connection.collection("resources")
    .where("capabilityId", "==", chatNotifyCapabilityId)
    .get();
  const batch = database.batch();
  const now = Timestamp.now();
  for (const channelId of selectedIds) {
    const channel = byId.get(channelId)!;
    const resourceRef = connection.collection("resources").doc(chatChannelResourceId(channelId));
    const isNew = !existing.docs.some((resource) => resource.id === resourceRef.id);
    batch.set(resourceRef, {
      connectionId: input.connectionId,
      capabilityId: chatNotifyCapabilityId,
      resourceType: "channel",
      externalId: channel.id,
      displayName: channel.displayName,
      isPrivate: channel.isPrivate,
      status: "enabled",
      // A destination is not a source: nothing is read from it and nothing about it
      // enters the index, so it carries no audience. What may be *said* into it is
      // governed by the notification composition rule instead.
      ...(isNew ? { createdAt: now } : {}),
      authorizedBy: input.actorUid,
      updatedBy: input.actorUid,
      updatedAt: now,
    }, { merge: true });
  }
  for (const resource of existing.docs) {
    if (!selectedSet.has(String(resource.data().externalId))) {
      batch.delete(resource.ref);
    }
  }
  await batch.commit();
  return { selected: selectedIds.length };
}

/** The destinations a notification should currently be delivered to. */
export async function enabledSlackDestinations(input: {
  companyId: string;
  database?: FirebaseFirestore.Firestore;
}): Promise<Array<{ connectionId: string; channelId: string; displayName: string }>> {
  const database = input.database || db;
  const connections = await database
    .collection(`companies/${input.companyId}/connections`)
    .where("connectorId", "==", "slack")
    .get();
  const destinations: Array<{
    connectionId: string;
    channelId: string;
    displayName: string;
  }> = [];
  for (const connection of connections.docs) {
    if (!["active", "attention"].includes(String(connection.data().status))) continue;
    const resources = await connection.ref.collection("resources")
      .where("capabilityId", "==", chatNotifyCapabilityId)
      .get();
    for (const resource of resources.docs) {
      const data = resource.data();
      if (data.status !== "enabled" || !data.externalId) continue;
      destinations.push({
        connectionId: connection.id,
        channelId: String(data.externalId),
        displayName: String(data.displayName || data.externalId),
      });
    }
  }
  return destinations;
}
