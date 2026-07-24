const productionOrigin = "https://odorik-tx-260720-c58d.web.app";
const localDevelopmentOrigin = "http://127.0.0.1:5173";
const callbackPath = "/oauth/google/callback";

export const defaultGoogleRedirectUri =
  process.env.GOOGLE_CONNECTOR_REDIRECT_URI?.trim()
  || `${productionOrigin}${callbackPath}`;

export const localGoogleRedirectUri = `${localDevelopmentOrigin}${callbackPath}`;

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

export function googleOAuthRedirectUri(requestedOrigin?: string): string {
  const url = requestedUrl(requestedOrigin);
  return url && isLocalDevelopment(url)
    ? localGoogleRedirectUri
    : defaultGoogleRedirectUri;
}

export function googleOAuthReturnUrl(requestedOrigin?: string): string {
  if (!requestedOrigin) return `${productionOrigin}/sources`;

  const url = requestedUrl(requestedOrigin);
  if (
    url
    && (url.origin === productionOrigin || isLocalDevelopment(url))
  ) {
    return `${url.origin}/sources`;
  }

  return `${productionOrigin}/sources`;
}
