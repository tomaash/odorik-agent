import { appOrigins, productionAppOrigin } from "./google-oauth-return.js";

const callbackPath = "/oauth/microsoft/callback";
const localDevelopmentOrigin = "http://127.0.0.1:5173";

export const defaultMicrosoftRedirectUri =
  process.env.MICROSOFT_CONNECTOR_REDIRECT_URI?.trim()
  || `${productionAppOrigin}${callbackPath}`;

export const localMicrosoftRedirectUri = `${localDevelopmentOrigin}${callbackPath}`;

function requestedUrl(value?: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalDevelopment(url: URL): boolean {
  return url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

export function microsoftOAuthRedirectUri(requestedOrigin?: string): string {
  const url = requestedUrl(requestedOrigin);
  return url && isLocalDevelopment(url)
    ? localMicrosoftRedirectUri
    : defaultMicrosoftRedirectUri;
}

export function microsoftOAuthReturnUrl(requestedOrigin?: string): string {
  const url = requestedUrl(requestedOrigin);
  if (url && (appOrigins.includes(url.origin) || isLocalDevelopment(url))) {
    return `${url.origin}/sources`;
  }
  return `${productionAppOrigin}/sources`;
}
