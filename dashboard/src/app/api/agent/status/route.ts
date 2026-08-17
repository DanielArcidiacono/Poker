import { NextResponse } from "next/server";
import { checkAgentBearer, checkScopedAgentBearer } from "@/lib/auth";
import {
  LEGACY_CLIENT_ID,
  normalizeClientId,
} from "@/lib/client-id";
import {
  resolveAgentProtocol,
  validAgentInstanceId,
} from "@/lib/legacy-protocol";
import { normalizeAgentPlatform, type AgentPlatform } from "@/lib/platform";
import { getStore } from "@/lib/store";
import { normalizeStreamUrl } from "@/lib/stream-url";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    clientId?: string | null;
    recording?: boolean;
    publicUrl?: string | null;
    watchToken?: string | null;
    viewerCount?: number | null;
    message?: string | null;
    hostname?: string | null;
    platform?: unknown;
    product?: string | null;
    version?: string | null;
    sharingRevision?: string | null;
    agentInstanceId?: string | null;
  } | null;

  const clientId = body?.clientId
    ? normalizeClientId(body.clientId)
    : LEGACY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "invalid client id" }, { status: 400 });
  }
  const authorized = body?.clientId
    ? await checkScopedAgentBearer(
        req.headers.get("authorization"),
        clientId,
      )
    : checkAgentBearer(req.headers.get("authorization"));
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (typeof body?.recording !== "boolean") {
    return NextResponse.json({ error: "recording required" }, { status: 400 });
  }
  const protocol = resolveAgentProtocol(Boolean(body.clientId), body.agentInstanceId);
  const { legacySession, legacyProtocol, instanceId: agentInstanceId } =
    protocol;
  const store = getStore();
  if (legacySession) await store.migrateLegacySession(clientId);
  const desired = legacyProtocol ? await store.getDesiredState(clientId) : null;
  const sharingRevision = legacyProtocol
    ? desired!.sharingRevision
    : body.sharingRevision;
  if (
    typeof sharingRevision !== "string" ||
    sharingRevision.length > 128
  ) {
    return NextResponse.json(
      { error: "sharing revision required" },
      { status: 400 },
    );
  }
  if (!validAgentInstanceId(agentInstanceId)) {
    return NextResponse.json(
      { error: "agent instance required" },
      { status: 400 },
    );
  }
  if (
    body.watchToken !== undefined &&
    body.watchToken !== null &&
    (typeof body.watchToken !== "string" ||
      body.watchToken.length < 16 ||
      body.watchToken.length > 256)
  ) {
    return NextResponse.json(
      { error: "invalid watch token" },
      { status: 400 },
    );
  }
  if (
    body.viewerCount !== undefined &&
    body.viewerCount !== null &&
    (!Number.isSafeInteger(body.viewerCount) ||
      body.viewerCount < 0 ||
      body.viewerCount > 10_000)
  ) {
    return NextResponse.json(
      { error: "invalid viewer count" },
      { status: 400 },
    );
  }
  let platform: AgentPlatform | null | undefined;
  if (body.platform === null) {
    platform = null;
  } else if (body.platform !== undefined) {
    platform = normalizeAgentPlatform(body.platform) ?? undefined;
    if (!platform) {
      return NextResponse.json(
        { error: "invalid platform" },
        { status: 400 },
      );
    }
  }

  const publicUrl =
    body.publicUrl === undefined
      ? undefined
      : body.publicUrl === null
        ? null
        : normalizeStreamUrl(body.publicUrl);
  if (typeof body.publicUrl === "string" && !publicUrl) {
    return NextResponse.json(
      { error: "invalid stream URL" },
      { status: 400 },
    );
  }

  if (legacyProtocol) await store.claimAgent(clientId, agentInstanceId);
  const accepted = await store.setStatus(clientId, {
    recording: body.recording,
    publicUrl,
    watchToken: body.watchToken,
    viewerCount: body.viewerCount ?? undefined,
    message:
      typeof body.message === "string"
        ? body.message.slice(0, 500)
        : body.message,
    hostname:
      typeof body.hostname === "string"
        ? body.hostname.slice(0, 255)
        : body.hostname,
    platform,
    product:
      typeof body.product === "string"
        ? body.product.slice(0, 64)
        : body.product,
    version:
      typeof body.version === "string"
        ? body.version.slice(0, 32)
        : body.version,
    sharingRevision,
    agentInstanceId,
  });
  if (!accepted) {
    return NextResponse.json(
      { error: "stale agent status" },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
