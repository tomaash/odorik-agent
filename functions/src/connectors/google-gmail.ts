import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import { audienceEquals, normalizeResourceAudience } from "../access.js";
import {
  authorizedGoogleCapability,
  GoogleApiError,
  connectionRef,
  googleGet,
} from "./google-oauth.js";
import { mailScopes } from "./registry.js";
import {
  commitConnectorSyncWrites,
  connectorSyncRunResultFromData,
  createConnectorSyncRun,
  executeConnectorSyncRun,
  listDueConnectorSyncRuns,
  replayableConnectorSyncResources,
  type ConnectorSyncDependencies,
  type ConnectorSyncExecutionResource,
  type ConnectorSyncResourceCompletion,
  type ConnectorSyncRunResult,
  type ConnectorSyncTrigger,
} from "./sync-runtime.js";

export { mailScopes };
const mailCapabilityId = "context.mail.read_scoped" as const;
const mailDisplayName = "Gmail";

/**
 * Initial import boundary. Gmail has no "everything since a cursor" primitive for a
 * first sync, so the import is explicitly bounded rather than unbounded-and-truncated.
 */
export const mailInitialImportDays = 90;

/** Matches the Drive extraction ceiling so one message cannot dominate the index. */
const mailBodyCharacterLimit = 50_000;

type GmailLabel = {
  id?: string;
  name?: string;
  type?: string;
  messagesTotal?: number;
  labelListVisibility?: string;
};

type GmailLabelsResponse = { labels?: GmailLabel[] };

type GmailHeader = { name?: string; value?: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
};

type GmailMessageListResponse = {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
};

type GmailHistoryResponse = {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: { id?: string } }>;
    messagesDeleted?: Array<{ message?: { id?: string } }>;
    labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
    labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
};

type GmailProfileResponse = { emailAddress?: string; historyId?: string };

export type SelectableMailLabel = {
  id: string;
  displayName: string;
  type: string;
  messageCount: number | null;
  selected: boolean;
};

export function mailResourceId(labelId: string): string {
  return `mail_${sha256Hex(labelId).slice(0, 24)}`;
}

/**
 * One context item per Workspace connection and Gmail message ID. A message carrying two
 * selected labels is still one stored observation; `source.resourceId` names the label
 * that currently owns it, mirroring the C5 Drive ownership rule.
 */
export function mailContextItemId(connectionId: string, messageId: string): string {
  return `mail_${sha256Hex(`${connectionId}:${messageId}`).slice(0, 32)}`;
}

function contextItems(
  companyId: string,
  database: FirebaseFirestore.Firestore = db,
) {
  return database.collection(companyCollectionPath(companyId, "contextItems"));
}

function headerValue(payload: GmailPart | undefined, name: string): string {
  const match = (payload?.headers || []).find(
    (header) => String(header.name || "").toLowerCase() === name.toLowerCase(),
  );
  return match?.value || "";
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8");
}

/** Strip tags well enough for retrieval; this is search text, not a rendered mail view. */
function htmlToPlainText(html: string): string {
  return html
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

/**
 * Prefer a real text/plain part and fall back to stripped HTML. Attachments contribute
 * their filename only — G1 stores attachment references, never their content.
 */
export function mailMessageBody(payload: GmailPart | undefined): {
  text: string;
  attachmentNames: string[];
} {
  const attachmentNames: string[] = [];
  let plain = "";
  let html = "";
  const visit = (part: GmailPart | undefined): void => {
    if (!part) return;
    const mimeType = String(part.mimeType || "");
    if (part.filename) {
      attachmentNames.push(part.filename);
      return;
    }
    const data = part.body?.data;
    if (data) {
      if (mimeType === "text/plain") plain += (plain ? "\n" : "") + decodeBase64Url(data);
      else if (mimeType === "text/html") html += (html ? "\n" : "") + decodeBase64Url(data);
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  const text = plain.trim() || htmlToPlainText(html);
  return { text: text.slice(0, mailBodyCharacterLimit), attachmentNames };
}

function addressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Strip angle brackets and whitespace from a Message-ID header for Gmail search.
 * Gmail's `rfc822msgid:` operator accepts the id with or without `<>`; we store
 * the bare form and encode it into the URL.
 */
export function normalizeRfc822MessageId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^<|>$/g, "").trim();
  return bare || null;
}

/**
 * Gmail has no reliable public deep link for a specific message.
 *
 * - `#all/{apiMessageId}` does not open the current Gmail UI.
 * - `#search/rfc822msgid:…` often fails for real Message-IDs: Gmail treats `-` as a
 *   token separator in search (UUID-style ids like `9d57e3eb-af74-…@host` degrade to
 *   unrelated results), and `/u/0` may not be the connected mailbox.
 *
 * We still store `rfc822MessageId` for identity/debug; do not emit an Open URL.
 */
export function mailMessageSourceUrl(_input: {
  rfc822MessageId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
}): string | null {
  return null;
}

export function mailMessageContextItem(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  labelId: string;
  labelName: string;
  message: GmailMessage;
  observedAt?: Timestamp;
  audience?: unknown;
  audienceRevision?: number;
  observation?: {
    runId: string;
    trigger: ConnectorSyncTrigger;
    providerUpdatedAt: string | null;
    providerVersion: string;
    freshnessEligible: boolean;
  };
}): Record<string, unknown> | null {
  if (!input.message.id) return null;
  const payload = input.message.payload;
  const subject = headerValue(payload, "Subject");
  const from = headerValue(payload, "From");
  const to = headerValue(payload, "To");
  const cc = headerValue(payload, "Cc");
  const dateHeader = headerValue(payload, "Date");
  const rfc822MessageId = normalizeRfc822MessageId(headerValue(payload, "Message-ID"));
  const sourceUrl = mailMessageSourceUrl({
    rfc822MessageId,
    threadId: input.message.threadId || null,
    messageId: input.message.id,
  });
  const { text, attachmentNames } = mailMessageBody(payload);
  const participantRefs = [
    ...addressList(from),
    ...addressList(to),
    ...addressList(cc),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const occurredAt = input.message.internalDate
    ? new Date(Number(input.message.internalDate)).toISOString()
    : (dateHeader ? new Date(dateHeader).toISOString() : null);
  const title = subject || "Untitled email";
  const body = [
    `Label: ${input.labelName}`,
    from && `From: ${from}`,
    to && `To: ${to}`,
    cc && `Cc: ${cc}`,
    occurredAt && `Sent: ${occurredAt}`,
    attachmentNames.length && `Attachments: ${attachmentNames.join(", ")}`,
    text && `Body:\n${text}`,
  ].filter(Boolean).join("\n");
  const checksum = sha256Hex(JSON.stringify({
    subject,
    from,
    to,
    cc,
    text,
    attachmentNames,
    labelIds: input.message.labelIds || [],
    rfc822MessageId,
    sourceUrl,
  }));
  return {
    companyId: input.companyId,
    kind: "mail.message",
    source: {
      providerId: "google",
      capabilityId: mailCapabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: input.message.id,
      version: input.message.historyId || checksum.slice(0, 16),
    },
    title,
    text: body,
    occurredAt,
    observedAt: input.observedAt || Timestamp.now(),
    artifactRefs: [],
    participantRefs,
    access: normalizeResourceAudience(input.audience),
    accessRevision: Math.max(1, Number(input.audienceRevision || 1)),
    metadata: {
      labelId: input.labelId,
      labelName: input.labelName,
      threadId: input.message.threadId || null,
      messageId: input.message.id,
      rfc822MessageId,
      from: from || null,
      to: addressList(to),
      cc: addressList(cc),
      subject: subject || null,
      snippet: input.message.snippet || null,
      labelIds: input.message.labelIds || [],
      // Names and provider references only. G1 deliberately does not ingest attachment
      // content, so nothing here implies the bytes were read.
      attachmentNames,
      hasAttachments: attachmentNames.length > 0,
      sourceUrl,
    },
    provenance: {
      rawRef: `google-gmail/${input.labelId}/messages/${input.message.id}`,
      checksum,
      ingestionVersion: "google-gmail-v2",
    },
    observation: input.observation ? {
      ...input.observation,
      observedAt: input.observedAt || Timestamp.now(),
    } : null,
    indexingEnabled: true,
  };
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
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

export function mailContextMatches(
  existing: FirebaseFirestore.DocumentData | undefined,
  next: Record<string, unknown>,
): boolean {
  const existingSource = nestedRecord(existing?.source);
  const nextSource = nestedRecord(next.source);
  const existingProvenance = nestedRecord(existing?.provenance);
  const nextProvenance = nestedRecord(next.provenance);
  const existingMeta = nestedRecord(existing?.metadata);
  const nextMeta = nestedRecord(next.metadata);
  return existingSource.version === nextSource.version
    && existingSource.resourceId === nextSource.resourceId
    && existingProvenance.checksum === nextProvenance.checksum
    && existing?.title === next.title
    && existing?.text === next.text
    // sourceUrl / rfc822 id are presentation, not body, but must rewrite on re-sync
    // when we improve deep links (v1 used a non-working #all/messageId path).
    && existingMeta.sourceUrl === nextMeta.sourceUrl
    && existingMeta.rfc822MessageId === nextMeta.rfc822MessageId
    && audienceEquals(existing?.access, next.access)
    && Number(existing?.accessRevision || 1) === Number(next.accessRevision || 1)
    && existing?.indexingEnabled !== false;
}

export function mailHistoryIdForRun(
  resource: Record<string, unknown>,
  forceFullSync = false,
): string {
  if (forceFullSync || resource.requiresFullSync === true) return "";
  return typeof resource.historyId === "string" ? resource.historyId : "";
}

export function mailMessagesUrl(input: {
  labelId: string;
  pageToken?: string;
  newerThanDays: number;
}): URL {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", "500");
  url.searchParams.set("labelIds", input.labelId);
  url.searchParams.set("q", `newer_than:${input.newerThanDays}d`);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

export function mailHistoryUrl(input: {
  labelId: string;
  startHistoryId: string;
  pageToken?: string;
}): URL {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("maxResults", "500");
  url.searchParams.set("startHistoryId", input.startHistoryId);
  url.searchParams.set("labelId", input.labelId);
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

async function authorizedConnection(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  database?: FirebaseFirestore.Firestore;
}) {
  return authorizedGoogleCapability(mailCapabilityId, input);
}

export async function listGmailLabels(input: {
  companyId: string;
  connectionId: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<SelectableMailLabel[]> {
  const { accessToken, connection } = await authorizedConnection(input);
  const [labels, resources] = await Promise.all([
    googleGet<GmailLabelsResponse>(
      mailDisplayName,
      new URL("https://gmail.googleapis.com/gmail/v1/users/me/labels"),
      accessToken,
    ),
    connection.ref.collection("resources")
      .where("capabilityId", "==", mailCapabilityId)
      .get(),
  ]);
  const selectedIds = new Set(
    resources.docs
      .filter((resource) => resource.data().status === "enabled")
      .map((resource) => String(resource.data().externalId)),
  );
  return (labels.labels || [])
    .filter((label) => label.id && label.labelListVisibility !== "labelHide")
    .map((label) => ({
      id: String(label.id),
      displayName: label.name || String(label.id),
      type: label.type || "user",
      messageCount: typeof label.messagesTotal === "number" ? label.messagesTotal : null,
      selected: selectedIds.has(String(label.id)),
    }))
    .sort((a, b) => Number(a.type === "system") - Number(b.type === "system")
      || a.displayName.localeCompare(b.displayName));
}

async function fetchMessage(
  messageId: string,
  accessToken: string,
): Promise<GmailMessage | null> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set("format", "full");
  try {
    return await googleGet<GmailMessage>(mailDisplayName, url, accessToken);
  } catch (error) {
    // A message deleted between enumeration and fetch is not a sync failure.
    if (error instanceof GoogleApiError && error.status === 404) return null;
    throw error;
  }
}

async function syncMailResource(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: import("./sync-runtime.js").ConnectorSyncLease;
  dependencies: ConnectorSyncDependencies;
  forceFullSync?: boolean;
  trigger: ConnectorSyncTrigger;
}): Promise<ConnectorSyncResourceCompletion> {
  const data = input.resource.data;
  const labelId = String(data.externalId);
  const labelName = String(data.displayName || labelId);
  const storedHistoryId = mailHistoryIdForRun(data, input.forceFullSync);
  const isFullSync = !storedHistoryId;
  const now = input.dependencies.now?.() || Timestamp.now();
  const existing = await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .get();
  const existingById = new Map(existing.docs.map((item) => [item.id, item]));
  const observedContextIds = new Set<string>();
  let changes = 0;

  // Candidate message IDs, plus the IDs a history page says left the label. A full sync
  // enumerates the label; an incremental sync replays history from the stored cursor.
  const candidateIds = new Set<string>();
  const removedIds = new Set<string>();
  let nextHistoryId = "";

  if (isFullSync) {
    let pageToken = "";
    do {
      const page = await googleGet<GmailMessageListResponse>(
        mailDisplayName,
        mailMessagesUrl({ labelId, pageToken, newerThanDays: mailInitialImportDays }),
        input.accessToken,
      );
      for (const message of page.messages || []) {
        if (message.id) candidateIds.add(message.id);
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    // The profile historyId is the correct cursor origin for a rebuild: it is the
    // mailbox state as of this enumeration, so the next incremental run resumes here.
    const profile = await googleGet<GmailProfileResponse>(
      mailDisplayName,
      new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile"),
      input.accessToken,
    );
    nextHistoryId = profile.historyId || "";
  } else {
    let pageToken = "";
    do {
      let page: GmailHistoryResponse;
      try {
        page = await googleGet<GmailHistoryResponse>(
          mailDisplayName,
          mailHistoryUrl({ labelId, startHistoryId: storedHistoryId, pageToken }),
          input.accessToken,
        );
      } catch (error) {
        // Gmail expires history records, and an External app in Testing status loses its
        // refresh token every seven days, so a multi-day gap makes this the common path
        // rather than a rare one. Mirror the Calendar 410 contract: rebuild completely
        // instead of overlaying a partial history onto stale context.
        if (error instanceof GoogleApiError && error.status === 404) {
          return syncMailResource({ ...input, forceFullSync: true });
        }
        throw error;
      }
      for (const entry of page.history || []) {
        for (const added of entry.messagesAdded || []) {
          if (added.message?.id) candidateIds.add(added.message.id);
        }
        for (const labelled of entry.labelsAdded || []) {
          if (labelled.message?.id) candidateIds.add(labelled.message.id);
        }
        for (const deleted of entry.messagesDeleted || []) {
          if (deleted.message?.id) removedIds.add(deleted.message.id);
        }
        for (const unlabelled of entry.labelsRemoved || []) {
          // Only a removal of *this* label takes the message out of the resource.
          if (unlabelled.message?.id && (unlabelled.labelIds || []).includes(labelId)) {
            removedIds.add(unlabelled.message.id);
          }
        }
      }
      pageToken = page.nextPageToken || "";
      nextHistoryId = page.historyId || nextHistoryId;
    } while (pageToken);
  }

  const writes: Array<{
    ref: FirebaseFirestore.DocumentReference;
    value: Record<string, unknown> | null;
  }> = [];

  for (const messageId of candidateIds) {
    const message = await fetchMessage(messageId, input.accessToken);
    const itemRef = input.dependencies.database.doc(companyDocumentPath(
      input.companyId,
      "contextItems",
      mailContextItemId(input.connectionId, messageId),
    ));
    // A message that no longer carries the label leaves the resource even if history
    // reported it as added earlier in the same page sequence.
    const stillLabelled = message?.labelIds?.includes(labelId) ?? false;
    if (!message || !stillLabelled) {
      if (existingById.has(itemRef.id)) {
        writes.push({ ref: itemRef, value: null });
        changes += 1;
      }
      continue;
    }
    observedContextIds.add(itemRef.id);
    const contextItem = mailMessageContextItem({
      companyId: input.companyId,
      connectionId: input.connectionId,
      resourceId: input.resource.id,
      labelId,
      labelName,
      message,
      observedAt: now,
      audience: input.resource.data.audience,
      audienceRevision: Number(input.resource.data.audienceRevision || 1),
      observation: {
        runId: input.lease.runId,
        trigger: input.trigger,
        providerUpdatedAt: message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : null,
        providerVersion: message.historyId
          || sha256Hex(JSON.stringify(message)).slice(0, 16),
        freshnessEligible: (() => {
          const providerUpdatedAt = message.internalDate
            ? Number(message.internalDate)
            : null;
          const lastSuccessAt = timestampMillis(
            nestedRecord(input.resource.data.sync).lastSuccessAt
              || input.resource.data.lastSyncAt,
          );
          return providerUpdatedAt !== null
            && lastSuccessAt !== null
            && providerUpdatedAt >= lastSuccessAt;
        })(),
      },
    });
    if (contextItem) {
      if (mailContextMatches(existingById.get(itemRef.id)?.data(), contextItem)) continue;
      writes.push({ ref: itemRef, value: contextItem });
      changes += 1;
    }
  }

  for (const messageId of removedIds) {
    if (candidateIds.has(messageId)) continue;
    const itemRef = input.dependencies.database.doc(companyDocumentPath(
      input.companyId,
      "contextItems",
      mailContextItemId(input.connectionId, messageId),
    ));
    if (existingById.has(itemRef.id)) {
      writes.push({ ref: itemRef, value: null });
      changes += 1;
    }
  }

  for (let offset = 0; offset < writes.length; offset += 400) {
    const pageWrites = writes.slice(offset, offset + 400);
    await commitConnectorSyncWrites({
      companyId: input.companyId,
      connectionId: input.connectionId,
      resourceId: input.resource.id,
      lease: input.lease,
      apply: (transaction) => {
        for (const write of pageWrites) {
          if (write.value) transaction.set(write.ref, write.value, { merge: false });
          else transaction.delete(write.ref);
        }
      },
    }, input.dependencies);
  }

  // Only a complete enumeration may stale-delete. An incremental run has seen a delta,
  // not the label's full membership, so absence from it proves nothing.
  if (isFullSync) {
    const staleItems = existing.docs.filter((item) => !observedContextIds.has(item.id));
    for (let offset = 0; offset < staleItems.length; offset += 400) {
      const pageDeletes = staleItems.slice(offset, offset + 400);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => {
          for (const item of pageDeletes) transaction.delete(item.ref);
        },
      }, input.dependencies);
    }
    changes += staleItems.length;
  }

  const itemCount = (await contextItems(input.companyId, input.dependencies.database)
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count()
    .get()).data().count;
  const finalHistoryId = nextHistoryId
    || (storedHistoryId ? String(data.historyId || "") : "");
  return {
    changes,
    itemCount,
    cursorAfter: finalHistoryId || null,
    cursorMode: storedHistoryId ? "incremental" : "full",
    resourcePatch: {
      // Never restore an obsolete cursor after a rebuild; a null cursor keeps the next
      // run full rather than resuming from history Gmail has already expired.
      historyId: finalHistoryId || null,
      requiresFullSync: false,
    },
  };
}

type MailSyncInput = {
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
  now?: () => Timestamp;
};

export type MailSyncResult = ConnectorSyncRunResult & {
  labels: number;
};

function mailRunResult(
  runId: string,
  data: FirebaseFirestore.DocumentData,
): MailSyncResult {
  const result = connectorSyncRunResultFromData(runId, data);
  return { ...result, labels: result.resources };
}

async function executeGoogleGmailSyncRun(
  input: MailSyncInput & { runId: string },
): Promise<MailSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const completed = await executeConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: mailCapabilityId,
    serviceId: "mail",
    prepare: () => authorizedConnection(input),
    listResources: async ({ connection }) => {
      const snapshot = await connection.ref.collection("resources")
        .where("capabilityId", "==", mailCapabilityId)
        .where("status", "==", "enabled")
        .get();
      return snapshot.docs.map((resource) => ({ id: resource.id, data: resource.data() }));
    },
    cursorBefore: (resource) => mailHistoryIdForRun(resource.data) || null,
    cursorMode: (resource) => mailHistoryIdForRun(resource.data) ? "incremental" : "full",
    synchronizeResource: ({
      preparation,
      resource,
      trigger,
      lease,
      dependencies: runDependencies,
    }) => (
      syncMailResource({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resource,
        accessToken: preparation.accessToken,
        lease,
        trigger,
        dependencies: runDependencies,
      })
    ),
  }, dependencies);
  return { ...completed, labels: completed.resources };
}

export async function syncGoogleGmailConnection(
  input: MailSyncInput,
): Promise<MailSyncResult> {
  const database = input.database || db;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const connection = database.doc(
    companyDocumentPath(input.companyId, "connections", input.connectionId),
  );
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", mailCapabilityId)
    .where("status", "==", "enabled")
    .get();
  const selectedResourceIds = input.resourceIds?.filter(
    (resourceId) => resources.docs.some((resource) => resource.id === resourceId),
  ) || resources.docs.map((resource) => resource.id);
  const created = await createConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId: mailCapabilityId,
    serviceId: "mail",
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy,
    resourceIds: selectedResourceIds,
    replayOfRunId: input.replayOfRunId,
  }, dependencies);
  if (!created.created || created.deferred) {
    const current = await connection.collection("syncRuns").doc(created.runId).get();
    return mailRunResult(created.runId, current.data() || {});
  }
  return executeGoogleGmailSyncRun({ ...input, runId: created.runId });
}

export async function selectGmailLabels(input: {
  companyId: string;
  connectionId: string;
  labelIds: string[];
  actorUid: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<{ selected: number } & MailSyncResult> {
  const labels = await listGmailLabels(input);
  const byId = new Map(labels.map((label) => [label.id, label]));
  const selectedIds = [...new Set(input.labelIds)];
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new Error("One or more selected labels are no longer accessible");
  }
  const selectedSet = new Set(selectedIds);
  const connection = connectionRef(input.companyId, input.connectionId);
  const resources = await connection.collection("resources")
    .where("capabilityId", "==", mailCapabilityId)
    .get();
  const batch = db.batch();
  const now = Timestamp.now();
  for (const labelId of selectedIds) {
    const label = byId.get(labelId)!;
    const resourceRef = connection.collection("resources").doc(mailResourceId(label.id));
    const isNew = !resources.docs.some((resource) => resource.id === resourceRef.id);
    batch.set(resourceRef, {
      connectionId: input.connectionId,
      capabilityId: mailCapabilityId,
      resourceType: "label",
      externalId: label.id,
      displayName: label.displayName,
      labelType: label.type,
      status: "enabled",
      // Mail defaults to the connecting member only, deliberately diverging from the
      // company-visible Calendar/Drive default. A mailbox is personal by default, and
      // broadening it goes through the C4 audience action with its confirmation.
      ...(isNew
        ? {
          audience: { visibility: "restricted", memberIds: [input.actorUid] },
          audienceRevision: 1,
          createdAt: now,
        }
        : {}),
      updatedBy: input.actorUid,
      updatedAt: now,
    }, { merge: true });
  }
  const removedResources = resources.docs.filter(
    (resource) => !selectedSet.has(String(resource.data().externalId)),
  );
  for (const resource of removedResources) batch.delete(resource.ref);
  await batch.commit();

  for (const resource of removedResources) {
    const items = await contextItems(input.companyId)
      .where("source.connectionId", "==", input.connectionId)
      .where("source.resourceId", "==", resource.id)
      .get();
    for (let offset = 0; offset < items.docs.length; offset += 400) {
      const deleteBatch = db.batch();
      for (const item of items.docs.slice(offset, offset + 400)) deleteBatch.delete(item.ref);
      await deleteBatch.commit();
    }
  }
  const result = await syncGoogleGmailConnection({
    ...input,
    trigger: "selection",
    requestedBy: input.actorUid,
  });
  return { selected: selectedIds.length, ...result };
}

export async function replayGoogleGmailSyncRun(input: {
  companyId: string;
  connectionId: string;
  runId: string;
  actorUid: string;
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<MailSyncResult> {
  const failedResourceIds = await replayableConnectorSyncResources({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId: mailCapabilityId,
    serviceId: "mail",
  }, { database: db });
  return syncGoogleGmailConnection({
    ...input,
    trigger: "operator_replay",
    requestedBy: input.actorUid,
    replayOfRunId: input.runId,
    resourceIds: failedResourceIds,
  });
}

export async function retryDueGoogleGmailSyncRuns(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
  limit?: number;
  database?: FirebaseFirestore.Firestore;
  now?: () => Timestamp;
}): Promise<Array<MailSyncResult & { companyId: string; connectionId: string }>> {
  const database = input.database || db;
  const dependencies = { database, now: input.now };
  const due = await listDueConnectorSyncRuns(
    { serviceId: "mail", limit: input.limit },
    dependencies,
  );
  const results: Array<MailSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of due) {
    const result = await executeGoogleGmailSyncRun({
      companyId: run.companyId,
      connectionId: run.connectionId,
      runId: run.runId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      credentialKey: input.credentialKey,
      trigger: "retry",
      database,
      now: input.now,
    });
    results.push({ companyId: run.companyId, connectionId: run.connectionId, ...result });
  }
  return results;
}

export async function syncAllGoogleGmailConnections(input: {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
}): Promise<Array<{ companyId: string; connectionId: string; ok: boolean; error?: string }>> {
  const companies = await db.collection("companies").get();
  const results: Array<{
    companyId: string;
    connectionId: string;
    ok: boolean;
    error?: string;
  }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "google_workspace")
      .where("status", "in", ["active", "attention"])
      .get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc("mail").get();
      if (!capability.exists || capability.data()?.status !== "active") continue;
      try {
        const run = await syncGoogleGmailConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
          trigger: "scheduled",
          requestedBy: "scheduler:mail",
        });
        results.push({
          companyId: company.id,
          connectionId: connection.id,
          ok: run.status !== "attention",
          ...(run.status === "attention"
            ? { error: "Gmail synchronization needs attention" }
            : {}),
        });
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
