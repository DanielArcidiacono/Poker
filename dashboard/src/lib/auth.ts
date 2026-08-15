import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getAgentToken, getDashboardPassword } from "./store";

export const SESSION_COOKIE = "sv_dashboard_session";

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
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return false;
    return token === sessionTokenForPassword(getDashboardPassword());
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
