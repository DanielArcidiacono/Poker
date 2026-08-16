import { NextResponse } from "next/server";
import { checkAgentBearer, checkScopedAgentBearer } from "@/lib/auth";
import {
  LEGACY_CLIENT_ID,
  normalizeClientId,
} from "@/lib/client-id";
import {
  legacyCommandForState,
  resolveAgentProtocol,
  validAgentInstanceId,
} from "@/lib/legacy-protocol";
import { getStore } from "@/lib/store";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    hostname?: string;
    product?: string;
    version?: string;
    agentInstanceId?: string;
  };
  const clientId = body.clientId
    ? normalizeClientId(body.clientId)
    : LEGACY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "invalid client id" }, { status: 400 });
  }
  const authorized = body.clientId
    ? await checkScopedAgentBearer(
        req.headers.get("authorization"),
        clientId,
      )
    : checkAgentBearer(req.headers.get("authorization"));
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const protocol = resolveAgentProtocol(Boolean(body.clientId), body.agentInstanceId);
  const { legacyProtocol, instanceId } = protocol;
  if (!validAgentInstanceId(instanceId)) {
    return NextResponse.json(
      { error: "agent instance required" },
      { status: 400 },
    );
  }
  const store = getStore();
  if (!body.clientId) await store.migrateLegacySession(clientId);
  const [isOwner, desired] = await Promise.all([
    store.claimAgent(clientId, instanceId),
    store.getDesiredState(clientId),
  ]);
  if (isOwner) {
    await store.heartbeat(clientId, {
      hostname:
        typeof body.hostname === "string"
          ? body.hostname.slice(0, 255)
          : undefined,
      product:
        typeof body.product === "string"
          ? body.product.slice(0, 64)
          : "Prostar",
      version:
        typeof body.version === "string"
          ? body.version.slice(0, 32)
          : undefined,
    });
  }
  let command: { type: "start_recording" | "stop_recording" } | null = null;
  if (legacyProtocol && isOwner) {
    const report = await store.getSession(clientId);
    command = legacyCommandForState(desired.desiredSharing, report);
  }
  return NextResponse.json({
    ok: true,
    clientId,
    isOwner,
    shouldShare: isOwner && desired.desiredSharing,
    sharingRevision: desired.sharingRevision,
    command,
  });
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    agentInstanceId?: string;
  };
  const clientId = body.clientId
    ? normalizeClientId(body.clientId)
    : LEGACY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "invalid client id" }, { status: 400 });
  }
  const authorized = body.clientId
    ? await checkScopedAgentBearer(
        req.headers.get("authorization"),
        clientId,
      )
    : checkAgentBearer(req.headers.get("authorization"));
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!validAgentInstanceId(body.agentInstanceId)) {
    return NextResponse.json(
      { error: "agent instance required" },
      { status: 400 },
    );
  }
  await getStore().releaseAgent(clientId, body.agentInstanceId);
  return NextResponse.json({ ok: true });
}
