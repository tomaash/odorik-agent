import { onRequest } from "firebase-functions/v2/https";
import { exchangeGoogleAuthorization } from "./google-calendar.js";
import {
  connectorCredentialKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
} from "../router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";
const sourcesUrl = "https://odorik-tx-260720-c58d.web.app/sources";

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
    if (oauthError) {
      response.redirect(`${sourcesUrl}?calendar=denied`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${sourcesUrl}?calendar=invalid`);
      return;
    }
    try {
      await exchangeGoogleAuthorization({
        code,
        state,
        clientId: googleConnectorClientId.value(),
        clientSecret: googleConnectorClientSecret.value(),
        credentialKey: connectorCredentialKey.value(),
      });
      response.redirect(`${sourcesUrl}?calendar=connected`);
    } catch (error) {
      console.error("Google Calendar OAuth callback failed", error);
      response.redirect(`${sourcesUrl}?calendar=failed`);
    }
  },
);

