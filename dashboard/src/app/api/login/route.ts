import { NextResponse } from "next/server";
import {
  checkPassword,
  SESSION_COOKIE,
  sessionTokenForPassword,
} from "@/lib/auth";
import { getDashboardPassword } from "@/lib/store";

function requestOrigin(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host") ||
    "127.0.0.1:3000";
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "http");
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  const isForm = contentType.includes("application/x-www-form-urlencoded");

  try {
    getDashboardPassword();
  } catch {
    return NextResponse.json(
      { error: "Server missing DASHBOARD_PASSWORD" },
      { status: 500 },
    );
  }

  let password = "";
  if (isForm) {
    const form = await req.formData();
    password = String(form.get("password") ?? "");
  } else {
    const body = (await req.json().catch(() => null)) as {
      password?: string;
    } | null;
    password = String(body?.password ?? "");
  }

  if (!checkPassword(password)) {
    if (isForm) {
      return NextResponse.redirect(
        new URL("/watch?error=1", requestOrigin(req)),
        303,
      );
    }
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = isForm
    ? NextResponse.redirect(new URL("/watch", requestOrigin(req)), 303)
    : NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionTokenForPassword(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(req.url).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
