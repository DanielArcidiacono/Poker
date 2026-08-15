import { NextResponse } from "next/server";
import { checkAgentBearer } from "@/lib/auth";
import { getStore } from "@/lib/store";

export async function POST(req: Request) {
  if (!checkAgentBearer(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    recording?: boolean;
    publicUrl?: string | null;
    watchToken?: string | null;
    message?: string | null;
    hostname?: string | null;
  } | null;

  if (typeof body?.recording !== "boolean") {
    return NextResponse.json({ error: "recording required" }, { status: 400 });
  }

  await getStore().setStatus({
    recording: body.recording,
    publicUrl: body.publicUrl,
    watchToken: body.watchToken,
    message: body.message,
    hostname: body.hostname,
  });

  return NextResponse.json({ ok: true });
}
