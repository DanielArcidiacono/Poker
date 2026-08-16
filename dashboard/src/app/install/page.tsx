import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/auth";
import { createInstallToken } from "@/lib/install-token";
import { InstallClient } from "./InstallClient";

export default async function InstallPage() {
  if (!(await hasDashboardSession())) redirect("/");

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "127.0.0.1:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = new URL(`${proto}://${host}`).origin;
  const token = createInstallToken();
  const installerUrl = `${origin}/api/install-agent/raw?token=${encodeURIComponent(token)}`;
  const cmd = `( installer="$(mktemp -t prostar-install.XXXXXX)" && trap 'rm -f "$installer"' EXIT && /usr/bin/curl -fsSL '${installerUrl}' -o "$installer" && /bin/bash "$installer" )`;

  return <InstallClient cmd={cmd} origin={origin} />;
}
