import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

export type AgentCommand =
  | { id: string; type: "start_recording" }
  | { id: string; type: "stop_recording" };

export type AgentReport = {
  online: boolean;
  lastSeen: number | null;
  recording: boolean;
  publicUrl: string | null;
  publicUrlUpdatedAt: number | null;
  watchToken: string | null;
  message: string | null;
  hostname: string | null;
};

type StatusPayload = {
  recording: boolean;
  publicUrl?: string | null;
  watchToken?: string | null;
  message?: string | null;
  hostname?: string | null;
};

type Store = {
  heartbeat: (info: { hostname?: string }) => Promise<void>;
  getReport: () => Promise<AgentReport>;
  enqueue: (cmd: Omit<AgentCommand, "id">) => Promise<AgentCommand>;
  dequeue: () => Promise<AgentCommand | null>;
  setStatus: (status: StatusPayload) => Promise<void>;
};

/** Agent can be busy starting a tunnel for a bit; keep online during that. */
const HEARTBEAT_TTL_MS = 25_000;

type FileState = {
  lastSeen: number | null;
  hostname: string | null;
  recording: boolean;
  publicUrl: string | null;
  publicUrlUpdatedAt: number | null;
  watchToken: string | null;
  message: string | null;
  queue: AgentCommand[];
};

const emptyState = (): FileState => ({
  lastSeen: null,
  hostname: null,
  recording: false,
  publicUrl: null,
  publicUrlUpdatedAt: null,
  watchToken: null,
  message: null,
  queue: [],
});

function storePath(): string {
  const custom = process.env.AGENT_STORE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), ".data", "agent-store.json");
}

function readState(): FileState {
  const file = storePath();
  try {
    if (!existsSync(file)) return emptyState();
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<FileState>;
    return {
      ...emptyState(),
      ...raw,
      queue: Array.isArray(raw.queue) ? raw.queue : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(state: FileState): void {
  const file = storePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state), "utf8");
}

function reportFrom(state: FileState): AgentReport {
  const online = Boolean(
    state.lastSeen && Date.now() - state.lastSeen < HEARTBEAT_TTL_MS,
  );
  return {
    online,
    lastSeen: state.lastSeen,
    recording: state.recording,
    publicUrl: state.publicUrl,
    publicUrlUpdatedAt: state.publicUrlUpdatedAt,
    watchToken: state.watchToken,
    message: state.message,
    hostname: state.hostname,
  };
}

/**
 * File-backed store so Next.js HMR / multiple route compilations share one
 * source of truth on a LAN Mac (memory store was losing agent online state).
 */
function createFileStore(): Store {
  return {
    async heartbeat(info) {
      const s = readState();
      s.lastSeen = Date.now();
      if (info.hostname) s.hostname = info.hostname;
      writeState(s);
    },
    async getReport() {
      return reportFrom(readState());
    },
    async enqueue(cmd) {
      const s = readState();
      const existing = s.queue.find((queued) => queued.type === cmd.type);
      if (existing) return existing;
      const full: AgentCommand = { ...cmd, id: crypto.randomUUID() };
      s.queue.push(full);
      writeState(s);
      return full;
    },
    async dequeue() {
      const s = readState();
      const next = s.queue.shift() ?? null;
      writeState(s);
      return next;
    },
    async setStatus(status) {
      const s = readState();
      const currentlyLive = Boolean(
        s.recording && s.publicUrl && s.watchToken,
      );
      const clearingLive =
        status.recording === false &&
        (status.publicUrl === null || status.publicUrl === undefined);
      const explicitStop =
        status.message === "Recording stopped." ||
        status.message === "Starting Cloudflare tunnel…" ||
        status.message === "Starting stream…" ||
        status.message === "Reconnecting Cloudflare tunnel…" ||
        (typeof status.message === "string" &&
          (status.message.startsWith("Failed") ||
            status.message.includes("Failed to start")));

      // Ignore idle/flap reports that would wipe an active session (common when
      // two agent processes share one token, or tunnel status briefly flaps).
      if (currentlyLive && clearingLive && !explicitStop) {
        s.lastSeen = Date.now();
        if (status.hostname !== undefined && status.hostname) {
          s.hostname = status.hostname;
        }
        writeState(s);
        return;
      }

      s.recording = status.recording;
      if (status.publicUrl !== undefined) {
        if (
          status.publicUrl &&
          (status.publicUrl !== s.publicUrl || !s.publicUrlUpdatedAt)
        ) {
          s.publicUrlUpdatedAt = Date.now();
        } else if (status.publicUrl === null) {
          s.publicUrlUpdatedAt = null;
        }
        s.publicUrl = status.publicUrl;
      }
      if (status.watchToken !== undefined) s.watchToken = status.watchToken;
      if (status.message !== undefined) s.message = status.message;
      if (status.hostname !== undefined) s.hostname = status.hostname;
      s.lastSeen = Date.now();
      writeState(s);
    },
  };
}

function createRedisStore(redis: Redis): Store {
  const hbKey = "sv:agent:heartbeat";
  const statusKey = "sv:agent:status";
  const queueKey = "sv:agent:queue";

  return {
    async heartbeat(info) {
      await redis.set(
        hbKey,
        { at: Date.now(), hostname: info.hostname ?? null },
        { px: HEARTBEAT_TTL_MS },
      );
    },
    async getReport() {
      const [hb, status] = await Promise.all([
        redis.get<{ at: number; hostname: string | null }>(hbKey),
        redis.get<{
          recording: boolean;
          publicUrl: string | null;
          publicUrlUpdatedAt: number | null;
          watchToken: string | null;
          message: string | null;
          hostname: string | null;
        }>(statusKey),
      ]);
      const lastSeen = hb?.at ?? null;
      const online = Boolean(
        lastSeen && Date.now() - lastSeen < HEARTBEAT_TTL_MS,
      );
      return {
        online,
        lastSeen,
        recording: status?.recording ?? false,
        publicUrl: status?.publicUrl ?? null,
        publicUrlUpdatedAt: status?.publicUrlUpdatedAt ?? null,
        watchToken: status?.watchToken ?? null,
        message: status?.message ?? null,
        hostname: status?.hostname ?? hb?.hostname ?? null,
      };
    },
    async enqueue(cmd) {
      const full: AgentCommand = { ...cmd, id: crypto.randomUUID() };
      // Redis deployments may have several Watch refreshes at once. Keep the
      // queue bounded; the agent only needs one start/stop request.
      const queued = await redis.lrange<string>(queueKey, 0, -1);
      const existing = queued
        .map((raw) =>
          typeof raw === "string"
            ? (JSON.parse(raw) as AgentCommand)
            : (raw as AgentCommand),
        )
        .find((item) => item.type === cmd.type);
      if (existing) return existing;
      await redis.rpush(queueKey, JSON.stringify(full));
      return full;
    },
    async dequeue() {
      const raw = await redis.lpop<string>(queueKey);
      if (!raw) return null;
      return typeof raw === "string"
        ? (JSON.parse(raw) as AgentCommand)
        : (raw as AgentCommand);
    },
    async setStatus(status) {
      const prev =
        (await redis.get<{
          recording: boolean;
          publicUrl: string | null;
          publicUrlUpdatedAt: number | null;
          watchToken: string | null;
          message: string | null;
          hostname: string | null;
        }>(statusKey)) ?? {
          recording: false,
          publicUrl: null,
          publicUrlUpdatedAt: null,
          watchToken: null,
          message: null,
          hostname: null,
        };

      const currentlyLive = Boolean(
        prev.recording && prev.publicUrl && prev.watchToken,
      );
      const clearingLive =
        status.recording === false &&
        (status.publicUrl === null || status.publicUrl === undefined);
      const explicitStop =
        status.message === "Recording stopped." ||
        status.message === "Starting Cloudflare tunnel…" ||
        status.message === "Starting stream…" ||
        status.message === "Reconnecting Cloudflare tunnel…" ||
        (typeof status.message === "string" &&
          (status.message.startsWith("Failed") ||
            status.message.includes("Failed to start")));

      if (currentlyLive && clearingLive && !explicitStop) {
        await redis.set(
          hbKey,
          { at: Date.now(), hostname: status.hostname ?? prev.hostname },
          { px: HEARTBEAT_TTL_MS },
        );
        return;
      }

      const next = {
        recording: status.recording,
        publicUrl:
          status.publicUrl !== undefined ? status.publicUrl : prev.publicUrl,
        publicUrlUpdatedAt:
          status.publicUrl !== undefined
            ? status.publicUrl === null
              ? null
              : status.publicUrl !== prev.publicUrl ||
                  !prev.publicUrlUpdatedAt
                ? Date.now()
                : prev.publicUrlUpdatedAt
            : prev.publicUrlUpdatedAt,
        watchToken:
          status.watchToken !== undefined ? status.watchToken : prev.watchToken,
        message: status.message !== undefined ? status.message : prev.message,
        hostname:
          status.hostname !== undefined ? status.hostname : prev.hostname,
      };
      await redis.set(statusKey, next);
      await redis.set(
        hbKey,
        { at: Date.now(), hostname: next.hostname },
        { px: HEARTBEAT_TTL_MS },
      );
    },
  };
}

export function getStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createRedisStore(new Redis({ url, token }));
  }
  return createFileStore();
}

export function getDashboardPassword(): string {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) throw new Error("DASHBOARD_PASSWORD is not set");
  return password;
}

export function getAgentToken(): string {
  const token = process.env.AGENT_TOKEN?.trim();
  if (!token) throw new Error("AGENT_TOKEN is not set");
  return token;
}
