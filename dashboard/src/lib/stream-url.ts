const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/i;

/**
 * Only agent-created Cloudflare quick tunnels are valid stream destinations.
 * Returning the normalized origin also strips credentials, paths, queries,
 * and fragments.
 */
export function normalizeStreamUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const isQuickTunnel =
      url.protocol === "https:" &&
      !url.port &&
      QUICK_TUNNEL_HOST.test(url.hostname);
    return isQuickTunnel ? url.origin : null;
  } catch {
    return null;
  }
}
