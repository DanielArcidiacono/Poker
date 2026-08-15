import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "screen_viewer_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Session = {
  token: string;
  expiresAt: number;
};

const sessions = new Map<string, Session>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key);
  }
}

export function getPassword(): string {
  const password = process.env.VIEWER_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "VIEWER_PASSWORD is required. Set it in the environment or a .env file.",
    );
  }
  return password;
}

export function passwordsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createSession(): { token: string; maxAgeSec: number } {
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(hashToken(token), { token, expiresAt });
  return { token, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  pruneSessions();
  const session = sessions.get(hashToken(token));
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(hashToken(token));
    return false;
  }
  return true;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(hashToken(token));
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function cookieOptions(secure: boolean, maxAgeSec: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: maxAgeSec * 1000,
    path: "/",
  };
}
