/**
 * Background share bootstrap:
 * - ensures the LaunchAgent agent is running (survives quitting Terminal)
 * - waits until the stream URL is published to the dashboard
 * - prints the stable watch URL on computer 1, then exits
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env.js";

loadDotEnv();

const port = Number(process.env.PORT ?? "8787");
const controlPlane = (process.env.CONTROL_PLANE_URL ?? "").replace(/\/$/, "");
const dashboardPassword =
  process.env.DASHBOARD_PASSWORD?.trim() ||
  process.env.VIEWER_PASSWORD?.trim() ||
  "change-me";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(
    `Agent did not start on port ${port}. Grant Screen Recording to Node, then retry.`,
  );
}

async function ensureLaunchAgent(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      console.log(`[share] agent already running on :${port}`);
      return;
    }
  } catch {
    // install/start below
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  console.log("[share] starting background agent (LaunchAgent)…");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "install-agent"], {
      cwd: root,
      env: { ...process.env, DEFER_START: "0", SHARE_ON_START: "1" },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`install-agent exited with code ${code}`));
    });
  });
  await waitForHealth();
}

type LiveInfo = {
  online?: boolean;
  recording?: boolean;
  publicUrl?: string | null;
  message?: string | null;
};

async function waitUntilLive(timeoutMs = 120_000): Promise<LiveInfo> {
  if (!controlPlane) {
    throw new Error("CONTROL_PLANE_URL missing in .env");
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${controlPlane}/api/go-live`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as LiveInfo;
        if (data.recording && data.publicUrl) return data;
        if (data.message) {
          process.stdout.write(`\r[share] ${data.message}          `);
        }
      }
    } catch {
      // dashboard unreachable briefly
    }
    await sleep(2000);
  }
  throw new Error(
    "Timed out waiting for stream URL on the dashboard. Check cloudflared and Screen Recording.",
  );
}

async function main(): Promise<void> {
  console.log("=== Screen Viewer — background share ===");
  console.log("Agent keeps running after you quit Terminal.");
  console.log("");

  if (!controlPlane) {
    throw new Error(
      "CONTROL_PLANE_URL is not set. Re-run the install command from the dashboard.",
    );
  }

  await ensureLaunchAgent();

  // If SHARE_ON_START did not fire (older agent), ask dashboard to go live.
  try {
    const cur = await fetch(`${controlPlane}/api/go-live`, { cache: "no-store" });
    const data = (await cur.json()) as LiveInfo;
    if (!data.recording) {
      console.log("[share] requesting Go live on dashboard…");
      await fetch(`${controlPlane}/api/go-live`, { method: "POST" });
    }
  } catch {
    // continue — waitUntilLive will surface errors
  }

  console.log("[share] waiting for public link to appear on the dashboard…");
  const live = await waitUntilLive();
  console.log("");
  console.log("========================================");
  console.log("ON COMPUTER 1, OPEN THIS (stable URL):");
  console.log("");
  console.log(`  ${controlPlane}/watch`);
  console.log("");
  console.log(`Password: ${dashboardPassword}`);
  console.log("========================================");
  if (live.publicUrl) {
    console.log("");
    console.log("(Tunnel behind the scenes:)");
    console.log(`  ${live.publicUrl}`);
  }
  console.log("");
  console.log("You can quit Terminal now — sharing keeps running in the background.");
  console.log("To stop later: cd ~/Poker && npm run uninstall-agent");
}

main().catch((err) => {
  console.error("[share] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
