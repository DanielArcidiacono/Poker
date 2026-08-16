import { NextResponse } from "next/server";
import {
  checkPassword,
  SESSION_COOKIE,
  sessionTokenForPassword,
} from "@/lib/auth";
import { getDashboardPassword } from "@/lib/config";

function safeNext(value: FormDataEntryValue | null): string {
  const next = String(value ?? "");
  return next === "/" || /^\/watch\/[0-9a-f-]{36}$/.test(next)
    ? next
    : "/";
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
  let next = "/";
  if (isForm) {
    const form = await req.formData();
    password = String(form.get("password") ?? "");
    next = safeNext(form.get("next"));
  } else {
    const body = (await req.json().catch(() => null)) as {
      password?: string;
    } | null;
    password = String(body?.password ?? "");
  }

  if (!checkPassword(password)) {
    if (isForm) {
      return new NextResponse(null, {
        status: 303,
        headers: { Location: `${next}?error=1` },
      });
    }
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = isForm
    ? new NextResponse(null, {
        status: 303,
        headers: { Location: next },
      })
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
