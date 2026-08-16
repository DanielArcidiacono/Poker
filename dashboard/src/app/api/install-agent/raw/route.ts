import { NextResponse } from "next/server";
import { buildInstallScript, resolveInstallConfig } from "@/lib/install-script";
import {
  deriveAgentCredential,
  parseInstallToken,
} from "@/lib/install-token";
import { hashAgentCredential } from "@/lib/auth";
import { getStore } from "@/lib/store";

/** Plain script for: curl -fsSL …/api/install-agent/raw | bash */
export async function GET(req: Request) {
  const claim = parseInstallToken(
    new URL(req.url).searchParams.get("token"),
  );
  if (!claim) {
    return NextResponse.json(
      { error: "This setup link is invalid or has expired." },
      { status: 401 },
    );
  }

  try {
    const agentCredential = deriveAgentCredential(claim.clientId);
    const enrolled = await getStore().enrollSession(
      claim.clientId,
      hashAgentCredential(agentCredential),
    );
    if (!enrolled) {
      return NextResponse.json(
        { error: "This Prostar setup claim has already been replaced." },
        { status: 409 },
      );
    }
    const cfg = resolveInstallConfig(req, {
      clientId: claim.clientId,
      agentCredential,
    });
    const script = buildInstallScript(cfg);
    return new NextResponse(script, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Installer configuration is invalid",
      },
      { status: 500 },
    );
  }
}
