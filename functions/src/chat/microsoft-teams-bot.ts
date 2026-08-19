import { App } from "@microsoft/teams.apps";
import type {
  HttpMethod,
  HttpRouteHandler,
  IHttpServerAdapter,
} from "@microsoft/teams.apps/dist/http/index.js";

type ActivityRecord = Record<string, unknown>;

class CapturedHttpAdapter implements IHttpServerAdapter {
  handler: HttpRouteHandler | null = null;

  registerRoute(_method: HttpMethod, _path: string, handler: HttpRouteHandler): void {
    this.handler = handler;
  }
}

function validatedCredentials(input: { clientId: string; clientSecret: string; tenantId: string }) {
  if (!input.clientId.trim() || !input.clientSecret.trim() || !input.tenantId.trim()) {
    throw new Error("Microsoft Teams bot credentials are not configured.");
  }
  return input;
}

export async function createMicrosoftTeamsInboundRuntime(input: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  onMessage: (activity: ActivityRecord) => Promise<void>;
  onCardAction: (activity: ActivityRecord) => Promise<"queued" | "duplicate" | "resolved">;
  onInstallationUpdate?: (activity: ActivityRecord, installed: boolean) => Promise<void>;
}) {
  const credentials = validatedCredentials(input);
  const adapter = new CapturedHttpAdapter();
  const app = new App({
    ...credentials,
    httpServerAdapter: adapter,
    messagingEndpoint: "/webhooks/teams",
    activity: { mentions: { stripText: true } },
  });
  app.on("message", async ({ activity }) => {
    await input.onMessage(activity as unknown as ActivityRecord);
  });
  app.on("card.action", async ({ activity }) => {
    const status = await input.onCardAction(activity as unknown as ActivityRecord);
    return {
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: status === "queued"
        ? "Decision accepted. Erik is processing the exact proposal."
        : status === "resolved"
          ? "This proposal was already resolved. Erik is refreshing the card."
          : "This decision was already received.",
    };
  });
  app.on("install.add", async ({ activity }) => {
    await input.onInstallationUpdate?.(activity as unknown as ActivityRecord, true);
  });
  app.on("install.remove", async ({ activity }) => {
    await input.onInstallationUpdate?.(activity as unknown as ActivityRecord, false);
  });
  await app.initialize();
  if (!adapter.handler) throw new Error("Teams messaging route was not registered.");
  return {
    handle: adapter.handler,
  };
}

function messageActivity(input: { text: string; card?: unknown; activityId?: string }) {
  return {
    type: "message" as const,
    ...(input.activityId ? { id: input.activityId } : {}),
    text: input.text,
    ...(input.card ? {
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: input.card,
      }],
    } : {}),
  };
}

export async function sendMicrosoftTeamsActivity(input: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  serviceUrl: string;
  conversationId: string;
  text: string;
  card?: unknown;
  activityId?: string;
}): Promise<{ activityId: string }> {
  const credentials = validatedCredentials(input);
  assertMicrosoftTeamsServiceUrl(input.serviceUrl);
  const app = new App({
    ...credentials,
    serviceUrl: input.serviceUrl,
    httpServerAdapter: new CapturedHttpAdapter(),
  });
  await app.initialize();
  const sent = await app.send(input.conversationId, messageActivity(input));
  const activityId = String(sent.id || input.activityId || "");
  if (!activityId) throw new Error("Teams did not return an activity ID.");
  return { activityId };
}

export function assertMicrosoftTeamsServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Teams service URL.");
  }
  const hostname = url.hostname.toLocaleLowerCase("en");
  const allowed = hostname === "smba.trafficmanager.net"
    || hostname.endsWith(".teams.microsoft.com")
    || hostname.endsWith(".teams.microsoft.us")
    || hostname.endsWith(".botframework.com");
  if (url.protocol !== "https:" || !allowed || (url.port && url.port !== "443")
    || url.username || url.password) {
    throw new Error("Untrusted Teams service URL.");
  }
  return url.toString();
}
