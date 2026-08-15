import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { getLanBaseUrl } from "./lan.js";

export type ControlPlaneHandle = {
  stop: () => void;
  getWatchToken: () => string | null;
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
  tunnel: TunnelLike;
  /** Local agent HTTP port — used for LAN stream fallback. */
  port: number | string;
  pollMs?: number;
  /** Start tunnel + push URL to dashboard as soon as the agent boots. */
  shareOnStart?: boolean;
  onWatchToken?: (token: string | null) => void;
};

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
    },
    body: JSON.stringify(body),
  });
}

export function startControlPlane(options: Options): ControlPlaneHandle {
  const pollMs = options.pollMs ?? 2000;
  const host = osHostname();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let handling = false;
  let watchToken: string | null = null;
  /** When set, we are live (tunnel or LAN) until stop_recording. */
  let activeStreamUrl: string | null = null;
  let activeMessage: string | null = null;
  let wantShareOnStart = Boolean(options.shareOnStart);

  const base = options.baseUrl.replace(/\/$/, "");

  function setWatchToken(token: string | null): void {
    watchToken = token;
    options.onWatchToken?.(token);
  }

  async function report(status: {
    recording: boolean;
    publicUrl?: string | null;
    watchToken?: string | null;
    message?: string | null;
  }): Promise<void> {
    try {
      await postJson(`${base}/api/agent/status`, options.token, {
        ...status,
        watchToken:
          status.watchToken !== undefined ? status.watchToken : watchToken,
        hostname: host,
      });
    } catch (err) {
      console.error("[control-plane] status report failed:", err);
    }
  }

  async function goLiveWithUrl(
    streamUrl: string,
    message: string,
  ): Promise<void> {
    const token = randomBytes(24).toString("hex");
    setWatchToken(token);
    activeStreamUrl = streamUrl;
    activeMessage = message;
    await report({
      recording: true,
      publicUrl: streamUrl,
      watchToken: token,
      message,
    });
  }

  async function handleCommand(command: { type: string }): Promise<void> {
    if (command.type === "start_recording") {
      await report({
        recording: false,
        message: "Starting Cloudflare tunnel…",
      });

      // Always prefer Cloudflare Tunnel so Watch works even when macOS
      // firewall blocks inbound LAN connections to :8787.
      const keepAlive = setInterval(() => {
        void report({
          recording: false,
          message: "Starting Cloudflare tunnel…",
        });
      }, 8_000);

      try {
        // A quick-tunnel process can remain alive after its hostname stops
        // resolving. A start command means "replace the tunnel", not "reuse
        // whatever child process exists".
        options.tunnel.stop();
        const publicUrl = await options.tunnel.startQuick();
        clearInterval(keepAlive);
        await goLiveWithUrl(publicUrl, "Recording — public link ready.");
      } catch (err) {
        clearInterval(keepAlive);
        options.tunnel.stop();
        const lanUrl = getLanBaseUrl(options.port, base);
        if (lanUrl) {
          const reason =
            err instanceof Error ? err.message : "Tunnel unavailable";
          console.warn(
            `[control-plane] tunnel failed (${reason}); falling back to LAN ${lanUrl}`,
          );
          await goLiveWithUrl(
            lanUrl,
            `Recording on LAN (${lanUrl}). If Watch is blank, allow Node through Firewall or fix tunnel: ${reason}`,
          );
          return;
        }
        setWatchToken(null);
        activeStreamUrl = null;
        activeMessage = null;
        await report({
          recording: false,
          publicUrl: null,
          watchToken: null,
          message:
            err instanceof Error ? err.message : "Failed to start tunnel",
        });
      } finally {
        clearInterval(keepAlive);
      }
      return;
    }

    if (command.type === "stop_recording") {
      options.tunnel.stop();
      setWatchToken(null);
      activeStreamUrl = null;
      activeMessage = null;
      await report({
        recording: false,
        publicUrl: null,
        watchToken: null,
        message: "Recording stopped.",
      });
    }
  }

  async function tick(): Promise<void> {
    if (stopped || handling) return;
    handling = true;
    try {
      const res = await postJson(`${base}/api/agent/poll`, options.token, {
        hostname: host,
      });
      if (!res.ok) {
        console.error("[control-plane] poll failed:", res.status);
        return;
      }
      const data = (await res.json()) as {
        command?: { type: string } | null;
      };
      if (data.command) {
        console.log("[control-plane] command:", data.command.type);
        await handleCommand(data.command);
      } else if (wantShareOnStart && !activeStreamUrl) {
        wantShareOnStart = false;
        console.log("[control-plane] SHARE_ON_START — going live automatically");
        await handleCommand({ type: "start_recording" });
      } else if (activeStreamUrl && watchToken) {
        const st = options.tunnel.getStatus();
        if (
          st.running &&
          st.mode === "quick" &&
          st.publicUrl &&
          st.publicUrl !== activeStreamUrl
        ) {
          // cloudflared restarted after a reboot/network failure and received
          // a different quick-tunnel hostname. Publish it immediately.
          await goLiveWithUrl(
            st.publicUrl,
            "Recording — tunnel restored after restart.",
          );
        } else if (!st.running) {
          activeStreamUrl = null;
          activeMessage = null;
          setWatchToken(null);
          await report({
            recording: false,
            publicUrl: null,
            watchToken: null,
            message: "Reconnecting Cloudflare tunnel…",
          });
        } else {
          await report({
            recording: true,
            publicUrl: activeStreamUrl,
            watchToken,
            message: activeMessage,
          });
        }
      } else {
        const st = options.tunnel.getStatus();
        if (st.running && st.mode === "quick" && st.publicUrl) {
          if (!watchToken) setWatchToken(randomBytes(24).toString("hex"));
          activeStreamUrl = st.publicUrl;
          activeMessage = activeMessage || "Recording — public link ready.";
          await report({
            recording: true,
            publicUrl: st.publicUrl,
            watchToken,
            message: activeMessage,
          });
        } else {
          // Idle heartbeat only — do not send publicUrl:null (wipes dashboard).
          await report({
            recording: false,
            message: null,
          });
        }
      }
    } catch (err) {
      console.error("[control-plane] poll error:", err);
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
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    getWatchToken() {
      return watchToken;
    },
  };
}
