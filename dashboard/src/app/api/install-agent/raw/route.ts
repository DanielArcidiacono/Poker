import { NextResponse } from "next/server";
import {
  buildInstallScript,
  resolveInstallConfig,
} from "../../../../lib/install-script";
import { buildWindowsInstallScript } from "../../../../lib/install-script-windows";
import {
  parseInstallToken,
} from "../../../../lib/install-token";

/** Return the short-lived setup script downloaded to a temp file by the UI command. */
export async function GET(req: Request) {
  const requestUrl = new URL(req.url);
  const installToken = requestUrl.searchParams.get("token");
  const claim = parseInstallToken(installToken);
  if (!claim) {
    return NextResponse.json(
      { error: "This setup link is invalid or has expired." },
      { status: 401 },
    );
  }

  const platform = requestUrl.searchParams.get("platform") ?? "macos";
  if (platform !== "macos" && platform !== "windows") {
    return NextResponse.json(
      { error: "The requested setup platform is not supported." },
      { status: 400 },
    );
  }

  try {
    const cfg = resolveInstallConfig(req, {
      clientId: claim.clientId,
      installToken: installToken!,
    });
    const script =
      platform === "windows"
        ? buildWindowsInstallScript(cfg)
        : buildInstallScript(cfg);
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
