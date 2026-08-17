import { Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";

import type { ApprovedActionExecutionContext } from "../actions/registry.js";
import { authorizedMicrosoftCapability } from "../connectors/microsoft-oauth.js";
import { db } from "../firestore.js";
import { companyDocumentPath } from "../tenancy.js";
import {
  MailDraftOutcomeUnknownError,
  MailDraftWriteGrantMissingError,
  mailDraftExecutionPath,
  type MailDraftCreateAction,
  type MailDraftCreatedResult,
  type MailDraftExecutionRecord,
  type MailDraftExecutor,
} from "./executor.js";

const microsoftClientId = defineSecret("MICROSOFT_CONNECTOR_CLIENT_ID");
const microsoftClientSecret = defineSecret("MICROSOFT_CONNECTOR_CLIENT_SECRET");
const connectorCredentialKey = defineSecret("CONNECTOR_CREDENTIAL_KEY");

export const erikOutlookDraftPropertyId =
  "String {6f2f5a30-9b5d-4d46-a871-8c9d956b8b63} Name ErikDraftRequestId";

type OutlookDraft = {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  webLink?: string;
  isDraft?: boolean;
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
};

type OutlookDraftList = { value?: OutlookDraft[]; error?: { code?: string; message?: string } };

export class OutlookDraftApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Outlook draft API failed (${status}, ${code}): ${message}`);
    this.name = "OutlookDraftApiError";
  }
}

function result(message: OutlookDraft): MailDraftCreatedResult | null {
  const id = String(message.id || "").trim();
  if (!id || message.isDraft === false) return null;
  return {
    draftId: id,
    messageId: String(message.internetMessageId || id),
    threadId: String(message.conversationId || id),
    deepLink: String(message.webLink || "https://outlook.live.com/mail/0/drafts"),
  };
}

async function graphJson<T>(input: {
  label: string;
  url: URL;
  accessToken: string;
  method?: "GET" | "POST";
  body?: unknown;
  request?: typeof fetch;
}): Promise<T> {
  const request = input.request || fetch;
  const response = await request(input.url, {
    method: input.method || "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      prefer: 'IdType="ImmutableId"',
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new OutlookDraftApiError(
    response.status,
    String(body.error?.code || "GRAPH_ERROR"),
    String(body.error?.message || `${input.label} failed`),
  );
  return body;
}

export async function findOutlookDraftByRequestId(
  accessToken: string,
  draftRequestId: string,
  _mailboxAddress?: string | null,
  request: typeof fetch = fetch,
): Promise<MailDraftCreatedResult | null> {
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set(
    "$filter",
    `singleValueExtendedProperties/Any(ep: ep/id eq '${erikOutlookDraftPropertyId}' and ep/value eq '${draftRequestId.replaceAll("'", "''")}')`,
  );
  url.searchParams.set(
    "$expand",
    `singleValueExtendedProperties($filter=id eq '${erikOutlookDraftPropertyId}')`,
  );
  url.searchParams.set("$select", "id,conversationId,internetMessageId,webLink,isDraft");
  url.searchParams.set("$top", "2");
  const listed = await graphJson<OutlookDraftList>({
    label: "Outlook draft lookup",
    url,
    accessToken,
    request,
  });
  const matches = (listed.value || []).filter((message) => message.isDraft !== false);
  if (matches.length > 1) {
    throw new MailDraftOutcomeUnknownError(
      "Outlook contains more than one draft for this Erik request; operator review is required.",
    );
  }
  return matches[0] ? result(matches[0]) : null;
}

export async function createOutlookDraftViaApi(input: {
  accessToken: string;
  action: MailDraftCreateAction;
  request?: typeof fetch;
}): Promise<MailDraftCreatedResult> {
  const created = await graphJson<OutlookDraft>({
    label: "Outlook create draft",
    url: new URL("https://graph.microsoft.com/v1.0/me/messages"),
    accessToken: input.accessToken,
    method: "POST",
    request: input.request,
    body: {
      subject: input.action.subject.replace(/[\r\n]+/g, " ").trim(),
      body: { contentType: "Text", content: input.action.body },
      toRecipients: [{ emailAddress: { address: input.action.to[0] } }],
      internetMessageHeaders: [{
        name: "x-erik-draft-request-id",
        value: input.action.draftRequestId,
      }],
      singleValueExtendedProperties: [{
        id: erikOutlookDraftPropertyId,
        value: input.action.draftRequestId,
      }],
    },
  });
  const parsed = result(created);
  if (!parsed) throw new MailDraftOutcomeUnknownError(
    "Microsoft accepted the draft request but did not return a draft identifier.",
  );
  return parsed;
}

function priorResult(data?: MailDraftExecutionRecord): MailDraftCreatedResult | null {
  if (!data || data.status !== "succeeded" || !data.draftId || !data.messageId || !data.threadId || !data.deepLink) return null;
  return { draftId: data.draftId, messageId: data.messageId, threadId: data.threadId, deepLink: data.deepLink };
}

async function markDraftCapabilityActive(
  database: FirebaseFirestore.Firestore,
  companyId: string,
  connectionId: string,
): Promise<void> {
  await database.doc(
    `${companyDocumentPath(companyId, "connections", connectionId)}/capabilities/mail_draft`,
  ).set({ status: "active", updatedAt: Timestamp.now() }, { merge: true });
}

export type OutlookDraftAuth = { clientId: string; clientSecret: string; credentialKey: string };

export function createOutlookDraftExecutor(
  auth: () => OutlookDraftAuth = () => ({
    clientId: microsoftClientId.value(),
    clientSecret: microsoftClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  }),
  options: {
    database?: FirebaseFirestore.Firestore;
    createDraft?: typeof createOutlookDraftViaApi;
    findDraft?: typeof findOutlookDraftByRequestId;
    authorize?: (input: { companyId: string; connectionId: string }) => Promise<{ accessToken: string }>;
  } = {},
): MailDraftExecutor {
  const database = options.database || db;
  const createDraft = options.createDraft || createOutlookDraftViaApi;
  const findDraft = options.findDraft || findOutlookDraftByRequestId;
  const authorize = options.authorize || ((input) => authorizedMicrosoftCapability(
    "action.mail.draft.create",
    { ...input, ...auth(), dependencies: { database } },
  ));
  return async (context: ApprovedActionExecutionContext, action: MailDraftCreateAction) => {
    const ref = database.doc(mailDraftExecutionPath(context.companyId, action.draftRequestId));
    const snapshot = await ref.get();
    const data = snapshot.data() as MailDraftExecutionRecord | undefined;
    const prior = priorResult(data);
    if (prior) {
      await markDraftCapabilityActive(database, context.companyId, action.connectionId);
      return prior;
    }
    let accessToken: string;
    try {
      accessToken = (await authorize({ companyId: context.companyId, connectionId: action.connectionId })).accessToken;
    } catch (error) {
      if (error instanceof Error && /permission|not found|scope|grant/i.test(error.message)) {
        throw new MailDraftWriteGrantMissingError();
      }
      throw error;
    }
    let confirmedAbsent = false;
    if (data?.status === "outcome_unknown") {
      try {
        const found = await findDraft(accessToken, action.draftRequestId, action.mailboxAddress);
        if (found) {
          await ref.set({ ...found, status: "succeeded", error: null, reconciledAt: Timestamp.now(), reconciledBy: context.actorUid, updatedAt: Timestamp.now() }, { merge: true });
          await markDraftCapabilityActive(database, context.companyId, action.connectionId);
          return found;
        }
        confirmedAbsent = true;
      } catch (error) {
        await ref.set({
          status: "outcome_unknown",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Timestamp.now(),
        }, { merge: true });
        throw error instanceof MailDraftOutcomeUnknownError
          ? error
          : new MailDraftOutcomeUnknownError(error instanceof Error ? error.message : String(error));
      }
    }
    const now = Timestamp.now();
    await ref.set({
      companyId: context.companyId,
      draftRequestId: action.draftRequestId,
      connectionId: action.connectionId,
      mailboxAddress: action.mailboxAddress,
      approvalId: context.approvalId,
      attemptId: context.attemptId,
      status: "creating",
      error: null,
      ...(snapshot.exists ? {} : { createdAt: now }),
      updatedAt: now,
    } satisfies Partial<MailDraftExecutionRecord>, { merge: true });
    try {
      if (!confirmedAbsent) {
        try {
          const found = await findDraft(accessToken, action.draftRequestId, action.mailboxAddress);
          if (found) {
            await ref.set({ ...found, status: "succeeded", error: null, updatedAt: Timestamp.now() }, { merge: true });
            await markDraftCapabilityActive(database, context.companyId, action.connectionId);
            return found;
          }
        } catch (error) {
          // A first attempt has not called the mutating Graph endpoint yet, so a
          // failed optional lookup is safe to ignore. The stable request marker
          // on the create call protects later retries.
          if (snapshot.exists) throw error;
        }
      }
      const created = await createDraft({ accessToken, action });
      await ref.set({ ...created, status: "succeeded", error: null, updatedAt: Timestamp.now() }, { merge: true });
      await markDraftCapabilityActive(database, context.companyId, action.connectionId);
      return created;
    } catch (error) {
      const ambiguous = error instanceof MailDraftOutcomeUnknownError
        || (error instanceof OutlookDraftApiError && (error.status === 0 || error.status === 429 || error.status >= 500))
        || (error instanceof Error && /timeout|network|fetch failed|ECONNRESET/i.test(error.message));
      await ref.set({
        status: ambiguous ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Timestamp.now(),
      }, { merge: true });
      if (ambiguous && !(error instanceof MailDraftOutcomeUnknownError)) {
        throw new MailDraftOutcomeUnknownError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  };
}

export async function reconcileOutlookDraftExecution(input: {
  companyId: string;
  draftRequestId: string;
  actorUid: string;
  connectionId: string;
  auth?: OutlookDraftAuth;
  database?: FirebaseFirestore.Firestore;
}): Promise<MailDraftCreatedResult> {
  const database = input.database || db;
  const credentials = await authorizedMicrosoftCapability("action.mail.draft.create", {
    companyId: input.companyId,
    connectionId: input.connectionId,
    ...(input.auth || {
      clientId: microsoftClientId.value(),
      clientSecret: microsoftClientSecret.value(),
      credentialKey: connectorCredentialKey.value(),
    }),
    dependencies: { database },
  });
  const found = await findOutlookDraftByRequestId(credentials.accessToken, input.draftRequestId);
  if (!found) throw new Error(
    "No Outlook draft was found for this request. It is safe to approve again to create one.",
  );
  const ref = database.doc(mailDraftExecutionPath(input.companyId, input.draftRequestId));
  const snapshot = await ref.get();
  const now = Timestamp.now();
  await ref.set({
    companyId: input.companyId,
    draftRequestId: input.draftRequestId,
    connectionId: input.connectionId,
    status: "succeeded",
    ...found,
    error: null,
    reconciledAt: now,
    reconciledBy: input.actorUid,
    ...(snapshot.exists ? {} : { createdAt: now }),
    updatedAt: now,
  }, { merge: true });
  await markDraftCapabilityActive(database, input.companyId, input.connectionId);
  return found;
}
