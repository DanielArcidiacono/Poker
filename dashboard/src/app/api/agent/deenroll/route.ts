import { NextResponse } from "next/server";
import { scopedAgentCredentialHash } from "../../../../lib/auth";
import { normalizeClientId } from "../../../../lib/client-id";
import { getStore } from "../../../../lib/store";

/** Permanently revoke a Mac's scoped credential and all session state. */
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    clientId?: string;
  } | null;
  const clientId = normalizeClientId(body?.clientId);
  if (!clientId) {
    return NextResponse.json({ error: "invalid client id" }, { status: 400 });
  }
  const credentialHash = scopedAgentCredentialHash(
    req.headers.get("authorization"),
  );
  if (!credentialHash) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await getStore().deleteSession(clientId, credentialHash);
  if (result === "mismatch") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
