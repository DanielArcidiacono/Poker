/**
 * Simple share mode — same model as streaming from computer 1:
 * run on the Mac you want to share, print a public URL, open it elsewhere.
 */
import { loadDotEnv } from "./env.js";
import { createTunnelManager } from "./tunnel.js";

loadDotEnv();

const port = Number(process.env.PORT ?? "8787");
const password = process.env.VIEWER_PASSWORD?.trim() || "change-me";

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Agent did not start on port ${port}. Check Screen Recording permission for Node.`,
  );
}

async function ensureServer(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      console.log(`[share] agent already running on :${port}`);
      return;
    }
  } catch {
    // start below
  }

  console.log("[share] starting local agent…");
  const { spawn } = await import("node:child_process");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, AUTO_TUNNEL: "0" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.unref();
  await waitForHealth();
}

async function main(): Promise<void> {
  console.log("=== Screen Viewer — simple share ===");
  console.log("This is the same approach as sharing from computer 1.");
  console.log("");

  await ensureServer();

  const tunnel = createTunnelManager(port);
  console.log("[share] opening Cloudflare public link…");
  const publicUrl = await tunnel.startQuick();

  console.log("");
  console.log("========================================");
  console.log("OPEN THIS ON THE OTHER COMPUTER:");
  console.log("");
  console.log(`  ${publicUrl}`);
  console.log("");
  console.log(`Password: ${password}`);
  console.log("========================================");
  console.log("");
  console.log("Leave this Terminal window open while sharing.");
  console.log("Press Ctrl+C to stop.");

  const stop = () => {
    console.log("\n[share] stopping…");
    tunnel.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep process alive while tunnel runs.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[share] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
