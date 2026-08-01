import { OAuth2Client } from "google-auth-library";
import { onRequest } from "firebase-functions/v2/https";
import {
  CodingAuthRefreshError,
  processCodingAuthRefreshCallback,
} from "./coding/auth-refresh.js";
import { queueCodingDispatcher } from "./coding/service.js";

const projectId = "odorik-tx-260720-c58d";
const callbackAudience = process.env.CODING_AUTH_CALLBACK_URL
  || "https://agent-erik-app.web.app/callbacks/coding-auth";
const authWorkerServiceAccount = `erik-grok-auth@${projectId}.iam.gserviceaccount.com`;
const verifier = new OAuth2Client();

async function verifyWorkerIdentity(authorization: string | undefined): Promise<void> {
  const match = authorization?.match(/^Bearer (\S+)$/);
  if (!match?.[1]) throw new CodingAuthRefreshError("Missing auth worker identity", 401);
  const ticket = await verifier.verifyIdToken({ idToken: match[1], audience: callbackAudience });
  const payload = ticket.getPayload();
  if (
    payload?.email !== authWorkerServiceAccount
    || payload.email_verified !== true
    || !payload.sub
  ) throw new CodingAuthRefreshError("Invalid auth worker identity", 403);
}

export const codingAuthCallback = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 60,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5,
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
        throw new CodingAuthRefreshError("Coding auth callback is too large", 413);
      }
      await verifyWorkerIdentity(request.headers.authorization);
      const result = await processCodingAuthRefreshCallback({ body: request.body });
      if (result.shouldDispatch) {
        await queueCodingDispatcher({ companyId: result.companyId, runId: result.runId });
      }
      response.status(204).send("");
    } catch (error) {
      const status = error instanceof CodingAuthRefreshError ? error.statusCode : 500;
      if (status >= 500) {
        console.error("Coding auth callback failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      response.status(status).json({
        error: status >= 500 ? "coding_auth_callback_failed" : (error as Error).message,
      });
    }
  },
);
