import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LABEL = "com.local.screenviewer";
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const installScript = join(projectRoot, "scripts", "install-agent.sh");
const uninstallScript = join(projectRoot, "scripts", "uninstall-agent.sh");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export type AgentStatus = {
  installed: boolean;
  loaded: boolean;
  plistPath: string;
};

function isLocalRequest(req: {
  ip?: string;
  get?: (name: string) => string | undefined;
  socket: { remoteAddress?: string };
}): boolean {
  // Cloudflare Tunnel / proxies set these — never treat as local admin.
  if (req.get?.("cf-connecting-ip") || req.get?.("x-forwarded-for")) {
    return false;
  }
  const ip = req.ip || req.socket.remoteAddress || "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.endsWith("127.0.0.1")
  );
}

export function assertLocalOnly(req: {
  ip?: string;
  get?: (name: string) => string | undefined;
  socket: { remoteAddress?: string };
}): void {
  if (!isLocalRequest(req)) {
    const err = new Error(
      "Background service install is only allowed from this Mac (open http://127.0.0.1:8787 locally).",
    );
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const installed = existsSync(plistPath);
  let loaded = false;
  try {
    const uid = String(process.getuid?.() ?? "");
    await execFileAsync("launchctl", ["print", `gui/${uid}/${LABEL}`], {
      timeout: 5000,
    });
    loaded = true;
  } catch {
    loaded = false;
  }
  return { installed, loaded, plistPath };
}

async function runScript(
  script: string,
  envExtra: Record<string, string> = {},
): Promise<string> {
  if (!existsSync(script)) {
    throw new Error(`Script not found: ${script}`);
  }
  const { stdout, stderr } = await execFileAsync("/bin/bash", [script], {
    cwd: projectRoot,
    env: { ...process.env, ...envExtra },
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export async function installAgent(options?: {
  deferStart?: boolean;
}): Promise<{ output: string; deferred: boolean }> {
  const deferStart = options?.deferStart ?? true;
  const output = await runScript(installScript, {
    DEFER_START: deferStart ? "1" : "0",
  });
  return { output, deferred: deferStart };
}

export async function uninstallAgent(): Promise<string> {
  return runScript(uninstallScript);
}

/** After HTTP response, start the LaunchAgent and exit this process so the port is free. */
export function scheduleHandoffToAgent(): void {
  const uid = String(process.getuid?.() ?? "");
  const target = `gui/${uid}/${LABEL}`;
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      `sleep 1.5; launchctl kickstart -k ${JSON.stringify(target)} 2>/dev/null || launchctl start ${JSON.stringify(LABEL)} 2>/dev/null || true`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  setTimeout(() => {
    console.log("[agent] handing off to LaunchAgent; exiting");
    process.exit(0);
  }, 400).unref();
}
