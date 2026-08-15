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
        const publicUrl = await options.tunnel.startQuick();
        await goLiveWithUrl(publicUrl, "Recording — public link ready.");
      } catch (err) {
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
      } else if (activeStreamUrl && watchToken) {
        // Keep LAN/tunnel session marked live — do not clear just because
        // cloudflared isn't the transport.
        await report({
          recording: true,
          publicUrl: activeStreamUrl,
          watchToken,
          message: activeMessage,
        });
      } else {
        const st = options.tunnel.getStatus();
        const recording = st.running && st.mode === "quick";
        if (!recording && watchToken) setWatchToken(null);
        if (recording && !watchToken) {
          setWatchToken(randomBytes(24).toString("hex"));
        }
        await report({
          recording,
          publicUrl: st.publicUrl,
          watchToken: recording ? watchToken : null,
        });
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
