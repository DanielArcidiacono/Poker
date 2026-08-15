import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type TunnelMode = "idle" | "quick" | "named";

export type TunnelStatus = {
  running: boolean;
  mode: TunnelMode;
  publicUrl: string | null;
};

export type TunnelManager = {
  startAuto: () => void;
  startQuick: () => Promise<string>;
  stop: () => void;
  restart: () => Promise<void>;
  getStatus: () => TunnelStatus;
  waitForNetwork: (timeoutMs?: number) => Promise<boolean>;
};

function hasUsableNetwork(): boolean {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (String(entry.family) === "IPv4") return true;
    }
  }
  return false;
}

export async function waitForNetwork(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasUsableNetwork()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return hasUsableNetwork();
}

function namedTunnelArgs(): string[] | null {
  const token = process.env.CLOUDFLARED_TOKEN?.trim();
  if (token) return ["tunnel", "--no-autoupdate", "run", "--token", token];

  const config = process.env.CLOUDFLARED_CONFIG?.trim();
  if (config) return ["tunnel", "--no-autoupdate", "--config", config, "run"];

  return null;
}

function quickTunnelArgs(port: string): string[] {
  return ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
}

function shouldAutoStartQuick(): boolean {
  return process.env.AUTO_TUNNEL === "1" || process.env.AUTO_TUNNEL === "true";
}

function shouldKeepQuickAlive(): boolean {
  return (
    shouldAutoStartQuick() ||
    process.env.SHARE_ON_START === "1" ||
    process.env.SHARE_ON_START === "true"
  );
}

export function createTunnelManager(port: string | number): TunnelManager {
  const portStr = String(port);
  let child: ChildProcess | null = null;
  let intentionalStop = false;
  let restarting = false;
  let mode: TunnelMode = "idle";
  let publicUrl: string | null = null;
  let urlWaiters: Array<{
    resolve: (url: string) => void;
    reject: (err: Error) => void;
  }> = [];

  function rejectWaiters(err: Error): void {
    for (const w of urlWaiters) w.reject(err);
    urlWaiters = [];
  }

  function resolveWaiters(url: string): void {
    publicUrl = url;
    for (const w of urlWaiters) w.resolve(url);
    urlWaiters = [];
  }

  function ingestLog(text: string): void {
    process.stderr.write(`[cloudflared] ${text}`);
    if (mode !== "quick") return;
    const match = text.match(QUICK_URL_RE);
    if (match?.[0]) resolveWaiters(match[0]);
  }

  function spawnWithArgs(args: string[], nextMode: TunnelMode): void {
    intentionalStop = false;
    mode = nextMode;
    if (nextMode !== "quick") publicUrl = null;
    console.log("[tunnel] starting cloudflared:", args.join(" "));
    const proc = spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child = proc;

    proc.stdout.on("data", (chunk: Buffer) => ingestLog(chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => ingestLog(chunk.toString()));
    proc.on("error", (err) => {
      // A replacement may already be running; an old child's late event must
      // never clear the new child.
      if (child !== proc) return;
      console.error("[tunnel] failed to start cloudflared:", err.message);
      rejectWaiters(
        new Error(
          "Could not start cloudflared. Install it with: brew install cloudflared",
        ),
      );
      child = null;
      mode = "idle";
      publicUrl = null;
    });
    proc.on("exit", (code, signal) => {
      if (child !== proc) return;
      console.log(
        `[tunnel] cloudflared exited code=${code} signal=${signal ?? ""}`,
      );
      child = null;
      const wasMode = mode;
      mode = "idle";
      publicUrl = null;
      rejectWaiters(new Error("cloudflared exited before sharing a public URL"));
      if (!intentionalStop && !restarting && wasMode === "named") {
        setTimeout(() => {
          if (!intentionalStop) startNamed();
        }, 2000);
      } else if (
        !intentionalStop &&
        !restarting &&
        wasMode === "quick" &&
        shouldKeepQuickAlive()
      ) {
        setTimeout(() => {
          if (intentionalStop || child) return;
          void waitForNetwork(60_000).then((online) => {
            if (online && !intentionalStop && !child) startQuickProcess();
          });
        }, 2000);
      }
    });
  }

  function stopChild(): void {
    intentionalStop = true;
    rejectWaiters(new Error("Tunnel stopped"));
    if (child) {
      child.kill("SIGTERM");
      child = null;
    }
    mode = "idle";
    publicUrl = null;
  }

  function startNamed(): void {
    const args = namedTunnelArgs();
    if (!args) return;
    if (child) stopChild();
    spawnWithArgs(args, "named");
  }

  function startQuickProcess(): void {
    if (child) stopChild();
    spawnWithArgs(quickTunnelArgs(portStr), "quick");
  }

  return {
    startAuto() {
      if (namedTunnelArgs()) {
        startNamed();
        return;
      }
      if (shouldAutoStartQuick()) startQuickProcess();
    },
    async startQuick() {
      if (mode === "quick" && publicUrl && child) return publicUrl;

      await waitForNetwork();
      startQuickProcess();

      if (publicUrl) return publicUrl;

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          urlWaiters = urlWaiters.filter((w) => w.resolve !== resolve);
          reject(
            new Error(
              "Timed out waiting for Cloudflare Tunnel URL. Is cloudflared installed and online?",
            ),
          );
        }, 45000);

        urlWaiters.push({
          resolve: (url) => {
            clearTimeout(timer);
            resolve(url);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
    stop() {
      stopChild();
    },
    async restart() {
      if (restarting) return;
      const previous = mode;
      restarting = true;
      try {
        await waitForNetwork();
        if (previous === "quick") {
          startQuickProcess();
        } else if (previous === "named" || namedTunnelArgs()) {
          startNamed();
        }
      } finally {
        restarting = false;
      }
    },
    getStatus() {
      return {
        running: child !== null && mode !== "idle",
        mode,
        publicUrl,
      };
    },
    waitForNetwork,
  };
}

/** CLI entry for `npm run tunnel` (quick tunnel). */
export function runQuickTunnelCli(): void {
  const port = process.env.PORT ?? "8787";
  const child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
