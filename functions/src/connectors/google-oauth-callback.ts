import { createHash } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { db } from "../firestore.js";
import { defaultCompanyId } from "./odorik.js";
import { exchangeGoogleAuthorization } from "./google-calendar.js";
import { exchangeGoogleDriveAuthorization } from "./google-drive.js";
import { googleOAuthReturnUrl } from "./google-oauth-return.js";
import {
  connectorCredentialKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
} from "../router.js";

const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
        ? (await db.doc(
          `companies/${defaultCompanyId}/oauthStates/${hash(state)}`,
        ).get()).data()
        : undefined;
    } catch (error) {
      console.error("Could not read Google OAuth return destination", error);
    }
    const sourcesUrl = googleOAuthReturnUrl(
      typeof stateData?.returnUrl === "string" ? stateData.returnUrl : undefined,
    );
    if (oauthError) {
      response.redirect(`${sourcesUrl}?auth=denied`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${sourcesUrl}?auth=invalid`);
      return;
    }
    try {
      const provider = stateData?.provider;

      if (provider === "google_drive") {
        await exchangeGoogleDriveAuthorization({
          code,
          state,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        });
        response.redirect(`${sourcesUrl}?drive=connected`);
      } else {
        await exchangeGoogleAuthorization({
          code,
          state,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        });
        response.redirect(`${sourcesUrl}?calendar=connected`);
      }
    } catch (error) {
      console.error("Google OAuth callback failed", error);
      response.redirect(`${sourcesUrl}?auth=failed`);
    }
  },
);
