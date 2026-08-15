import { NextResponse } from "next/server";
import { buildInstallScript, resolveInstallConfig } from "@/lib/install-script";

/** File download (fallback). */
export async function GET(req: Request) {
  try {
    const cfg = resolveInstallConfig(req);
    const script = buildInstallScript(cfg);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          'attachment; filename="Install Screen Viewer.command"',
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
