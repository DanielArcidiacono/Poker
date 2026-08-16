import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createCapture, loadCaptureEnv } from "./capture.js";
import { startControlPlane } from "./control-plane.js";
import { loadDotEnv } from "./env.js";
import { createTunnelManager } from "./tunnel.js";

loadDotEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const port = Number(process.env.PORT ?? "8787");

const password = getPassword();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(publicDir, { index: false }));

function isSecureRequest(req: express.Request): boolean {
  if (req.secure) return true;
  const proto = req.get("x-forwarded-proto");
  return proto?.split(",")[0]?.trim() === "https";
}

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  const raw = header
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function hasSession(req: express.Request): boolean {
  return isValidSession(cookieValue(req.headers.cookie, sessionCookieName()));
}

const tunnel = createTunnelManager(port);
let activeWatchToken: string | null = null;

function isValidWatchToken(token: string | null | undefined): boolean {
  return Boolean(
    token &&
      activeWatchToken &&
      passwordsMatch(token, activeWatchToken),
  );
}

app.get("/login", (req, res) => {
  if (hasSession(req)) {
    res.redirect("/");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
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
  destroySession(cookieValue(req.headers.cookie, sessionCookieName()));
  res.clearCookie(sessionCookieName(), { path: "/" });
  res.redirect("/login");
});

app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.get("/embed", (req, res) => {
  const token = String(req.query.token ?? "");
  if (!isValidWatchToken(token)) {
    res.status(401).type("text").send("Unauthorized");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.sendFile(join(publicDir, "index.html"));
});

app.get("/", (req, res) => {
  if (!hasSession(req)) {
    res.redirect("/login");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.sendFile(join(publicDir, "index.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();
const clientLiveness = new WeakMap<WebSocket, boolean>();

function broadcast(jpeg: Buffer): void {
  for (const client of clients) {
    // A slow or backgrounded browser must never turn the WebSocket's internal
    // queue into an unbounded archive of obsolete frames. The next frame is
    // always more useful than an old one.
    if (
      client.readyState === client.OPEN &&
      client.bufferedAmount <= jpeg.byteLength
    ) {
      try {
        client.send(jpeg, { binary: true });
      } catch {
        client.terminate();
      }
    }
  }
}

const capture = createCapture({
  ...loadCaptureEnv(),
  onFrame: broadcast,
});

const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.trim();
const agentToken =
  process.env.PROSTAR_AGENT_SECRET?.trim() ||
  process.env.AGENT_TOKEN?.trim();
const configuredClientId = process.env.PROSTAR_CLIENT_ID?.trim().toLowerCase();
const clientId =
  configuredClientId &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    configuredClientId,
  )
    ? configuredClientId
    : undefined;

app.post("/api/capture/preflight", async (req, res) => {
  const authorization = req.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!agentToken || !provided || !passwordsMatch(provided, agentToken)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    await capture.preflight();
    res.status(204).end();
  } catch (error) {
    res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "Screen Recording permission is unavailable",
    });
  }
});

const controlPlane =
  controlPlaneUrl && agentToken
    ? startControlPlane({
        baseUrl: controlPlaneUrl,
        token: agentToken,
        clientId,
        tunnel,
        onWatchToken: (token) => {
          activeWatchToken = token;
        },
      })
    : null;

if (controlPlaneUrl && !agentToken) {
  console.warn(
    "[control-plane] CONTROL_PLANE_URL set but Prostar agent credential missing — pairing disabled",
  );
}

if (controlPlaneUrl && agentToken && configuredClientId && !clientId) {
  console.warn(
    "[control-plane] PROSTAR_CLIENT_ID is invalid — using legacy single-session mode",
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

    const origin = req.headers.origin;
    if (!origin || new URL(origin).host !== host) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionToken = cookieValue(
      req.headers.cookie,
      sessionCookieName(),
    );
    const watchToken = url.searchParams.get("token");
    if (!isValidSession(sessionToken) && !isValidWatchToken(watchToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      clientLiveness.set(ws, true);
      controlPlane?.setViewerCount(clients.size);
      if (clients.size === 1) {
        console.log("[capture] first viewer connected; starting capture");
        capture.start();
      }

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clients.delete(ws);
        controlPlane?.setViewerCount(clients.size);
        if (clients.size === 0) {
          console.log("[capture] no viewers; pausing capture");
          capture.stop();
        }
      };
      ws.on("pong", () => clientLiveness.set(ws, true));
      ws.once("close", cleanup);
      ws.once("error", () => {
        cleanup();
        ws.terminate();
      });
    });
  } catch {
    socket.destroy();
  }
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (
      client.readyState !== client.OPEN ||
      !clientLiveness.get(client)
    ) {
      client.terminate();
      continue;
    }
    clientLiveness.set(client, false);
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }
}, 30_000);
heartbeat.unref();

// The agent never needs an inbound LAN listener. Cloudflare connects to this
// loopback origin, which also avoids firewall prompts and local exposure.
const bindHost = "127.0.0.1";
server.listen(port, bindHost, () => {
  console.log(`[server] listening on http://${bindHost}:${port}`);
  console.log(
    "[server] localhost-only; use Cloudflare Tunnel for remote access",
  );
  tunnel.startAuto();
});

let shuttingDown = false;

function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[server] shutting down");
  clearInterval(heartbeat);
  capture.stop();
  tunnel.stop();
  for (const client of clients) client.close();
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  void Promise.all([controlPlane?.stop(), serverClosed]).finally(() => {
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
  shutdown(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection:", err);
  shutdown(1);
});
