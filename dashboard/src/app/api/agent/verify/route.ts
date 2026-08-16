import { NextResponse } from "next/server";
import { checkScopedAgentBearer } from "../../../../lib/auth";
import { normalizeClientId } from "../../../../lib/client-id";

/** Verify a saved per-Mac credential without claiming a lease or heartbeat. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    clientId?: string;
  } | null;
  const clientId = normalizeClientId(body?.clientId);
  if (!clientId) {
    return NextResponse.json({ error: "invalid client id" }, { status: 400 });
  }
  if (
    !(await checkScopedAgentBearer(
      req.headers.get("authorization"),
      clientId,
    ))
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
