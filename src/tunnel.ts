import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";

function cloudflaredExecutable(): string {
  return process.env.PROSTAR_CLOUDFLARED_BIN?.trim() || "cloudflared";
}

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export type TunnelMode = "idle" | "quick";

export type TunnelStatus = {
  running: boolean;
  mode: TunnelMode;
  publicUrl: string | null;
};

export type TunnelManager = {
  startAuto: () => void;
  startQuick: () => Promise<string>;
  stop: () => void;
  getStatus: () => TunnelStatus;
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

async function waitForNetwork(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasUsableNetwork()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return hasUsableNetwork();
}

export function quickTunnelArgs(
  port: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const transportArgs = platform === "win32"
    ? ["--protocol", "http2", "--no-prechecks"]
    : [];
  return [
    "tunnel",
    ...transportArgs,
    "--no-autoupdate",
    "--url",
    `http://127.0.0.1:${port}`,
  ];
}

function shouldAutoStartQuick(): boolean {
  return process.env.AUTO_TUNNEL === "1" || process.env.AUTO_TUNNEL === "true";
}

function shouldKeepQuickAlive(): boolean {
  return shouldAutoStartQuick();
}

export function createTunnelManager(port: string | number): TunnelManager {
  const portStr = String(port);
  let child: ChildProcess | null = null;
  let intentionalStop = false;
  let mode: TunnelMode = "idle";
  let publicUrl: string | null = null;
  let logTail = "";
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
    const combined = `${logTail}${text}`;
    logTail = combined.slice(-2_048);
    if (process.env.CLOUDFLARED_VERBOSE === "1") {
      process.stderr.write(`[cloudflared] ${text}`);
    } else if (/\b(error|failed|fatal)\b/i.test(text)) {
      console.error(`[cloudflared] ${text.trim().slice(0, 1_000)}`);
    }
    if (mode !== "quick") return;
    const match = combined.match(QUICK_URL_RE);
    if (match?.[0]) resolveWaiters(match[0]);
  }

  function spawnQuickProcess(): void {
    intentionalStop = false;
    mode = "quick";
    logTail = "";
    console.log("[tunnel] starting cloudflared (quick)");
    const proc = spawn(cloudflaredExecutable(), quickTunnelArgs(portStr), {
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
          "Could not start Prostar's private cloudflared runtime",
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
      if (
        !intentionalStop &&
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

  function startQuickProcess(): void {
    if (child) stopChild();
    spawnQuickProcess();
  }

  return {
    startAuto() {
      if (shouldAutoStartQuick()) startQuickProcess();
    },
    async startQuick() {
      if (mode === "quick" && publicUrl && child) return publicUrl;

      if (!(await waitForNetwork())) {
        throw new Error("No usable network connection is available");
      }
      startQuickProcess();

      if (publicUrl) return publicUrl;

      return new Promise<string>((resolve, reject) => {
        const waiter = {
          resolve: (url: string) => {
            clearTimeout(timer);
            resolve(url);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          urlWaiters = urlWaiters.filter((candidate) => candidate !== waiter);
          reject(
            new Error(
              "Timed out waiting for Cloudflare Tunnel URL. Is cloudflared installed and online?",
            ),
          );
        }, 45000);

        urlWaiters.push(waiter);
      });
    },
    stop() {
      stopChild();
    },
    getStatus() {
      return {
        running: child !== null && mode !== "idle",
        mode,
        publicUrl,
      };
    },
  };
}

/** CLI entry for `npm run tunnel` (quick tunnel). */
export function runQuickTunnelCli(): void {
  const port = process.env.PORT ?? "8787";
  const child = spawn(
    cloudflaredExecutable(),
    quickTunnelArgs(port),
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
