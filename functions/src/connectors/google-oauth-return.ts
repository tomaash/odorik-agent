const defaultAppOrigins = [
  "https://odorik-tx-260720-c58d.web.app",
  "https://agent-erik-app.web.app",
  "https://app.agenterik.cz",
];

// Every Hosting site the app runs on. Override with APP_ORIGINS (comma
// separated, most canonical first) when a custom domain is added — no OAuth
// client change is needed, because only the callback below is registered with
// Google and it stays on the canonical origin.
export const appOrigins = (process.env.APP_ORIGINS?.trim()
  ? process.env.APP_ORIGINS.split(",")
  : defaultAppOrigins)
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

/** The canonical origin every deployed callback and notification link points at. */
export const productionAppOrigin = appOrigins[0] || defaultAppOrigins[0]!;

const productionOrigin = productionAppOrigin;
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

// Stays on the canonical origin for every deployed site: that one callback URI
// is what Google has registered. The flow returns to the site the user started
// from via googleOAuthReturnUrl.
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
    && (appOrigins.includes(url.origin) || isLocalDevelopment(url))
  ) {
    return `${url.origin}/sources`;
  }

  return `${productionOrigin}/sources`;
}
