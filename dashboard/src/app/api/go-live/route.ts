import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

/** Public: one-click Go live — no dashboard password. */
export async function POST() {
  const store = getStore();
  const report = await store.getReport();

  if (!report.online) {
    return NextResponse.json(
      {
        ok: false,
        agentOffline: true,
        setupRepoPath: process.env.NEXT_PUBLIC_SETUP_REPO_PATH ?? "~/Poker",
        agentLocalUrl:
          process.env.NEXT_PUBLIC_AGENT_LOCAL_URL ?? "http://127.0.0.1:8787",
        message: "Mac agent is offline. Start it on your computer, then try again.",
      },
      { status: 409 },
    );
  }

  await store.enqueue({ type: "start_recording" });
  return NextResponse.json({
    ok: true,
    message: "Go live requested. Agents are starting the tunnel…",
    watchPath: "/watch",
  });
}

export async function GET() {
  const report = await getStore().getReport();
  return NextResponse.json(
    {
      online: report.online,
      recording: report.recording,
      message: report.message,
      hostname: report.hostname,
      lastSeen: report.lastSeen,
      publicUrl: report.publicUrl,
      setupRepoPath: process.env.NEXT_PUBLIC_SETUP_REPO_PATH ?? "~/Poker",
      agentLocalUrl:
        process.env.NEXT_PUBLIC_AGENT_LOCAL_URL ?? "http://127.0.0.1:8787",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
