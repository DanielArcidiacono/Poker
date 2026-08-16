import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

const LEGACY_SESSION_COOKIE = "sv_dashboard_session";

export async function POST(req: Request) {
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: "/" },
  });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(req.url).protocol === "https:",
    path: "/",
    maxAge: 0,
  });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(req.url).protocol === "https:",
    path: "/",
    maxAge: 0,
  });
  return res;
}
