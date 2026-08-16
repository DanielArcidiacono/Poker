import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/auth";
import { summarizeSession } from "@/lib/session-summary";
import { getStore } from "@/lib/store";

export async function GET() {
  if (!(await hasDashboardSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const reports = await getStore().listSessions();
  return NextResponse.json(
    { sessions: reports.map(summarizeSession) },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
