import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cookieOptions,
  createSession,
  destroySession,
  getPassword,
  isValidSession,
  passwordsMatch,
  sessionCookieName,
} from "./auth.js";
import {
  assertLocalOnly,
  getAgentStatus,
  installAgent,
  scheduleHandoffToAgent,
  uninstallAgent,
} from "./agent.js";
import { createCapture, loadCaptureEnv } from "./capture.js";
import { startControlPlane } from "./control-plane.js";
import { loadDotEnv } from "./env.js";
import { createTunnelManager } from "./tunnel.js";

loadDotEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const port = Number(process.env.PORT ?? "8787");
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const password = getPassword();

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    (corsOrigins.includes(origin) ||
      corsOrigins.includes("*") ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(publicDir, { index: false }));

function isSecureRequest(req: express.Request): boolean {
  if (req.secure) return true;
  const proto = req.get("x-forwarded-proto");
  return proto?.split(",")[0]?.trim() === "https";
}

function hasSession(req: express.Request): boolean {
  return isValidSession(req.cookies?.[sessionCookieName()]);
}

function requireSessionApi(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!hasSession(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function canManageLocally(req: express.Request): boolean {
  try {
    assertLocalOnly(req);
    return true;
  } catch {
    return false;
  }
}

const tunnel = createTunnelManager(port);
let activeWatchToken: string | null = null;

function isValidWatchToken(token: string | null | undefined): boolean {
  return Boolean(
    token && activeWatchToken && token === activeWatchToken,
  );
}

app.get("/login", (req, res) => {
  if (hasSession(req)) {
    res.redirect("/");
    return;
  }
  res.sendFile(join(publicDir, "login.html"));
});

app.post("/login", (req, res) => {
  const provided = String(req.body?.password ?? "");
  if (!passwordsMatch(provided, password)) {
    res.redirect("/login?error=1");
    return;
  }
  const { token, maxAgeSec } = createSession();
  res.cookie(
    sessionCookieName(),
    token,
    cookieOptions(isSecureRequest(req), maxAgeSec),
  );
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  destroySession(req.cookies?.[sessionCookieName()]);
  res.clearCookie(sessionCookieName(), { path: "/" });
  res.redirect("/login");
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/embed", (req, res) => {
  const token = String(req.query.token ?? "");
  if (!isValidWatchToken(token)) {
    res.status(401).type("text").send("Unauthorized");
    return;
  }
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  res.sendFile(join(publicDir, "embed.html"));
});

app.get("/api/tunnel", requireSessionApi, (req, res) => {
  res.json({
    ...tunnel.getStatus(),
    canManage: canManageLocally(req),
  });
});

app.post("/api/tunnel/start", requireSessionApi, async (req, res) => {
  try {
    assertLocalOnly(req);
    const publicUrl = await tunnel.startQuick();
    res.json({
      ok: true,
      mode: "quick",
      publicUrl,
      message: "Public link ready. Open it on your other device and log in.",
    });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "tunnel start failed",
    });
  }
});

/** Local-only start for the Vercel Go live button (no session cookie). */
app.post("/api/tunnel/start-bootstrap", async (req, res) => {
  try {
    assertLocalOnly(req);
    const publicUrl = await tunnel.startQuick();
    res.json({
      ok: true,
      mode: "quick",
      publicUrl,
      message: "Going live.",
    });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "tunnel start failed",
    });
  }
});

app.post("/api/tunnel/stop", requireSessionApi, (req, res) => {
  try {
    assertLocalOnly(req);
    tunnel.stop();
    res.json({ ok: true, message: "Public link stopped." });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "tunnel stop failed",
    });
  }
});

app.get("/api/agent", requireSessionApi, async (req, res) => {
  try {
    const status = await getAgentStatus();
    res.json({ ...status, canManage: canManageLocally(req) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "status failed",
    });
  }
});

app.post("/api/agent/install", requireSessionApi, async (req, res) => {
  try {
    assertLocalOnly(req);
    const result = await installAgent({ deferStart: true });
    res.json({
      ok: true,
      deferred: result.deferred,
      output: result.output,
      message:
        "Background service installed. This session will hand off shortly — you can close Terminal.",
    });
    scheduleHandoffToAgent();
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "install failed",
    });
  }
});

/** Local-only install for the Vercel Go live button (no session cookie). */
app.post("/api/agent/install-bootstrap", async (req, res) => {
  try {
    assertLocalOnly(req);
    const result = await installAgent({ deferStart: true });
    res.json({
      ok: true,
      deferred: result.deferred,
      output: result.output,
      message:
        "Background service installed. Handing off — press Go live again in a moment.",
    });
    scheduleHandoffToAgent();
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "install failed",
    });
  }
});

app.post("/api/agent/uninstall", requireSessionApi, async (req, res) => {
  try {
    assertLocalOnly(req);
    const output = await uninstallAgent();
    res.json({ ok: true, output, message: "Background service removed." });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "uninstall failed",
    });
  }
});

app.get("/", (req, res) => {
  if (!hasSession(req)) {
    res.redirect("/login");
    return;
  }
  res.sendFile(join(publicDir, "index.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function broadcast(jpeg: Buffer): void {
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(jpeg, { binary: true });
    }
  }
}

const capture = createCapture({
  ...loadCaptureEnv(),
  onFrame: broadcast,
  onWake: async () => {
    await tunnel.restart();
  },
});

const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.trim();
const agentToken = process.env.AGENT_TOKEN?.trim();
const shareOnStart =
  process.env.SHARE_ON_START === "1" ||
  process.env.SHARE_ON_START === "true";
const controlPlane =
  controlPlaneUrl && agentToken
    ? startControlPlane({
        baseUrl: controlPlaneUrl,
        token: agentToken,
        tunnel,
        port,
        shareOnStart,
        onWatchToken: (token) => {
          activeWatchToken = token;
        },
      })
    : null;

if (controlPlaneUrl && !agentToken) {
  console.warn(
    "[control-plane] CONTROL_PLANE_URL set but AGENT_TOKEN missing — pairing disabled",
  );
}

server.on("upgrade", (req, socket, head) => {
  try {
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const cookieHeader = req.headers.cookie ?? "";
    const match = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${sessionCookieName()}=`));
    const sessionToken = match?.slice(sessionCookieName().length + 1);
    const watchToken = url.searchParams.get("token");
    if (!isValidSession(sessionToken) && !isValidWatchToken(watchToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    });
  } catch {
    socket.destroy();
  }
});

// When paired with a dashboard, bind on all interfaces so LAN watch works
// if Cloudflare Tunnel is unavailable on the sharing Mac.
const bindHost = controlPlaneUrl ? "0.0.0.0" : "127.0.0.1";
server.listen(port, bindHost, () => {
  console.log(`[server] listening on http://${bindHost}:${port}`);
  if (bindHost === "127.0.0.1") {
    console.log(
      "[server] bind is localhost-only; use Cloudflare Tunnel for remote access",
    );
  } else {
    console.log(
      "[server] LAN bind enabled for dashboard pairing (tunnel preferred, LAN fallback)",
    );
  }
  capture.start();
  tunnel.startAuto();
});

function shutdown(): void {
  console.log("[server] shutting down");
  controlPlane?.stop();
  capture.stop();
  tunnel.stop();
  for (const client of clients) client.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection:", err);
});
