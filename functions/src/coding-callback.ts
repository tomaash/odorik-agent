import { OAuth2Client } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import {
  CodingCallbackError,
  codingCallbackStatus,
  processCodingCallback,
  requireKnownCodingPrincipal,
} from "./coding/callback.js";
import { queueCodingPublisher } from "./coding/service.js";

const projectId = "odorik-tx-260720-c58d";
const callbackAudience = process.env.CODING_CALLBACK_URL
  || "https://agent-erik-app.web.app/callbacks/coding";
const verifier = new OAuth2Client();

async function verifyCodingIdentity(authorization: string | undefined): Promise<string> {
  const match = authorization?.match(/^Bearer (\S+)$/);
  if (!match?.[1]) throw new CodingCallbackError("Missing coding worker identity", 401);
  const ticket = await verifier.verifyIdToken({
    idToken: match[1],
    audience: callbackAudience,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || payload.email_verified !== true || !payload.sub) {
    throw new CodingCallbackError("Invalid coding worker identity", 403);
  }
  requireKnownCodingPrincipal(payload.email, projectId);
  return payload.email;
}

export const codingCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 10,
    serviceAccount: `odorik-crm@${projectId}.iam.gserviceaccount.com`,
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      if (request.rawBody.length > 128 * 1024) {
        throw new CodingCallbackError("Coding callback is too large", 413);
      }
      const principalEmail = await verifyCodingIdentity(request.headers.authorization);
      const result = await processCodingCallback({ body: request.body, principalEmail });
      if (result.shouldPublish) {
        await queueCodingPublisher({ companyId: result.companyId, runId: result.runId });
      }
      response.status(204).send("");
    } catch (error) {
      const status = codingCallbackStatus(error);
      if (status >= 500) {
        console.error("Coding callback failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      response.status(status).json({
        error: status >= 500 ? "coding_callback_failed" : (error as Error).message,
      });
    }
  },
);
