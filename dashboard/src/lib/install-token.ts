import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getAgentToken } from "./config";
import { normalizeClientId } from "./client-id";

const TOKEN_TTL_SECONDS = 10 * 60;

function signature(expiresAt: string, clientId: string): string {
  return createHmac("sha256", getAgentToken())
    .update(`prostar-install:${expiresAt}:${clientId}`)
    .digest("base64url");
}

export function createInstallToken(now = Date.now()): string {
  const expiresAt = String(Math.floor(now / 1000) + TOKEN_TTL_SECONDS);
  const clientId = randomUUID();
  return `${expiresAt}.${clientId}.${signature(expiresAt, clientId)}`;
}

export function parseInstallToken(
  token: string | null,
  now = Date.now(),
): { clientId: string; expiresAt: number } | null {
  if (!token) return null;
  const [expiresAt, rawClientId, provided, extra] = token.split(".");
  const clientId = normalizeClientId(rawClientId);
  if (!expiresAt || !clientId || !provided || extra) return null;

  const expiry = Number(expiresAt);
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= nowSeconds ||
    expiry > nowSeconds + TOKEN_TTL_SECONDS
  ) {
    return null;
  }

  const expectedBuffer = Buffer.from(signature(expiresAt, clientId));
  const providedBuffer = Buffer.from(provided);
  const valid =
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);
  return valid ? { clientId, expiresAt: expiry } : null;
}

export function isValidInstallToken(
  token: string | null,
  now = Date.now(),
): boolean {
  return parseInstallToken(token, now) !== null;
}

export function deriveAgentCredential(clientId: string): string {
  return createHmac("sha256", getAgentToken())
    .update(`prostar-agent:${clientId}`)
    .digest("base64url");
}
