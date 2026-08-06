import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firestore.js";
import { sha256Hex } from "../hash.js";
import {
  completeSlackAuthorization,
  slackConnectorClientId,
  slackConnectorClientSecret,
} from "./slack-oauth.js";
import { slackOAuthReturnUrl } from "./slack-oauth-return.js";
import { connectorCredentialKey } from "../router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const slackOAuthCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      connectorCredentialKey,
      slackConnectorClientId,
      slackConnectorClientSecret,
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
      console.error("Could not read Slack OAuth return destination", error);
    }
    const sourcesUrl = slackOAuthReturnUrl(
      typeof stateData?.returnUrl === "string" ? stateData.returnUrl : undefined,
    );
    if (oauthError) {
      response.redirect(`${sourcesUrl}?slack=denied`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${sourcesUrl}?slack=invalid`);
      return;
    }
    try {
      const result = await completeSlackAuthorization({
        code,
        state,
        clientId: slackConnectorClientId.value(),
        clientSecret: slackConnectorClientSecret.value(),
        credentialKey: connectorCredentialKey.value(),
      });
      const complete = ["chat:write", "channels:read"]
        .every((scope) => result.grantedScopes.includes(scope));
      response.redirect(`${sourcesUrl}?slack=${complete ? "connected" : "partial"}`);
    } catch (error) {
      console.error("Slack OAuth callback failed", error);
      response.redirect(`${sourcesUrl}?slack=failed`);
    }
  },
);
