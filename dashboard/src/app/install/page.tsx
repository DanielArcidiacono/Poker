import { headers } from "next/headers";
import { InstallClient } from "./InstallClient";

type Props = {
  searchParams: Promise<{ controlPlaneUrl?: string }>;
};

export default async function InstallPage({ searchParams }: Props) {
  const sp = await searchParams;
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "127.0.0.1:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const origin = (sp.controlPlaneUrl || `${proto}://${host}`).replace(/\/$/, "");
  // Short command — Host header sets control plane URL on the server.
  const cmd = `curl -fsSL ${origin}/api/install-agent/raw | bash`;

  return <InstallClient cmd={cmd} origin={origin} />;
}
