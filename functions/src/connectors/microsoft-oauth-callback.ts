import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import {
  classifyMicrosoftAuthorizationFailure,
  completeMicrosoftAuthorization,
  recordMicrosoftAuthorizationFailure,
} from "./microsoft-oauth.js";
import { microsoftOAuthReturnUrl } from "./microsoft-oauth-return.js";
import {
  connectorCredentialKey,
  microsoftConnectorClientId,
  microsoftConnectorClientSecret,
} from "../router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const microsoftOAuthCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      microsoftConnectorClientSecret,
    ],
  },
  async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const oauthError = typeof request.query.error === "string" ? request.query.error : "";
    const errorDescription = typeof request.query.error_description === "string"
      ? request.query.error_description
      : "";
    const suberror = typeof request.query.suberror === "string" ? request.query.suberror : "";
    let stateData: FirebaseFirestore.DocumentData | undefined;
    try {
      stateData = state
        ? (await db.doc(`oauthStates/${sha256Hex(state)}`).get()).data()
        : undefined;
    } catch (error) {
      console.error("Could not read Microsoft OAuth return destination", error);
    }
    const sourcesUrl = microsoftOAuthReturnUrl(
      typeof stateData?.returnUrl === "string" ? stateData.returnUrl : undefined,
    );
    if (oauthError) {
      const issue = classifyMicrosoftAuthorizationFailure({
        error: oauthError,
        errorDescription,
        suberror,
      });
      if (state) {
        try {
          await recordMicrosoftAuthorizationFailure({ state, issue });
        } catch (error) {
          console.error("Could not record Microsoft OAuth failure", error);
        }
      }
      response.redirect(`${sourcesUrl}?microsoft=${encodeURIComponent(issue.state)}`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${sourcesUrl}?microsoft=invalid`);
      return;
    }
    try {
      const result = await completeMicrosoftAuthorization({
        code,
        state,
        clientId: microsoftConnectorClientId.value(),
        clientSecret: microsoftConnectorClientSecret.value(),
        credentialKey: connectorCredentialKey.value(),
      });
      response.redirect(`${sourcesUrl}?microsoft=${
        result.missingCapabilityIds.length ? "partial" : "connected"
      }`);
    } catch (error) {
      console.error("Microsoft OAuth callback failed", error);
      const issueState = error && typeof error === "object" && "issue" in error
        ? String((error as { issue?: { state?: string } }).issue?.state || "failed")
        : "failed";
      if (!(error && typeof error === "object" && "issue" in error)) {
        try {
          await recordMicrosoftAuthorizationFailure({
            state,
            issue: {
              state: "error",
              recoveryAction: "retry",
              code: "MICROSOFT_CALLBACK_FAILED",
              message: "Microsoft could not complete the authorization. Retry the connection.",
            },
          });
        } catch (recordError) {
          console.error("Could not close failed Microsoft OAuth state", recordError);
        }
      }
      response.redirect(`${sourcesUrl}?microsoft=${encodeURIComponent(issueState)}`);
    }
  },
);
