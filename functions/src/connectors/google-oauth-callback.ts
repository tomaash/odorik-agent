import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import { completeGoogleWorkspaceAuthorization } from "./google-oauth.js";
import { googleOAuthReturnUrl } from "./google-oauth-return.js";
import {
  connectorCredentialKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
} from "../router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";


export const googleOAuthCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      googleConnectorClientId,
      googleConnectorClientSecret,
    ],
  },
  async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const oauthError = typeof request.query.error === "string" ? request.query.error : "";
    let stateData: FirebaseFirestore.DocumentData | undefined;
    try {
      stateData = state
        ? (await db.doc(`oauthStates/${sha256Hex(state)}`).get()).data()
        : undefined;
    } catch (error) {
      console.error("Could not read Google OAuth return destination", error);
    }
    const sourcesUrl = googleOAuthReturnUrl(
      typeof stateData?.returnUrl === "string" ? stateData.returnUrl : undefined,
    );
    if (oauthError) {
      response.redirect(`${sourcesUrl}?workspace=denied`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${sourcesUrl}?workspace=invalid`);
      return;
    }
    try {
      const result = await completeGoogleWorkspaceAuthorization({
        code,
        state,
        clientId: googleConnectorClientId.value(),
        clientSecret: googleConnectorClientSecret.value(),
        credentialKey: connectorCredentialKey.value(),
      });
      response.redirect(
        `${sourcesUrl}?workspace=${
          result.missingCapabilityIds.length > 0 ? "partial" : "connected"
        }`,
      );
    } catch (error) {
      console.error("Google OAuth callback failed", error);
      response.redirect(`${sourcesUrl}?workspace=failed`);
    }
  },
);
