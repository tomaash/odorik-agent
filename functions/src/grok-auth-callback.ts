import { OAuth2Client } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import {
  GrokAuthorizationError,
  processGrokAuthCallback,
} from "./connectors/grok-subscription.js";

const projectId = "odorik-tx-260720-c58d";
const callbackAudience = "https://agent-erik-app.web.app/callbacks/grok-auth";
const authWorkerServiceAccount = `erik-grok-auth@${projectId}.iam.gserviceaccount.com`;
const verifier = new OAuth2Client();

async function verifyWorkerIdentity(authorization: string | undefined): Promise<void> {
  const match = authorization?.match(/^Bearer (\S+)$/);
  if (!match?.[1]) throw new GrokAuthorizationError("Missing worker identity", 401);
  const ticket = await verifier.verifyIdToken({
    idToken: match[1],
    audience: callbackAudience,
  });
  const payload = ticket.getPayload();
  if (
    payload?.email !== authWorkerServiceAccount
    || payload.email_verified !== true
    || !payload.sub
  ) {
    throw new GrokAuthorizationError("Invalid worker identity", 403);
  }
}

export const grokAuthCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 3,
    serviceAccount: `odorik-crm@${projectId}.iam.gserviceaccount.com`,
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("allow", "POST").status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      if (request.rawBody.length > 20_000) {
        throw new GrokAuthorizationError("Grok auth callback is too large", 413);
      }
      await verifyWorkerIdentity(request.headers.authorization);
      await processGrokAuthCallback({ body: request.body });
      response.status(204).send("");
    } catch (error) {
      if (error instanceof GrokAuthorizationError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("Grok authorization callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ error: "grok_auth_callback_failed" });
    }
  },
);
