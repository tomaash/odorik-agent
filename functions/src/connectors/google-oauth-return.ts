const productionOrigin = "https://odorik-tx-260720-c58d.web.app";

export function googleOAuthReturnUrl(requestedOrigin?: string): string {
  if (!requestedOrigin) return `${productionOrigin}/sources`;

  try {
    const url = new URL(requestedOrigin);
    const isProduction = url.origin === productionOrigin;
    const isLocalDevelopment = (
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
    if (isProduction || isLocalDevelopment) {
      return `${url.origin}/sources`;
    }
  } catch {
    // Fall through to the production destination.
  }

  return `${productionOrigin}/sources`;
}
