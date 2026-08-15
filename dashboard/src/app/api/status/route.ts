import { NextResponse } from "next/server";
import { hasDashboardSession } from "@/lib/auth";
import { getStore } from "@/lib/store";

export async function GET() {
  if (!(await hasDashboardSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const report = await getStore().getReport();
  return NextResponse.json({
    ...report,
    setupRepoPath:
      process.env.NEXT_PUBLIC_SETUP_REPO_PATH ?? "~/Poker",
    agentLocalUrl:
      process.env.NEXT_PUBLIC_AGENT_LOCAL_URL ?? "http://127.0.0.1:8787",
    store: process.env.UPSTASH_REDIS_REST_URL ? "redis" : "memory",
  });
}
