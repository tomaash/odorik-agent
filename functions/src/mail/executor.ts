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
  /** Retained so reconciliation can link to the mailbox that owns the draft. */
  mailboxAddress?: string | null;
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

/**
 * Gmail has no stable public deep link to one draft.
 *
 * `#drafts/{apiMessageId}` is the same shape as the `#all/{apiMessageId}` link this
 * codebase already removed for citations: the web UI does not address messages by
 * API id, so it silently lands somewhere else. Link to the Drafts list of the
 * mailbox that owns the draft and let the stored ids identify it instead.
 * `authuser` beats `/u/0`, which is whichever account signed in first.
 */
export function mailDraftDeepLink(input: { mailboxAddress?: string | null }): string {
  const mailbox = (input.mailboxAddress || "").trim();
  if (mailbox) {
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#drafts`;
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

type GmailDraftListResponse = {
  drafts?: Array<{ id?: string; message?: { id?: string; threadId?: string } }>;
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
      "Email draft creation is not enabled on the selected mailbox. "
      + "An administrator must grant draft access on Sources.",
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

/**
 * Look the draft up by the Message-ID we minted for it.
 *
 * Uses `users.drafts.list`, not `users.messages.list`: the draft-write grant is
 * `gmail.compose`, which covers the drafts collection but *not* message search. A
 * connection holding only the write grant would get 403 from a message search — and
 * the caller would read that as "no draft exists" and create a second one. Listing
 * drafts also returns the real draft id rather than substituting a message id.
 *
 * Throws when the lookup itself fails. "We could not ask" is not "there is none",
 * and only the caller knows whether it is safe to create after an unanswered
 * question.
 */
export async function findDraftByRequestId(
  accessToken: string,
  draftRequestId: string,
  mailboxAddress?: string | null,
): Promise<MailDraftCreatedResult | null> {
  const rfc = erikDraftRfc822MessageId(draftRequestId);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
  url.searchParams.set("q", `rfc822msgid:${rfc}`);
  url.searchParams.set("maxResults", "5");
  const listed = await googleGet<GmailDraftListResponse>("Gmail draft lookup", url, accessToken);
  const match = listed.drafts?.[0];
  const draftId = String(match?.id || "").trim();
  const messageId = String(match?.message?.id || "").trim();
  if (!draftId || !messageId) return null;
  return {
    draftId,
    messageId,
    threadId: String(match?.message?.threadId || "").trim() || messageId,
    deepLink: mailDraftDeepLink({ mailboxAddress }),
  };
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
    deepLink: mailDraftDeepLink({ mailboxAddress: input.action.mailboxAddress }),
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
    const prior = existingData ? resultFromRecord(existingData) : null;
    if (prior) return prior;

    const accessToken = await resolveAccessToken({
      companyId: context.companyId,
      connectionId: action.connectionId,
    });

    /** Set once the provider has confirmed no draft exists for this request. */
    let confirmedAbsent = false;
    if (existingData?.status === "outcome_unknown") {
      // A draft may already exist. Confirm one way or the other before creating.
      let found: MailDraftCreatedResult | null;
      try {
        found = await findDraft(accessToken, action.draftRequestId, action.mailboxAddress);
      } catch (error) {
        // The lookup failed, so the earlier outcome is still unknown. Creating now
        // could hand the user a second draft of the same mail.
        const detail = error instanceof Error ? error.message : String(error);
        await ref.set({
          status: "outcome_unknown",
          error: `Gmail could not be asked whether this draft exists: ${detail}`,
          updatedAt: Timestamp.now(),
        }, { merge: true });
        throw new MailDraftOutcomeUnknownError(
          "Gmail could not confirm whether this draft already exists. "
          + "Reconcile before approving again.",
        );
      }
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
      confirmedAbsent = true;
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
      ...(existing.exists ? {} : { createdAt: now }),
      updatedAt: now,
    } satisfies Partial<MailDraftExecutionRecord>, { merge: true });

    try {
      if (!confirmedAbsent) {
        // Another attempt may have finished while we claimed creating.
        let again: MailDraftCreatedResult | null = null;
        try {
          again = await findDraft(accessToken, action.draftRequestId, action.mailboxAddress);
        } catch (error) {
          // On a retry the lookup is the only thing standing between us and a
          // duplicate, so an unanswered lookup leaves the outcome unknown. On a
          // first attempt nothing has been created for this request yet, so the
          // check is only an optimization and its failure is not interesting.
          if (existingData) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new MailDraftOutcomeUnknownError(
              `Gmail could not confirm whether an earlier attempt already created this draft: ${detail}`,
            );
          }
        }
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
  let found: MailDraftCreatedResult | null;
  try {
    found = await findDraftByRequestId(
      credentials.accessToken,
      input.draftRequestId,
      data?.mailboxAddress,
    );
  } catch (error) {
    // Never invite a second approval on the strength of a question Gmail did not
    // answer: the draft may well exist.
    const detail = error instanceof Error ? error.message : String(error);
    throw new MailDraftOutcomeUnknownError(
      `Gmail could not be reached to check for this draft, so the outcome is still unknown. Try reconciling again: ${detail}`,
    );
  }
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
