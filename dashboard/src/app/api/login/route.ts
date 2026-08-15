import { NextResponse } from "next/server";
import {
  checkPassword,
  SESSION_COOKIE,
  sessionTokenForPassword,
} from "@/lib/auth";
import { getDashboardPassword } from "@/lib/store";

export async function POST(req: Request) {
  try {
    getDashboardPassword();
  } catch {
    return NextResponse.json(
      { error: "Server missing DASHBOARD_PASSWORD" },
      { status: 500 },
    );
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = String(body?.password ?? "");
  if (!checkPassword(password)) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionTokenForPassword(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
