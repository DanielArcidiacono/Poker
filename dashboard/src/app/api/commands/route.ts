import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/auth";
import { getStore } from "@/lib/store";

export async function POST(req: Request) {
  if (!(await hasDashboardSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    type?: string;
  } | null;
  const type = body?.type;
  if (type !== "start_recording" && type !== "stop_recording") {
    return NextResponse.json({ error: "invalid command" }, { status: 400 });
  }

  const store = getStore();
  const report = await store.getReport();
  if (!report.online) {
    return NextResponse.json(
      {
        error: "agent_offline",
        message: "Mac agent is offline. Start it on your computer first.",
      },
      { status: 409 },
    );
  }

  const command = await store.enqueue({ type });
  return NextResponse.json({ ok: true, command });
}
