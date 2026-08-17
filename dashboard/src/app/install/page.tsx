import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/auth";
import {
  buildInstallCommand,
  buildWindowsInstallCommand,
} from "@/lib/install-command";
import { createInstallToken } from "@/lib/install-token";
import { InstallClient } from "./InstallClient";

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export default async function InstallPage() {
  if (!(await hasDashboardSession())) redirect("/");

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "127.0.0.1:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const requestOrigin =
    normalizeOrigin(`${proto}://${host}`) ?? "http://127.0.0.1:3000";
  const origin =
    normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL ?? "") ?? requestOrigin;
  const reportedPlatform = `${h.get("sec-ch-ua-platform") ?? ""} ${
    h.get("user-agent") ?? ""
  }`;
  const initialPlatform = /windows/i.test(reportedPlatform)
    ? "windows"
    : "macos";
  const token = createInstallToken();
  const encodedToken = encodeURIComponent(token);
  const macInstallerUrl = `${origin}/api/install-agent/raw?token=${encodedToken}&platform=macos`;
  const windowsInstallerUrl = `${origin}/api/install-agent/raw?token=${encodedToken}&platform=windows`;

  return (
    <InstallClient
      macCommand={buildInstallCommand(macInstallerUrl)}
      windowsCommand={buildWindowsInstallCommand(windowsInstallerUrl)}
      initialPlatform={initialPlatform}
      origin={origin}
    />
  );
}
