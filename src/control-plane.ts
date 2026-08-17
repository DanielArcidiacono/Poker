import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname as osHostname } from "node:os";

export type ControlPlaneHandle = {
  setViewerCount: (count: number) => void;
  isConnected: () => boolean;
  stop: () => Promise<void>;
};

type TunnelLike = {
  startQuick: () => Promise<string>;
  stop: () => void;
  getStatus: () => {
    running: boolean;
    mode: string;
    publicUrl: string | null;
  };
};

type Options = {
  baseUrl: string;
  token: string;
  clientId?: string;
  tunnel: TunnelLike;
  pollMs?: number;
  disconnectGraceMs?: number;
  retryBaseMs?: number;
  onWatchToken?: (token: string | null) => void;
};

type AgentStatus = {
  recording: boolean;
  publicUrl: string | null;
  watchToken: string | null;
  viewerCount: number;
  message: string | null;
};

const LIVE_STATUS_REPUBLISH_MS = 60_000;
const CONTROL_PLANE_DISCONNECT_GRACE_MS = 60_000;
const MAX_START_RETRY_MS = 60_000;
const PRODUCT_NAME = "Prostar";
const AGENT_VERSION = "1.2.2";

export type AgentPlatform = "macos" | "windows" | "other";

type MacNameReader = (preference: "ComputerName" | "LocalHostName") => string;

function readMacName(preference: "ComputerName" | "LocalHostName"): string {
  return execFileSync("/usr/sbin/scutil", ["--get", preference], {
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function resolveMacDisplayName(
  reader: MacNameReader = readMacName,
  hostname: () => string = osHostname,
): string {
  return resolveDeviceDisplayName({
    platform: "darwin",
    readMacName: reader,
    hostname,
  });
}

type DeviceNameDependencies = {
  platform?: NodeJS.Platform;
  readMacName?: MacNameReader;
  hostname?: () => string;
  computerName?: () => string | undefined;
};

export function resolveAgentPlatform(
  platform: NodeJS.Platform = process.platform,
): AgentPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "other";
}

export function resolveDeviceDisplayName(
  dependencies: DeviceNameDependencies = {},
): string {
  const platform = dependencies.platform ?? process.platform;
  const reader = dependencies.readMacName ?? readMacName;
  const hostname = dependencies.hostname ?? osHostname;

  if (platform === "win32") {
    const computerName =
      (dependencies.computerName ?? (() => process.env.COMPUTERNAME))()
        ?.trim();
    return computerName || hostname().trim() || "Windows PC";
  }

  if (platform !== "darwin") {
    return hostname().trim() || "Device";
  }

  for (const preference of ["ComputerName", "LocalHostName"] as const) {
    try {
      const value = reader(preference).trim();
      if (value) return value;
    } catch {
      // A preference can be unset; continue to the next stable system name.
    }
  }
  return hostname().trim() || "Mac";
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${PRODUCT_NAME}/${AGENT_VERSION}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

export function startControlPlane(options: Options): ControlPlaneHandle {
  const pollMs = options.pollMs ?? 5_000;
  const disconnectGraceMs =
    options.disconnectGraceMs ?? CONTROL_PLANE_DISCONNECT_GRACE_MS;
  const retryBaseMs = options.retryBaseMs ?? 5_000;
  const host = resolveDeviceDisplayName();
  const platform = resolveAgentPlatform();
  const instanceId = randomUUID();
  const base = options.baseUrl.replace(/\/$/, "");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let handling = false;
  let reconciled = false;
  let ownsLease = false;
  let lastSharingRevision: string | null = null;
  let activeStreamUrl: string | null = null;
  let currentStatus: AgentStatus = {
    recording: false,
    publicUrl: null,
    watchToken: null,
    viewerCount: 0,
    message: "Ready to share.",
  };
  let statusDirty = false;
  let lastStatusReportAt = 0;
  let statusPublishInFlight: Promise<boolean> | null = null;
  let lastSuccessfulOwnerPollAt = 0;
  let startFailureCount = 0;
  let nextStartAttemptAt = 0;

  function setWatchToken(token: string | null): void {
    options.onWatchToken?.(token);
  }

  async function publishCurrentStatus(): Promise<boolean> {
    if (!ownsLease) return false;
    if (statusPublishInFlight) return statusPublishInFlight;
    const snapshot = currentStatus;
    statusPublishInFlight = (async () => {
      try {
        const res = await postJson(`${base}/api/agent/status`, options.token, {
          ...snapshot,
          clientId: options.clientId,
          hostname: host,
          platform,
          product: PRODUCT_NAME,
          version: AGENT_VERSION,
          sharingRevision: lastSharingRevision,
          agentInstanceId: instanceId,
        });
        if (!res.ok) {
          throw new Error(`dashboard returned HTTP ${res.status}`);
        }
        if (currentStatus === snapshot) statusDirty = false;
        lastStatusReportAt = Date.now();
        return true;
      } catch (err) {
        statusDirty = true;
        console.error("[control-plane] status report failed:", err);
        return false;
      }
    })();
    const published = await statusPublishInFlight;
    statusPublishInFlight = null;
    // A viewer or tunnel change that arrived while the request was in flight is
    // published only after the older snapshot settles, so status cannot regress.
    if (currentStatus !== snapshot && ownsLease && !stopped) {
      return publishCurrentStatus();
    }
    return published;
  }

  async function setStatus(status: AgentStatus): Promise<void> {
    currentStatus = status;
    statusDirty = true;
    await publishCurrentStatus();
  }

  async function goLiveWithUrl(
    streamUrl: string,
    message: string,
  ): Promise<void> {
    const token = randomBytes(24).toString("hex");
    activeStreamUrl = streamUrl;
    setWatchToken(token);
    await setStatus({
      recording: true,
      publicUrl: streamUrl,
      watchToken: token,
      viewerCount: currentStatus.viewerCount,
      message,
    });
  }

  async function startSharing(): Promise<void> {
    // Revoke the previous local link before publishing the transition.
    options.tunnel.stop();
    activeStreamUrl = null;
    setWatchToken(null);
    await setStatus({
      recording: false,
      publicUrl: null,
      watchToken: null,
      viewerCount: currentStatus.viewerCount,
      message: "Starting secure tunnel…",
    });

    try {
      // A quick-tunnel process may remain alive after its hostname expires.
      // A desired-state transition replaces it instead of trusting stale state.
      const publicUrl = await options.tunnel.startQuick();
      startFailureCount = 0;
      nextStartAttemptAt = 0;
      await goLiveWithUrl(publicUrl, "Live — secure link ready.");
    } catch (err) {
      options.tunnel.stop();
      activeStreamUrl = null;
      setWatchToken(null);
      startFailureCount += 1;
      const retryDelay = Math.min(
        MAX_START_RETRY_MS,
        retryBaseMs * 2 ** Math.min(startFailureCount - 1, 6),
      );
      nextStartAttemptAt = Date.now() + retryDelay;
      console.error("[control-plane] secure tunnel failed:", err);
      await setStatus({
        recording: false,
        publicUrl: null,
        watchToken: null,
        viewerCount: currentStatus.viewerCount,
        message: "Could not start the secure link. Retrying shortly.",
      });
    }
  }

  async function stopSharing(message = "Sharing stopped."): Promise<void> {
    options.tunnel.stop();
    activeStreamUrl = null;
    setWatchToken(null);
    startFailureCount = 0;
    nextStartAttemptAt = 0;
    await setStatus({
      recording: false,
      publicUrl: null,
      watchToken: null,
      viewerCount: 0,
      message,
    });
  }

  async function reconcileSharing(
    shouldShare: boolean,
    sharingRevision: string,
  ): Promise<void> {
    const tunnelStatus = options.tunnel.getStatus();
    const desiredStateChanged =
      lastSharingRevision !== null && sharingRevision !== lastSharingRevision;
    // Status updates are accepted only for the desired-state generation that
    // produced them. This makes an in-flight start harmless after Stop.
    lastSharingRevision = sharingRevision;

    if (!shouldShare) {
      if (
        !reconciled ||
        activeStreamUrl ||
        currentStatus.recording ||
        tunnelStatus.mode === "quick"
      ) {
        await stopSharing(reconciled ? "Sharing stopped." : "Ready to share.");
      }
      reconciled = true;
      return;
    }

    reconciled = true;
    if (desiredStateChanged) {
      startFailureCount = 0;
      nextStartAttemptAt = 0;
      await startSharing();
    } else if (!activeStreamUrl && Date.now() >= nextStartAttemptAt) {
      if (
        tunnelStatus.running &&
        tunnelStatus.mode === "quick" &&
        tunnelStatus.publicUrl
      ) {
        await goLiveWithUrl(tunnelStatus.publicUrl, "Live — secure link ready.");
      } else {
        await startSharing();
      }
    } else if (activeStreamUrl && !tunnelStatus.running) {
      await startSharing();
    } else if (
      tunnelStatus.mode === "quick" &&
      tunnelStatus.publicUrl &&
      tunnelStatus.publicUrl !== activeStreamUrl
    ) {
      await goLiveWithUrl(
        tunnelStatus.publicUrl,
        "Live — tunnel restored after reconnecting.",
      );
    }
  }

  function failClosedIfDisconnected(): void {
    if (
      Date.now() - lastSuccessfulOwnerPollAt < disconnectGraceMs ||
      (!activeStreamUrl &&
        !currentStatus.recording &&
        options.tunnel.getStatus().mode !== "quick")
    ) {
      return;
    }
    console.error(
      "[control-plane] dashboard connection expired; stopping screen sharing",
    );
    options.tunnel.stop();
    activeStreamUrl = null;
    setWatchToken(null);
    ownsLease = false;
    currentStatus = {
      recording: false,
      publicUrl: null,
      watchToken: null,
      viewerCount: 0,
      message: "Ready to share.",
    };
    statusDirty = true;
  }

  async function tick(): Promise<void> {
    if (stopped || handling) return;
    handling = true;
    try {
      const res = await postJson(`${base}/api/agent/poll`, options.token, {
        clientId: options.clientId,
        hostname: host,
        platform,
        product: PRODUCT_NAME,
        version: AGENT_VERSION,
        agentInstanceId: instanceId,
      });
      if (!res.ok) {
        console.error("[control-plane] poll failed:", res.status);
        failClosedIfDisconnected();
        return;
      }
      const data = (await res.json()) as {
        shouldShare?: boolean;
        isOwner?: boolean;
        sharingRevision?: string;
      };
      ownsLease = Boolean(data.isOwner);
      if (ownsLease) lastSuccessfulOwnerPollAt = Date.now();
      await reconcileSharing(
        Boolean(data.isOwner && data.shouldShare),
        typeof data.sharingRevision === "string" ? data.sharingRevision : "0",
      );

      if (
        ownsLease &&
        (statusDirty ||
        (currentStatus.recording &&
          Date.now() - lastStatusReportAt >= LIVE_STATUS_REPUBLISH_MS))
      ) {
        await publishCurrentStatus();
      }
    } catch (err) {
      console.error("[control-plane] poll error:", err);
      failClosedIfDisconnected();
    } finally {
      handling = false;
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, pollMs);
      }
    }
  }

  console.log(`[control-plane] paired with ${base}`);
  void tick();

  return {
    isConnected() {
      const freshnessWindow = Math.max(15_000, pollMs * 3);
      return (
        ownsLease &&
        lastSuccessfulOwnerPollAt > 0 &&
        Date.now() - lastSuccessfulOwnerPollAt <= freshnessWindow
      );
    },
    setViewerCount(count) {
      const viewerCount = Math.max(0, Math.floor(count));
      if (currentStatus.viewerCount === viewerCount) return;
      currentStatus = { ...currentStatus, viewerCount };
      statusDirty = true;
      if (ownsLease && !handling) void publishCurrentStatus();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await fetch(`${base}/api/agent/poll`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            clientId: options.clientId,
            agentInstanceId: instanceId,
          }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // The lease expires on its own after an ungraceful/offline shutdown.
      }
    },
  };
}
