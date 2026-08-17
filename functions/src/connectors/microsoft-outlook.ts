import { Timestamp } from "firebase-admin/firestore";

import { normalizeResourceAudience } from "../access.js";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { companyCollectionPath, companyDocumentPath } from "../tenancy.js";
import {
  authorizedMicrosoftCapability,
  MicrosoftAuthorizationError,
} from "./microsoft-oauth.js";
import {
  commitConnectorSyncWrites,
  connectorSyncRunResultFromData,
  createConnectorSyncRun,
  executeConnectorSyncRun,
  listDueConnectorSyncRuns,
  replayableConnectorSyncResources,
  type ConnectorSyncDependencies,
  type ConnectorSyncExecutionResource,
  type ConnectorSyncLease,
  type ConnectorSyncResourceCompletion,
  type ConnectorSyncRunResult,
  type ConnectorSyncTrigger,
} from "./sync-runtime.js";

const capabilityId = "context.mail.read_scoped" as const;
const serviceId = "mail" as const;
export const outlookInboxResourceId = "outlook_inbox";
export const outlookInitialImportDays = 90;
const bodyCharacterLimit = 50_000;

type EmailAddress = { name?: string; address?: string };
type Recipient = { emailAddress?: EmailAddress };

export type OutlookMessage = {
  id?: string;
  changeKey?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  webLink?: string;
  "@removed"?: { reason?: string };
};

type DeltaPage = {
  value?: OutlookMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  error?: { code?: string; message?: string };
};

export class MicrosoftGraphMailError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Microsoft Graph mail failed (${status}, ${code}): ${message}`);
    this.name = "MicrosoftGraphMailError";
  }
}

function plainText(body?: OutlookMessage["body"]): string {
  const content = String(body?.content || "");
  if (String(body?.contentType || "").toLocaleLowerCase() !== "html") {
    return content.slice(0, bodyCharacterLimit).trim();
  }
  return content
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
    .slice(0, bodyCharacterLimit)
    .trim();
}

function address(recipient?: Recipient): string {
  return String(recipient?.emailAddress?.address || "").trim().toLocaleLowerCase();
}

function addresses(recipients?: Recipient[]): string[] {
  return (recipients || []).map(address).filter(Boolean);
}

export function outlookMailContextItemId(connectionId: string, messageId: string): string {
  return `mail_${sha256Hex(`${connectionId}:${messageId}`).slice(0, 32)}`;
}

export function outlookMessageContextItem(input: {
  companyId: string;
  connectionId: string;
  resourceId: string;
  message: OutlookMessage;
  audience?: unknown;
  audienceRevision?: number;
  observedAt?: Timestamp;
  observation?: {
    runId: string;
    trigger: ConnectorSyncTrigger;
    providerUpdatedAt: string | null;
    providerVersion: string;
    freshnessEligible: boolean;
  };
}): Record<string, unknown> | null {
  const messageId = String(input.message.id || "");
  if (!messageId || input.message["@removed"] || input.message.isDraft) return null;
  const subject = String(input.message.subject || "").trim();
  const from = address(input.message.from);
  const to = addresses(input.message.toRecipients);
  const cc = addresses(input.message.ccRecipients);
  const text = plainText(input.message.body) || String(input.message.bodyPreview || "").trim();
  const occurredAt = input.message.receivedDateTime || input.message.sentDateTime || null;
  const participantRefs = [...new Set([from, ...to, ...cc].filter(Boolean))];
  const checksum = sha256Hex(JSON.stringify({
    subject, from, to, cc, text,
    hasAttachments: Boolean(input.message.hasAttachments),
    internetMessageId: input.message.internetMessageId || null,
    webLink: input.message.webLink || null,
  }));
  return {
    companyId: input.companyId,
    kind: "mail.message",
    source: {
      providerId: "microsoft",
      capabilityId,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      externalId: messageId,
      version: input.message.changeKey || checksum.slice(0, 16),
    },
    title: subject || "Untitled email",
    text: [
      "Folder: Inbox",
      from && `From: ${from}`,
      to.length && `To: ${to.join(", ")}`,
      cc.length && `Cc: ${cc.join(", ")}`,
      occurredAt && `Received: ${occurredAt}`,
      input.message.hasAttachments && "Attachments: present (content not imported)",
      text && `Body:\n${text}`,
    ].filter(Boolean).join("\n"),
    occurredAt,
    observedAt: input.observedAt || Timestamp.now(),
    artifactRefs: [],
    participantRefs,
    access: normalizeResourceAudience(input.audience),
    accessRevision: Math.max(1, Number(input.audienceRevision || 1)),
    metadata: {
      folderName: "Inbox",
      messageId,
      conversationId: input.message.conversationId || null,
      rfc822MessageId: input.message.internetMessageId || null,
      from: from || null,
      to,
      cc,
      subject: subject || null,
      snippet: input.message.bodyPreview || null,
      hasAttachments: Boolean(input.message.hasAttachments),
      attachmentNames: [],
      sourceUrl: input.message.webLink || null,
    },
    provenance: {
      rawRef: `microsoft-outlook/inbox/messages/${messageId}`,
      checksum,
      ingestionVersion: "microsoft-outlook-v1",
    },
    observation: input.observation ? {
      ...input.observation,
      observedAt: input.observedAt || Timestamp.now(),
    } : null,
    indexingEnabled: true,
  };
}

async function graphGet(url: string, accessToken: string, request: typeof fetch): Promise<DeltaPage> {
  const response = await request(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      prefer: 'IdType="ImmutableId", odata.maxpagesize=100',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as DeltaPage;
  if (!response.ok) throw new MicrosoftGraphMailError(
    response.status,
    String(body.error?.code || "GRAPH_ERROR"),
    String(body.error?.message || "unknown error"),
  );
  return body;
}

function initialDeltaUrl(now: Timestamp): string {
  const since = new Date(now.toMillis() - outlookInitialImportDays * 86_400_000).toISOString();
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta");
  url.searchParams.set("$filter", `receivedDateTime ge ${since}`);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$select", [
    "id", "changeKey", "conversationId", "internetMessageId", "subject", "bodyPreview",
    "body", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
    "lastModifiedDateTime", "hasAttachments", "isDraft", "webLink",
  ].join(","));
  return url.toString();
}

async function syncInbox(input: {
  companyId: string;
  connectionId: string;
  resource: ConnectorSyncExecutionResource;
  accessToken: string;
  lease: ConnectorSyncLease;
  trigger: ConnectorSyncTrigger;
  dependencies: ConnectorSyncDependencies;
  request: typeof fetch;
  forceFull?: boolean;
}): Promise<ConnectorSyncResourceCompletion> {
  const now = input.dependencies.now?.() || Timestamp.now();
  const storedDelta = input.forceFull ? "" : String(input.resource.data.deltaLink || "");
  const full = !storedDelta;
  let url = storedDelta || initialDeltaUrl(now);
  let deltaLink = "";
  let changes = 0;
  const observed = new Set<string>();
  const existing = await input.dependencies.database
    .collection(companyCollectionPath(input.companyId, "contextItems"))
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .get();
  const existingById = new Map(existing.docs.map((doc) => [doc.id, doc]));

  try {
    do {
      const page = await graphGet(url, input.accessToken, input.request);
      const writes: Array<{ ref: FirebaseFirestore.DocumentReference; value: Record<string, unknown> | null }> = [];
      for (const message of page.value || []) {
        if (!message.id) continue;
        const itemId = outlookMailContextItemId(input.connectionId, message.id);
        const ref = input.dependencies.database.doc(companyDocumentPath(
          input.companyId, "contextItems", itemId,
        ));
        if (message["@removed"] || message.isDraft) {
          if (existingById.has(itemId)) writes.push({ ref, value: null });
          continue;
        }
        observed.add(itemId);
        const value = outlookMessageContextItem({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: input.resource.id,
          message,
          audience: input.resource.data.audience,
          audienceRevision: Number(input.resource.data.audienceRevision || 1),
          observedAt: now,
          observation: {
            runId: input.lease.runId,
            trigger: input.trigger,
            providerUpdatedAt: message.lastModifiedDateTime || message.receivedDateTime || null,
            providerVersion: message.changeKey || sha256Hex(JSON.stringify(message)).slice(0, 16),
            freshnessEligible: true,
          },
        });
        if (!value) continue;
        const prior = existingById.get(itemId)?.data();
        const nextSource = value.source as Record<string, unknown>;
        const nextProvenance = value.provenance as Record<string, unknown>;
        if (
          prior?.source?.version === nextSource.version
          && prior?.provenance?.checksum === nextProvenance.checksum
        ) continue;
        writes.push({ ref, value });
      }
      for (let offset = 0; offset < writes.length; offset += 400) {
        const batch = writes.slice(offset, offset + 400);
        await commitConnectorSyncWrites({
          companyId: input.companyId,
          connectionId: input.connectionId,
          resourceId: input.resource.id,
          lease: input.lease,
          apply: (transaction) => {
            for (const write of batch) {
              if (write.value) transaction.set(write.ref, write.value, { merge: false });
              else transaction.delete(write.ref);
            }
          },
        }, input.dependencies);
        changes += batch.length;
      }
      url = page["@odata.nextLink"] || "";
      deltaLink = page["@odata.deltaLink"] || deltaLink;
    } while (url);
  } catch (error) {
    if (!full && error instanceof MicrosoftGraphMailError && [404, 410].includes(error.status)) {
      return syncInbox({ ...input, forceFull: true });
    }
    throw error;
  }

  if (!deltaLink) throw new Error("Microsoft Graph delta sync returned no durable cursor");
  if (full) {
    const stale = existing.docs.filter((doc) => !observed.has(doc.id));
    for (let offset = 0; offset < stale.length; offset += 400) {
      const batch = stale.slice(offset, offset + 400);
      await commitConnectorSyncWrites({
        companyId: input.companyId,
        connectionId: input.connectionId,
        resourceId: input.resource.id,
        lease: input.lease,
        apply: (transaction) => batch.forEach((doc) => transaction.delete(doc.ref)),
      }, input.dependencies);
      changes += batch.length;
    }
  }
  const itemCount = (await input.dependencies.database
    .collection(companyCollectionPath(input.companyId, "contextItems"))
    .where("source.connectionId", "==", input.connectionId)
    .where("source.resourceId", "==", input.resource.id)
    .count().get()).data().count;
  return {
    changes,
    itemCount,
    cursorAfter: sha256Hex(deltaLink).slice(0, 16),
    cursorMode: full ? "full" : "incremental",
    resourcePatch: { deltaLink, requiresFullSync: false },
  };
}

export type OutlookSyncInput = {
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
  fetch?: typeof fetch;
  now?: () => Timestamp;
};

export type OutlookSyncResult = ConnectorSyncRunResult & { folders: number };

async function ensureInboxResource(input: OutlookSyncInput): Promise<void> {
  const database = input.database || db;
  const connection = database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId));
  const resource = connection.collection("resources").doc(outlookInboxResourceId);
  await database.runTransaction(async (transaction) => {
    const [connectionSnapshot, capability, resourceSnapshot] = await Promise.all([
      transaction.get(connection),
      transaction.get(connection.collection("capabilities").doc(serviceId)),
      transaction.get(resource),
    ]);
    if (!connectionSnapshot.exists || connectionSnapshot.data()?.connectorId !== "microsoft_365") {
      throw new Error("Microsoft connection not found");
    }
    if (!capability.exists || capability.data()?.capabilityId !== capabilityId) {
      throw new Error("Microsoft Mail.Read permission is not enabled");
    }
    const status = String(capability.data()?.status || "");
    if (!["permission_granted", "active", "attention"].includes(status)) {
      throw new Error("Microsoft Mail.Read permission is not enabled");
    }
    const now = input.now?.() || Timestamp.now();
    transaction.set(resource, {
      connectionId: input.connectionId,
      capabilityId,
      resourceType: "mailbox_folder",
      externalId: "inbox",
      displayName: "Inbox (last 90 days)",
      status: "enabled",
      ...(resourceSnapshot.exists ? {} : {
        audience: {
          visibility: "restricted",
          memberIds: [connectionSnapshot.data()?.createdBy].filter(Boolean),
        },
        audienceRevision: 1,
        createdAt: now,
      }),
      updatedAt: now,
    }, { merge: true });
    if (status === "permission_granted") transaction.set(capability.ref, {
      status: "active",
      updatedAt: now,
    }, { merge: true });
  });
}

async function executeRun(input: OutlookSyncInput & { runId: string }): Promise<OutlookSyncResult> {
  const database = input.database || db;
  const request = input.fetch || fetch;
  const dependencies: ConnectorSyncDependencies = { database, now: input.now };
  const completed = await executeConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId,
    serviceId,
    prepare: async () => {
      const [authorized, connection] = await Promise.all([
        authorizedMicrosoftCapability(capabilityId, {
          companyId: input.companyId,
          connectionId: input.connectionId,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          credentialKey: input.credentialKey,
          dependencies: { database, fetch: request },
        }),
        database.doc(companyDocumentPath(input.companyId, "connections", input.connectionId)).get(),
      ]);
      return { ...authorized, connection };
    },
    listResources: async ({ connection }) => {
      const resource = await connection.ref.collection("resources").doc(outlookInboxResourceId).get();
      return resource.exists && resource.data()?.status === "enabled"
        ? [{ id: resource.id, data: resource.data() || {} }]
        : [];
    },
    cursorBefore: (resource) => resource.data.deltaLink ? sha256Hex(String(resource.data.deltaLink)).slice(0, 16) : null,
    cursorMode: (resource) => resource.data.deltaLink ? "incremental" : "full",
    synchronizeResource: ({ preparation, resource, trigger, lease, dependencies: runDeps }) => syncInbox({
      companyId: input.companyId,
      connectionId: input.connectionId,
      resource,
      accessToken: preparation.accessToken,
      lease,
      trigger,
      dependencies: runDeps,
      request,
    }),
    classifyError: (error) => {
      if (error instanceof MicrosoftAuthorizationError) return "reauthorization_required";
      if (error instanceof MicrosoftGraphMailError) {
        if ([401, 403].includes(error.status)) return "reauthorization_required";
        if (error.status === 429 || error.status >= 500) return "transient";
        return "permanent";
      }
      return "transient";
    },
  }, dependencies);
  return { ...completed, folders: completed.resources };
}

export async function syncMicrosoftOutlookConnection(input: OutlookSyncInput): Promise<OutlookSyncResult> {
  const database = input.database || db;
  await ensureInboxResource(input);
  const created = await createConnectorSyncRun({
    companyId: input.companyId,
    connectionId: input.connectionId,
    capabilityId,
    serviceId,
    trigger: input.trigger || "manual",
    requestedBy: input.requestedBy,
    resourceIds: input.resourceIds || [outlookInboxResourceId],
    replayOfRunId: input.replayOfRunId,
  }, { database, now: input.now });
  if (!created.created || created.deferred) {
    const run = await database.doc(
      `${companyDocumentPath(input.companyId, "connections", input.connectionId)}/syncRuns/${created.runId}`,
    ).get();
    const result = connectorSyncRunResultFromData(created.runId, run.data() || {});
    return { ...result, folders: result.resources };
  }
  return executeRun({ ...input, runId: created.runId });
}

export async function replayMicrosoftOutlookSyncRun(input: OutlookSyncInput & {
  runId: string;
  actorUid: string;
}): Promise<OutlookSyncResult> {
  const database = input.database || db;
  const resourceIds = await replayableConnectorSyncResources({
    companyId: input.companyId,
    connectionId: input.connectionId,
    runId: input.runId,
    capabilityId,
    serviceId,
  }, { database });
  return syncMicrosoftOutlookConnection({
    ...input,
    trigger: "operator_replay",
    requestedBy: input.actorUid,
    replayOfRunId: input.runId,
    resourceIds,
  });
}

export async function retryDueMicrosoftOutlookSyncRuns(input: Omit<OutlookSyncInput, "companyId" | "connectionId"> & { limit?: number }) {
  const database = input.database || db;
  const due = await listDueConnectorSyncRuns({ serviceId, limit: input.limit }, { database, now: input.now });
  const results: Array<OutlookSyncResult & { companyId: string; connectionId: string }> = [];
  for (const run of due) {
    const connection = await database.doc(companyDocumentPath(run.companyId, "connections", run.connectionId)).get();
    if (connection.data()?.connectorId !== "microsoft_365") continue;
    results.push({ companyId: run.companyId, connectionId: run.connectionId, ...await executeRun({
      ...input,
      companyId: run.companyId,
      connectionId: run.connectionId,
      runId: run.runId,
      trigger: "retry",
    }) });
  }
  return results;
}

export async function syncAllMicrosoftOutlookConnections(input: Omit<OutlookSyncInput, "companyId" | "connectionId">) {
  const database = input.database || db;
  const companies = await database.collection("companies").get();
  const results: Array<{ companyId: string; connectionId: string; ok: boolean; error?: string }> = [];
  for (const company of companies.docs) {
    if (company.data().status !== "active") continue;
    const connections = await company.ref.collection("connections")
      .where("connectorId", "==", "microsoft_365")
      .where("status", "in", ["active", "attention"]).get();
    for (const connection of connections.docs) {
      const capability = await connection.ref.collection("capabilities").doc(serviceId).get();
      if (!capability.exists || !["permission_granted", "active", "attention"].includes(String(capability.data()?.status))) continue;
      try {
        const result = await syncMicrosoftOutlookConnection({
          ...input,
          companyId: company.id,
          connectionId: connection.id,
          trigger: "scheduled",
          requestedBy: "scheduler:outlook-mail",
        });
        results.push({ companyId: company.id, connectionId: connection.id, ok: result.status !== "attention" });
      } catch (error) {
        results.push({ companyId: company.id, connectionId: connection.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}
