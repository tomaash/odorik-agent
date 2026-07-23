import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { onRequest } from "firebase-functions/v2/https";
import {
  appRouter,
  connectorCredentialKey,
  geminiApiKey,
  googleConnectorClientId,
  googleConnectorClientSecret,
  qdrantApiKey,
  qdrantUrl,
} from "./router.js";
import { createContext } from "./trpc.js";

const handler = createHTTPHandler({ router: appRouter, createContext });
const runtimeServiceAccount = "odorik-crm@odorik-tx-260720-c58d.iam.gserviceaccount.com";

export const api = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 300,
    memory: "512MiB",
    minInstances: 0,
    maxInstances: 3,
    serviceAccount: runtimeServiceAccount,
    secrets: [
      geminiApiKey,
      qdrantApiKey,
      qdrantUrl,
      connectorCredentialKey,
      googleConnectorClientId,
      googleConnectorClientSecret,
    ],
    cors: true,
  },
  (request, response) => {
    if (request.url === "/api") request.url = "/";
    else if (request.url.startsWith("/api/")) request.url = request.url.slice(4);
    return handler(request, response);
  },
);
