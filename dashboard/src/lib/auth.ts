import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getAgentToken, getDashboardPassword } from "./config";
import { getStore } from "./store";

export const SESSION_COOKIE = "prostar_dashboard_session";
const LEGACY_SESSION_COOKIE = "sv_dashboard_session";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function checkPassword(provided: string): boolean {
  const expected = getDashboardPassword();
  const a = Buffer.from(hash(provided));
  const b = Buffer.from(hash(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionTokenForPassword(password: string): string {
  return hash(`session:${password}`);
}

export async function hasDashboardSession(): Promise<boolean> {
  try {
    const jar = await cookies();
    const token =
      jar.get(SESSION_COOKIE)?.value ??
      jar.get(LEGACY_SESSION_COOKIE)?.value;
    if (!token) return false;
    const provided = Buffer.from(token);
    const expected = Buffer.from(
      sessionTokenForPassword(getDashboardPassword()),
    );
    return (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    );
  } catch {
    return false;
  }
}

export function checkAgentBearer(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  const expected = getAgentToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerValue(header: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value.length >= 32 && value.length <= 256 ? value : null;
}

function credentialHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function checkScopedAgentBearer(
  header: string | null,
  clientId: string,
): Promise<boolean> {
  const hash = scopedAgentCredentialHash(header);
  return hash
    ? getStore().verifySessionCredential(clientId, hash)
    : false;
}

export function hashAgentCredential(value: string): string {
  return credentialHash(value);
}

export function scopedAgentCredentialHash(
  header: string | null,
): string | null {
  const provided = bearerValue(header);
  return provided ? credentialHash(provided) : null;
}

export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const expectedHost = (
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      new URL(req.url).host
    )
      .split(",")[0]
      .trim();
    const expectedProtocol = (
      req.headers.get("x-forwarded-proto") || new URL(req.url).protocol
    )
      .split(",")[0]
      .trim()
      .replace(/:$/, "");
    return (
      source.host === expectedHost &&
      source.protocol.replace(/:$/, "") === expectedProtocol
    );
  } catch {
    return false;
  }
}
