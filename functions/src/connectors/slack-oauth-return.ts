import { appOrigins } from "./google-oauth-return.js";

const productionOrigin = appOrigins[0];
const callbackPath = "/oauth/slack/callback";

/**
 * Slack requires TLS on every registered redirect URL and rejects `http://`, even
 * for localhost. There is therefore no local variant of this callback: a developer
 * running the UI on 127.0.0.1 completes the install against the deployed callback
 * and is returned to their own origin afterwards. Registered URLs, as configured on
 * the Slack app:
 *
 * - https://app.agenterik.cz/oauth/slack/callback
 * - https://odorik-tx-260720-c58d.web.app/oauth/slack/callback
 */
export const defaultSlackRedirectUri =
  process.env.SLACK_CONNECTOR_REDIRECT_URI?.trim()
  || `${productionOrigin}${callbackPath}`;

export function slackOAuthRedirectUri(): string {
  return defaultSlackRedirectUri;
}

function requestedUrl(requestedOrigin?: string): URL | null {
  if (!requestedOrigin) return null;
  try {
    return new URL(requestedOrigin);
  } catch {
    return null;
  }
}

function isLocalDevelopment(url: URL): boolean {
  return url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

/** Where the administrator lands once Slack has finished with them. */
export function slackOAuthReturnUrl(requestedOrigin?: string): string {
  const url = requestedUrl(requestedOrigin);
  if (url && (appOrigins.includes(url.origin) || isLocalDevelopment(url))) {
    return `${url.origin}/sources`;
  }
  return `${productionOrigin}/sources`;
}
