import { NextResponse } from "next/server";
import { parseInstallToken } from "../../../../lib/install-token";
import { getStore } from "../../../../lib/store";

/** Consume the short-lived setup claim only after the Mac needs a new ID. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    token?: string;
    credentialHash?: string;
  } | null;
  const claim = parseInstallToken(body?.token ?? null);
  const credentialHash = body?.credentialHash?.trim().toLowerCase();
  if (
    !claim ||
    !credentialHash ||
    !/^[a-f0-9]{64}$/.test(credentialHash)
  ) {
    return NextResponse.json(
      { error: "invalid or expired setup claim" },
      { status: 401 },
    );
  }
  const enrolled = await getStore().enrollSession(
    claim.clientId,
    credentialHash,
  );
  if (!enrolled) {
    return NextResponse.json(
      { error: "this setup claim is already in use" },
      { status: 409 },
    );
  }
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
