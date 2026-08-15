import { networkInterfaces } from "node:os";

function ipv4Candidates(): { name: string; address: string }[] {
  const nets = networkInterfaces();
  const out: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      const family = String(entry.family);
      if (family !== "IPv4" && family !== "4") continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

function sameSlash24(a: string, b: string): boolean {
  const ap = a.split(".").map(Number);
  const bp = b.split(".").map(Number);
  if (ap.length !== 4 || bp.length !== 4) return false;
  return ap[0] === bp[0] && ap[1] === bp[1] && ap[2] === bp[2];
}

/**
 * Pick a LAN IPv4 for stream fallback.
 * Prefer an address on the same /24 as the dashboard host (avoids VPN/UTM NICs).
 */
export function getLanIPv4(preferPeerUrl?: string): string | null {
  const candidates = ipv4Candidates();
  if (candidates.length === 0) return null;

  let peerHost: string | null = null;
  if (preferPeerUrl) {
    try {
      peerHost = new URL(preferPeerUrl).hostname;
    } catch {
      peerHost = null;
    }
  }

  if (peerHost && /^\d+\.\d+\.\d+\.\d+$/.test(peerHost)) {
    const same = candidates.find((c) => sameSlash24(c.address, peerHost!));
    if (same) return same.address;
  }

  const wifi = candidates.find((c) => /^en\d+$/i.test(c.name));
  if (wifi) return wifi.address;

  return candidates[0]?.address ?? null;
}

export function getLanBaseUrl(
  port: number | string,
  preferPeerUrl?: string,
): string | null {
  const ip = getLanIPv4(preferPeerUrl);
  if (!ip) return null;
  return `http://${ip}:${port}`;
}
