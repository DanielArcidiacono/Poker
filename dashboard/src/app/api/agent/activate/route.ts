import { NextResponse } from "next/server";
import { scopedAgentCredentialHash } from "../../../../lib/auth";
import { normalizeClientId } from "../../../../lib/client-id";
import { getStore } from "../../../../lib/store";

/** Make a provisional per-Mac credential durable after setup succeeds. */
export async function POST(req: Request) {
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
  if (
    !(await getStore().activateSessionCredential(
      clientId,
      credentialHash,
    ))
  ) {
    return NextResponse.json(
      { error: "setup credential is no longer active" },
      { status: 409 },
    );
  }
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
