import { NextResponse } from "next/server";
import { buildInstallScript, resolveInstallConfig } from "@/lib/install-script";

/** Plain script for: curl -fsSL …/api/install-agent/raw | bash */
export async function GET(req: Request) {
  try {
    const cfg = resolveInstallConfig(req);
    const script = buildInstallScript(cfg);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "AGENT_TOKEN is not configured on the dashboard" },
      { status: 500 },
    );
  }
}
