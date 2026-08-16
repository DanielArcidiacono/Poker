import { NextResponse } from "next/server";
import { hasDashboardSession, isSameOriginRequest } from "@/lib/auth";
import { normalizeClientId } from "@/lib/client-id";
import { getStore } from "@/lib/store";

type Context = { params: Promise<{ clientId: string }> };

async function authorizedClient(req: Request, context: Context) {
  if (!(await hasDashboardSession())) {
    return { error: "unauthorized", status: 401 } as const;
  }
  if (!isSameOriginRequest(req)) {
    return { error: "invalid origin", status: 403 } as const;
  }
  const clientId = normalizeClientId((await context.params).clientId);
  if (!clientId) return { error: "invalid session", status: 400 } as const;
  return { clientId } as const;
}

export async function POST(req: Request, context: Context) {
  const auth = await authorizedClient(req, context);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const store = getStore();
  const session = await store.getSession(auth.clientId);
  if (!session.online) {
    return NextResponse.json(
      { error: "Prostar is offline on this Mac." },
      { status: 409 },
    );
  }
  await store.setSharing(
    auth.clientId,
    true,
    "Starting secure tunnel…",
  );
  return NextResponse.json({ ok: true, message: "Starting secure link…" });
}

export async function DELETE(req: Request, context: Context) {
  const auth = await authorizedClient(req, context);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  await getStore().setSharing(
    auth.clientId,
    false,
    "Stopping sharing…",
  );
  return NextResponse.json({
    ok: true,
    message: "Watch link revoked. Closing the tunnel…",
  });
}
