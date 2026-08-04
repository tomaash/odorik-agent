import { Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";

import type { ApprovedActionExecutionContext } from "../actions/registry.js";
import { db } from "../firestore.js";
import { companyDocumentPath } from "../tenancy.js";
import {
  authorizedGoogleCapability,
  googleGet,
  googlePostJson,
  GoogleApiError,
  GoogleReauthorizationRequiredError,
} from "../connectors/google-oauth.js";
import { z } from "zod";
import { mailDraftCreateActionSchema } from "../actions/contracts.js";

export type MailDraftCreateAction = z.infer<typeof mailDraftCreateActionSchema>;

export type MailDraftCreatedResult = {
  draftId: string;
  messageId: string;
  threadId: string;
  deepLink: string;
};

export type MailDraftExecutor = (
  context: ApprovedActionExecutionContext,
  action: MailDraftCreateAction,
) => Promise<MailDraftCreatedResult>;

const googleConnectorClientId = defineSecret("GOOGLE_CONNECTOR_CLIENT_ID");
const googleConnectorClientSecret = defineSecret("GOOGLE_CONNECTOR_CLIENT_SECRET");
const connectorCredentialKey = defineSecret("CONNECTOR_CREDENTIAL_KEY");

/** Stable domain for Message-IDs we mint so provider lookup can use rfc822msgid. */
export const erikDraftMessageIdDomain = "erik-mail-draft.local";

export type MailDraftGoogleAuth = {
  clientId: string;
  clientSecret: string;
  credentialKey: string;
};

export type MailDraftExecutionRecord = {
  companyId: string;
  draftRequestId: string;
  connectionId: string;
  approvalId: string;
  attemptId: string;
  status: "creating" | "succeeded" | "outcome_unknown" | "failed";
  draftId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  deepLink?: string | null;
  error?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export function mailDraftExecutionPath(companyId: string, draftRequestId: string): string {
  return companyDocumentPath(companyId, "mailDraftExecutions", draftRequestId);
}

export function erikDraftRfc822MessageId(draftRequestId: string): string {
  // Gmail accepts bare or bracketed forms; we store the bare id for search.
  return `${draftRequestId}@${erikDraftMessageIdDomain}`;
}

export function mailDraftDeepLink(input: {
  draftId?: string | null;
  messageId?: string | null;
}): string {
  // Gmail has no stable public deep-link contract for a draft. Land in Drafts;
  // IDs are stored on the execution/approval for operators.
  if (input.messageId) {
    return `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(input.messageId)}`;
  }
  return "https://mail.google.com/mail/u/0/#drafts";
}

/** Build a minimal text/plain RFC822 message for users.drafts.create. */
export function buildMailDraftRfc822(action: MailDraftCreateAction): string {
  const to = action.to[0] || "";
  const subject = action.subject.replace(/[\r\n]+/g, " ").trim();
  const body = action.body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const messageId = erikDraftRfc822MessageId(action.draftRequestId);
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  if (action.inReplyToRfc822MessageId) {
    const bare = action.inReplyToRfc822MessageId.replace(/^<|>$/g, "").trim();
    if (bare) {
      headers.push(`In-Reply-To: <${bare}>`);
      headers.push(`References: <${bare}>`);
    }
  }
  // Custom header for operators and future list filters; not relied on for search.
  headers.push(`X-Erik-Draft-Request-Id: ${action.draftRequestId}`);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function encodeRfc822Base64Url(rfc822: string): string {
  return Buffer.from(rfc822, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type GmailDraftResponse = {
  id?: string;
  message?: {
    id?: string;
    threadId?: string;
  };
};

type GmailMessageListResponse = {
  messages?: Array<{ id?: string; threadId?: string }>;
};

export class MailDraftOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailDraftOutcomeUnknownError";
  }
}

export class MailDraftWriteGrantMissingError extends Error {
  constructor() {
    super(
      "Gmail draft creation is not enabled on this Google account. "
      + "An administrator must grant “Create Gmail drafts” on Sources.",
    );
    this.name = "MailDraftWriteGrantMissingError";
  }
}

function resultFromRecord(data: MailDraftExecutionRecord): MailDraftCreatedResult | null {
  if (
    data.status === "succeeded"
    && data.draftId
    && data.messageId
    && data.threadId
    && data.deepLink
  ) {
    return {
      draftId: data.draftId,
      messageId: data.messageId,
      threadId: data.threadId,
      deepLink: data.deepLink,
    };
  }
  return null;
}

async function findDraftByRequestId(
  accessToken: string,
  draftRequestId: string,
): Promise<MailDraftCreatedResult | null> {
  const rfc = erikDraftRfc822MessageId(draftRequestId);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", `in:drafts rfc822msgid:${rfc}`);
  url.searchParams.set("maxResults", "5");
  try {
    const listed = await googleGet<GmailMessageListResponse>("Gmail draft lookup", url, accessToken);
    const messageId = listed.messages?.[0]?.id;
    if (!messageId) return null;
    const messageUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    );
    messageUrl.searchParams.set("format", "minimal");
    const message = await googleGet<{ id?: string; threadId?: string }>(
      "Gmail draft message",
      messageUrl,
      accessToken,
    );
    // Draft id may differ from message id; list drafts is heavier. Prefer message id
    // for deep link and use message id as draftId fallback when draft list is unknown.
    const draftId = message.id || messageId;
    const threadId = message.threadId || listed.messages?.[0]?.threadId || messageId;
    return {
      draftId,
      messageId: message.id || messageId,
      threadId,
      deepLink: mailDraftDeepLink({ messageId: message.id || messageId, draftId }),
    };
  } catch {
    return null;
  }
}

export async function createGmailDraftViaApi(input: {
  accessToken: string;
  action: MailDraftCreateAction;
}): Promise<MailDraftCreatedResult> {
  const raw = encodeRfc822Base64Url(buildMailDraftRfc822(input.action));
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  const body: { message: { raw: string; threadId?: string } } = {
    message: { raw },
  };
  if (input.action.threadId) {
    body.message.threadId = input.action.threadId;
  }
  const created = await googlePostJson<GmailDraftResponse>(
    "Gmail create draft",
    url,
    input.accessToken,
    body,
  );
  const draftId = String(created.id || "").trim();
  const messageId = String(created.message?.id || "").trim();
  const threadId = String(created.message?.threadId || messageId || "").trim();
  if (!draftId || !messageId) {
    throw new MailDraftOutcomeUnknownError(
      "Gmail accepted the draft request but did not return draft identifiers.",
    );
  }
  return {
    draftId,
    messageId,
    threadId: threadId || messageId,
    deepLink: mailDraftDeepLink({ draftId, messageId }),
  };
}

export function createGmailDraftExecutor(
  auth: () => MailDraftGoogleAuth = () => ({
    clientId: googleConnectorClientId.value(),
    clientSecret: googleConnectorClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  }),
  options: {
    database?: FirebaseFirestore.Firestore;
    createDraft?: typeof createGmailDraftViaApi;
    findDraft?: typeof findDraftByRequestId;
    /** Test seam; production uses authorizedGoogleCapability for draft-write. */
    authorize?: (input: {
      companyId: string;
      connectionId: string;
    }) => Promise<{ accessToken: string }>;
  } = {},
): MailDraftExecutor {
  const database = options.database || db;
  const createDraft = options.createDraft || createGmailDraftViaApi;
  const findDraft = options.findDraft || findDraftByRequestId;
  const authorize = options.authorize || (async (input) => {
    const authorized = await authorizedGoogleCapability("action.mail.draft.create", {
      companyId: input.companyId,
      connectionId: input.connectionId,
      ...auth(),
      database,
    });
    return { accessToken: authorized.accessToken };
  });

  async function resolveAccessToken(input: {
    companyId: string;
    connectionId: string;
  }): Promise<string> {
    try {
      const authorized = await authorize(input);
      return authorized.accessToken;
    } catch (error) {
      if (
        error instanceof GoogleReauthorizationRequiredError
        || error instanceof MailDraftWriteGrantMissingError
        || (
          error instanceof Error
          && (
            error.message.includes("not found")
            || error.message.includes("incomplete")
            || error.message.includes("permission is incomplete")
          )
        )
      ) {
        throw new MailDraftWriteGrantMissingError();
      }
      throw error;
    }
  }

  return async (context, action) => {
    const ref = database.doc(
      mailDraftExecutionPath(context.companyId, action.draftRequestId),
    );
    const existing = await ref.get();
    const existingData = existing.data() as MailDraftExecutionRecord | undefined;
    if (existingData) {
      const prior = resultFromRecord(existingData);
      if (prior) return prior;
      if (existingData.status === "outcome_unknown") {
        // Reconcile before a second create.
        try {
          const accessToken = await resolveAccessToken({
            companyId: context.companyId,
            connectionId: action.connectionId,
          });
          const found = await findDraft(accessToken, action.draftRequestId);
          if (found) {
            const now = Timestamp.now();
            await ref.set({
              status: "succeeded",
              draftId: found.draftId,
              messageId: found.messageId,
              threadId: found.threadId,
              deepLink: found.deepLink,
              error: null,
              updatedAt: now,
              reconciledAt: now,
              reconciledBy: context.actorUid,
            }, { merge: true });
            return found;
          }
        } catch (error) {
          if (error instanceof MailDraftWriteGrantMissingError) throw error;
          // Fall through to create if grant is present and lookup failed cleanly.
        }
      }
    }

    const accessToken = await resolveAccessToken({
      companyId: context.companyId,
      connectionId: action.connectionId,
    });

    const now = Timestamp.now();
    await ref.set({
      companyId: context.companyId,
      draftRequestId: action.draftRequestId,
      connectionId: action.connectionId,
      approvalId: context.approvalId,
      attemptId: context.attemptId,
      status: "creating",
      error: null,
      ...(existing.exists ? {} : { createdAt: now }),
      updatedAt: now,
    } satisfies Partial<MailDraftExecutionRecord>, { merge: true });

    try {
      // Another attempt may have finished while we claimed creating.
      const again = await findDraft(accessToken, action.draftRequestId);
      if (again) {
        await ref.set({
          status: "succeeded",
          draftId: again.draftId,
          messageId: again.messageId,
          threadId: again.threadId,
          deepLink: again.deepLink,
          error: null,
          updatedAt: Timestamp.now(),
        }, { merge: true });
        return again;
      }

      const result = await createDraft({ accessToken, action });
      await ref.set({
        status: "succeeded",
        draftId: result.draftId,
        messageId: result.messageId,
        threadId: result.threadId,
        deepLink: result.deepLink,
        error: null,
        updatedAt: Timestamp.now(),
      }, { merge: true });
      return result;
    } catch (error) {
      if (error instanceof MailDraftOutcomeUnknownError) {
        await ref.set({
          status: "outcome_unknown",
          error: error.message,
          updatedAt: Timestamp.now(),
        }, { merge: true });
        throw error;
      }
      if (error instanceof GoogleApiError) {
        // Ambiguous: request may have been processed.
        if (error.status === 0 || error.status >= 500 || error.status === 429) {
          await ref.set({
            status: "outcome_unknown",
            error: error.message,
            updatedAt: Timestamp.now(),
          }, { merge: true });
          throw new MailDraftOutcomeUnknownError(error.message);
        }
      }
      if (error instanceof Error && /timeout|network|fetch failed|ECONNRESET/i.test(error.message)) {
        await ref.set({
          status: "outcome_unknown",
          error: error.message,
          updatedAt: Timestamp.now(),
        }, { merge: true });
        throw new MailDraftOutcomeUnknownError(error.message);
      }
      await ref.set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Timestamp.now(),
      }, { merge: true });
      throw error;
    }
  };
}

export async function reconcileMailDraftExecution(input: {
  companyId: string;
  draftRequestId: string;
  actorUid: string;
  connectionId: string;
  auth?: MailDraftGoogleAuth;
  database?: FirebaseFirestore.Firestore;
}): Promise<MailDraftCreatedResult> {
  const database = input.database || db;
  const auth = input.auth || {
    clientId: googleConnectorClientId.value(),
    clientSecret: googleConnectorClientSecret.value(),
    credentialKey: connectorCredentialKey.value(),
  };
  const ref = database.doc(mailDraftExecutionPath(input.companyId, input.draftRequestId));
  const snapshot = await ref.get();
  const data = snapshot.data() as MailDraftExecutionRecord | undefined;
  if (data) {
    const prior = resultFromRecord(data);
    if (prior) return prior;
  }
  const credentials = await authorizedGoogleCapability("action.mail.draft.create", {
    companyId: input.companyId,
    connectionId: input.connectionId,
    ...auth,
    database,
  });
  const found = await findDraftByRequestId(credentials.accessToken, input.draftRequestId);
  if (!found) {
    throw new Error(
      "No Gmail draft was found for this request. It is safe to approve again to create one.",
    );
  }
  const now = Timestamp.now();
  await ref.set({
    companyId: input.companyId,
    draftRequestId: input.draftRequestId,
    connectionId: input.connectionId,
    approvalId: data?.approvalId || null,
    attemptId: data?.attemptId || null,
    status: "succeeded",
    draftId: found.draftId,
    messageId: found.messageId,
    threadId: found.threadId,
    deepLink: found.deepLink,
    error: null,
    reconciledAt: now,
    reconciledBy: input.actorUid,
    ...(snapshot.exists ? {} : { createdAt: now }),
    updatedAt: now,
  }, { merge: true });
  return found;
}
