import { NextResponse } from "next/server";
import { checkAgentBearer } from "@/lib/auth";
import { getStore } from "@/lib/store";

export async function POST(req: Request) {
  if (!checkAgentBearer(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    hostname?: string;
  };
  const store = getStore();
  await store.heartbeat({ hostname: body.hostname });
  const command = await store.dequeue();
  return NextResponse.json({ ok: true, command });
}
