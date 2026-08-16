import { Redis } from "@upstash/redis";
import { timingSafeEqual } from "node:crypto";

export type SessionReport = {
  id: string;
  online: boolean;
  lastSeen: number | null;
  desiredSharing: boolean;
  sharingRevision: string;
  recording: boolean;
  publicUrl: string | null;
  publicUrlUpdatedAt: number | null;
  watchToken: string | null;
  viewerCount: number;
  message: string | null;
  hostname: string | null;
  product: string;
  version: string | null;
};

export type StatusPayload = {
  recording: boolean;
  publicUrl?: string | null;
  watchToken?: string | null;
  viewerCount?: number;
  message?: string | null;
  hostname?: string | null;
  product?: string | null;
  version?: string | null;
  sharingRevision?: string | null;
  agentInstanceId?: string | null;
};

type Heartbeat = {
  at: number;
  hostname: string | null;
  product: string;
  version: string | null;
};

type DesiredState = {
  enabled: boolean;
  revision: string;
};

type StoredStatus = {
  recording: boolean;
  publicUrl: string | null;
  publicUrlUpdatedAt: number | null;
  watchToken: string | null;
  viewerCount: number;
  message: string | null;
  hostname: string | null;
  product: string;
  version: string | null;
  statusRevision: string | null;
};

type MemorySession = StoredStatus & {
  credentialHash: string | null;
  lastSeen: number | null;
  desiredSharing: boolean;
  sharingRevision: string;
  lease: { instanceId: string; expiresAt: number } | null;
};

export type Store = {
  enrollSession: (
    clientId: string,
    credentialHash: string,
  ) => Promise<boolean>;
  verifySessionCredential: (
    clientId: string,
    credentialHash: string,
  ) => Promise<boolean>;
  claimAgent: (clientId: string, instanceId: string) => Promise<boolean>;
  releaseAgent: (
    clientId: string | null,
    instanceId: string,
  ) => Promise<void>;
  heartbeat: (
    clientId: string,
    info: {
      hostname?: string;
      product?: string;
      version?: string;
    },
  ) => Promise<void>;
  migrateLegacySession: (clientId: string) => Promise<void>;
  getDesiredState: (clientId: string) => Promise<{
    desiredSharing: boolean;
    sharingRevision: string;
  }>;
  getSession: (clientId: string) => Promise<SessionReport>;
  listSessions: () => Promise<SessionReport[]>;
  setSharing: (
    clientId: string,
    desired: boolean,
    message: string,
  ) => Promise<string>;
  setStatus: (clientId: string, status: StatusPayload) => Promise<boolean>;
};

/** Agents can spend tens of seconds starting a tunnel without looking dead. */
export const HEARTBEAT_TTL_MS = 70_000;
const AGENT_LEASE_TTL_MS = 90_000;
const PRODUCT_NAME = "Prostar";
const SESSION_INDEX = "prostar:sessions";
const REDIS_ENVIRONMENT_PAIRS = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  [
    "UPSTASH_REDIS_REST_KV_REST_API_URL",
    "UPSTASH_REDIS_REST_KV_REST_API_TOKEN",
  ],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
] as const;

function emptyStatus(): StoredStatus {
  return {
    recording: false,
    publicUrl: null,
    publicUrlUpdatedAt: null,
    watchToken: null,
    viewerCount: 0,
    message: null,
    hostname: null,
    product: PRODUCT_NAME,
    version: null,
    statusRevision: null,
  };
}

function emptyMemorySession(): MemorySession {
  return {
    ...emptyStatus(),
    credentialHash: null,
    lastSeen: null,
    desiredSharing: false,
    sharingRevision: "0",
    lease: null,
  };
}

const local = globalThis as typeof globalThis & {
  prostarSessions?: Map<string, MemorySession>;
  prostarInstanceClients?: Map<string, string>;
  prostarStore?: Store;
  prostarStoreConfig?: string;
  screenViewerState?: Partial<MemorySession>;
};

function memorySessions(): Map<string, MemorySession> {
  local.prostarSessions ??= new Map();
  return local.prostarSessions;
}

function memoryInstanceClients(): Map<string, string> {
  local.prostarInstanceClients ??= new Map();
  return local.prostarInstanceClients;
}

function memorySession(clientId: string): MemorySession {
  const sessions = memorySessions();
  let session = sessions.get(clientId);
  if (!session) {
    session = emptyMemorySession();
    sessions.set(clientId, session);
  }
  return session;
}

function credentialsMatch(stored: string | null, provided: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeDesired(value: DesiredState | boolean | null): DesiredState {
  if (value && typeof value === "object") return value;
  return { enabled: value === true, revision: "0" };
}

function reportFrom(
  clientId: string,
  heartbeat: Heartbeat | null,
  status: StoredStatus | null,
  desiredValue: DesiredState | boolean | null,
): SessionReport {
  const desired = normalizeDesired(desiredValue);
  const lastSeen = heartbeat?.at ?? null;
  const online = Boolean(
    lastSeen && Date.now() - lastSeen < HEARTBEAT_TTL_MS,
  );
  const currentStatus = status ?? emptyStatus();
  const statusIsCurrent = currentStatus.statusRevision === desired.revision;
  const canExposeStream = desired.enabled && statusIsCurrent;

  return {
    id: clientId,
    online,
    lastSeen,
    desiredSharing: desired.enabled,
    sharingRevision: desired.revision,
    recording: canExposeStream ? currentStatus.recording : false,
    publicUrl: canExposeStream ? currentStatus.publicUrl : null,
    publicUrlUpdatedAt: canExposeStream
      ? currentStatus.publicUrlUpdatedAt
      : null,
    watchToken: canExposeStream ? currentStatus.watchToken : null,
    viewerCount:
      canExposeStream && currentStatus.recording
        ? Math.max(0, currentStatus.viewerCount)
        : 0,
    message: currentStatus.message,
    hostname: currentStatus.hostname ?? heartbeat?.hostname ?? null,
    product: currentStatus.product || heartbeat?.product || PRODUCT_NAME,
    version: currentStatus.version ?? heartbeat?.version ?? null,
  };
}

function mergeStatus(
  previous: StoredStatus,
  update: StatusPayload,
  now = Date.now(),
  allowClear = false,
): StoredStatus | null {
  const currentlyLive = Boolean(
    previous.recording && previous.publicUrl && previous.watchToken,
  );
  const clearingLive =
    update.recording === false &&
    (update.publicUrl === null || update.publicUrl === undefined);
  const explicitStop =
    update.message === "Ready to share." ||
    update.message === "Sharing stopped." ||
    update.message === "Recording stopped." ||
    update.message === "Starting secure tunnel…" ||
    update.message === "Starting Cloudflare tunnel…" ||
    update.message === "Starting stream…" ||
    update.message === "Reconnecting Cloudflare tunnel…" ||
    (typeof update.message === "string" &&
      (update.message.startsWith("Failed") ||
        update.message.includes("Failed to start")));

  if (currentlyLive && clearingLive && !explicitStop && !allowClear) return null;

  const nextPublicUrl =
    update.publicUrl !== undefined ? update.publicUrl : previous.publicUrl;
  return {
    recording: update.recording,
    publicUrl: nextPublicUrl,
    publicUrlUpdatedAt:
      update.publicUrl === undefined
        ? previous.publicUrlUpdatedAt
        : update.publicUrl === null
          ? null
          : update.publicUrl !== previous.publicUrl ||
              !previous.publicUrlUpdatedAt
            ? now
            : previous.publicUrlUpdatedAt,
    watchToken:
      update.watchToken !== undefined
        ? update.watchToken
        : previous.watchToken,
    viewerCount:
      update.viewerCount !== undefined
        ? Math.max(0, Math.floor(update.viewerCount))
        : previous.viewerCount,
    message:
      update.message !== undefined ? update.message : previous.message,
    hostname:
      update.hostname !== undefined ? update.hostname : previous.hostname,
    product: update.product?.trim() || previous.product || PRODUCT_NAME,
    version:
      update.version !== undefined ? update.version : previous.version,
    statusRevision:
      update.sharingRevision !== undefined
        ? update.sharingRevision
        : previous.statusRevision,
  };
}

function reportFromMemory(clientId: string, session: MemorySession): SessionReport {
  return reportFrom(
    clientId,
    session.lastSeen
      ? {
          at: session.lastSeen,
          hostname: session.hostname,
          product: session.product,
          version: session.version,
        }
      : null,
    session,
    {
      enabled: session.desiredSharing,
      revision: session.sharingRevision,
    },
  );
}

function createMemoryStore(): Store {
  return {
    async enrollSession(clientId, credentialHash) {
      const session = memorySession(clientId);
      if (
        session.credentialHash &&
        !credentialsMatch(session.credentialHash, credentialHash)
      ) {
        return false;
      }
      session.credentialHash = credentialHash;
      return true;
    },
    async verifySessionCredential(clientId, credentialHash) {
      return credentialsMatch(
        memorySessions().get(clientId)?.credentialHash ?? null,
        credentialHash,
      );
    },
    async claimAgent(clientId, instanceId) {
      const session = memorySession(clientId);
      if (
        session.lease &&
        session.lease.expiresAt > Date.now() &&
        session.lease.instanceId !== instanceId
      ) {
        return false;
      }
      session.lease = {
        instanceId,
        expiresAt: Date.now() + AGENT_LEASE_TTL_MS,
      };
      memoryInstanceClients().set(instanceId, clientId);
      return true;
    },
    async releaseAgent(clientId, instanceId) {
      const resolvedId = clientId ?? memoryInstanceClients().get(instanceId);
      if (!resolvedId) return;
      const session = memorySessions().get(resolvedId);
      if (session?.lease?.instanceId === instanceId) {
        session.lease = null;
        session.lastSeen = null;
      }
      memoryInstanceClients().delete(instanceId);
    },
    async heartbeat(clientId, info) {
      const session = memorySession(clientId);
      session.lastSeen = Date.now();
      if (info.hostname) session.hostname = info.hostname;
      if (info.product) session.product = info.product;
      if (info.version) session.version = info.version;
    },
    async migrateLegacySession(clientId) {
      if (memorySessions().has(clientId) || !local.screenViewerState) return;
      const legacy = local.screenViewerState;
      Object.assign(memorySession(clientId), {
        ...legacy,
        product: PRODUCT_NAME,
        lease: null,
      });
    },
    async getSession(clientId) {
      return reportFromMemory(clientId, memorySession(clientId));
    },
    async listSessions() {
      return [...memorySessions()]
        .map(([id, session]) => reportFromMemory(id, session))
        .filter((session) => session.online)
        .sort((a, b) =>
          (a.hostname ?? a.id).localeCompare(b.hostname ?? b.id),
        );
    },
    async getDesiredState(clientId) {
      const session = memorySession(clientId);
      return {
        desiredSharing: session.desiredSharing,
        sharingRevision: session.sharingRevision,
      };
    },
    async setSharing(clientId, desired, message) {
      const session = memorySession(clientId);
      const revision = crypto.randomUUID();
      session.desiredSharing = desired;
      session.sharingRevision = revision;
      Object.assign(session, {
        recording: false,
        publicUrl: null,
        publicUrlUpdatedAt: null,
        watchToken: null,
        viewerCount: 0,
        message,
        statusRevision: null,
      });
      return revision;
    },
    async setStatus(clientId, status) {
      const session = memorySession(clientId);
      if (
        !status.agentInstanceId ||
        !session.lease ||
        session.lease.expiresAt <= Date.now() ||
        session.lease.instanceId !== status.agentInstanceId
      ) {
        return false;
      }
      if (
        status.sharingRevision !== session.sharingRevision ||
        (status.recording && !session.desiredSharing)
      ) {
        return false;
      }
      const next = mergeStatus(
        session,
        status,
        Date.now(),
        !session.desiredSharing,
      );
      if (!next) return false;
      Object.assign(session, next);
      session.lastSeen = Date.now();
      return true;
    },
  };
}

function sessionKeys(clientId: string) {
  const prefix = `prostar:session:${clientId}`;
  return {
    heartbeat: `${prefix}:heartbeat`,
    status: `${prefix}:status`,
    desired: `${prefix}:desired`,
    lease: `${prefix}:lease`,
    credential: `${prefix}:credential`,
  };
}

function instanceKey(instanceId: string): string {
  return `prostar:instance:${instanceId}`;
}

function createRedisStore(redis: Redis): Store {
  async function readSession(clientId: string): Promise<SessionReport> {
    const keys = sessionKeys(clientId);
    const [heartbeat, status, desired] = await redis.mget<[
      Heartbeat | null,
      StoredStatus | null,
      DesiredState | boolean | null,
    ]>(keys.heartbeat, keys.status, keys.desired);
    return reportFrom(clientId, heartbeat, status, desired);
  }

  return {
    async enrollSession(clientId, credentialHash) {
      const key = sessionKeys(clientId).credential;
      const stored = await redis.get<string>(key);
      if (stored) return credentialsMatch(stored, credentialHash);
      const result = await redis.set(key, credentialHash, { nx: true });
      if (result === "OK") return true;
      return credentialsMatch(await redis.get<string>(key), credentialHash);
    },
    async verifySessionCredential(clientId, credentialHash) {
      return credentialsMatch(
        await redis.get<string>(sessionKeys(clientId).credential),
        credentialHash,
      );
    },
    async claimAgent(clientId, instanceId) {
      const keys = sessionKeys(clientId);
      const claimed = await redis.eval<[string, string], number>(
        `local current = redis.call("get", KEYS[1])
if (not current) or current == ARGV[1] then
  redis.call("psetex", KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0`,
        [keys.lease],
        [instanceId, String(AGENT_LEASE_TTL_MS)],
      );
      if (claimed === 1) {
        await redis.set(instanceKey(instanceId), clientId, {
          px: AGENT_LEASE_TTL_MS,
        });
      }
      return claimed === 1;
    },
    async releaseAgent(clientId, instanceId) {
      const resolvedId =
        clientId ?? (await redis.get<string>(instanceKey(instanceId)));
      if (!resolvedId) return;
      const keys = sessionKeys(resolvedId);
      await redis.eval<[string], number>(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("del", KEYS[1])
  redis.call("del", KEYS[2])
  redis.call("del", KEYS[3])
  return 1
end
return 0`,
        [keys.lease, keys.heartbeat, instanceKey(instanceId)],
        [instanceId],
      );
    },
    async heartbeat(clientId, info) {
      const now = Date.now();
      const keys = sessionKeys(clientId);
      const pipeline = redis.pipeline();
      pipeline.set(
        keys.heartbeat,
        {
          at: now,
          hostname: info.hostname ?? null,
          product: info.product?.trim() || PRODUCT_NAME,
          version: info.version?.trim() || null,
        } satisfies Heartbeat,
        { px: HEARTBEAT_TTL_MS },
      );
      pipeline.zadd(SESSION_INDEX, { score: now, member: clientId });
      pipeline.zremrangebyscore(
        SESSION_INDEX,
        "-inf",
        now - HEARTBEAT_TTL_MS,
      );
      await pipeline.exec();
    },
    async migrateLegacySession(clientId) {
      const keys = sessionKeys(clientId);
      const [currentDesired, oldDesired, currentStatus, oldStatus, oldHeartbeat] =
        await redis.mget<[
          DesiredState | boolean | null,
          DesiredState | boolean | null,
          StoredStatus | null,
          StoredStatus | null,
          Heartbeat | null,
        ]>(
          keys.desired,
          "sv:sharing:desired",
          keys.status,
          "sv:agent:status",
          "sv:agent:heartbeat",
        );
      if (
        currentDesired !== null ||
        (!oldDesired && !oldStatus && !oldHeartbeat)
      ) {
        return;
      }
      const pipeline = redis.pipeline();
      if (oldDesired !== null) pipeline.set(keys.desired, oldDesired);
      if (currentStatus === null && oldStatus) {
        pipeline.set(keys.status, {
          ...emptyStatus(),
          ...oldStatus,
          product: PRODUCT_NAME,
          viewerCount: oldStatus.viewerCount ?? 0,
        });
      }
      if (oldHeartbeat) {
        pipeline.zadd(SESSION_INDEX, {
          score: oldHeartbeat.at,
          member: clientId,
        });
      }
      await pipeline.exec();
    },
    getSession: readSession,
    async listSessions() {
      const ids = await redis.zrange<string[]>(
        SESSION_INDEX,
        Date.now() - HEARTBEAT_TTL_MS,
        "+inf",
        { byScore: true },
      );
      if (ids.length === 0) return [];

      const keys = ids.flatMap((id) => {
        const key = sessionKeys(id);
        return [key.heartbeat, key.status, key.desired];
      });
      const values = await redis.mget<
        Array<Heartbeat | StoredStatus | DesiredState | boolean | null>
      >(...keys);
      const sessions = ids.map((id, index) =>
        reportFrom(
          id,
          (values[index * 3] as Heartbeat | null) ?? null,
          (values[index * 3 + 1] as StoredStatus | null) ?? null,
          (values[index * 3 + 2] as DesiredState | boolean | null) ?? null,
        ),
      );
      return sessions
        .filter((session) => session.online)
        .sort((a, b) =>
          (a.hostname ?? a.id).localeCompare(b.hostname ?? b.id),
        );
    },
    async getDesiredState(clientId) {
      const desired = await redis.get<DesiredState | boolean>(
        sessionKeys(clientId).desired,
      );
      const normalized = normalizeDesired(desired);
      return {
        desiredSharing: normalized.enabled,
        sharingRevision: normalized.revision,
      };
    },
    async setSharing(clientId, desired, message) {
      const keys = sessionKeys(clientId);
      const previous = await redis.get<StoredStatus>(keys.status);
      const revision = crypto.randomUUID();
      const transaction = redis.multi();
      transaction.set(keys.desired, {
        enabled: desired,
        revision,
      } satisfies DesiredState);
      transaction.set(keys.status, {
        ...emptyStatus(),
        hostname: previous?.hostname ?? null,
        product: previous?.product ?? PRODUCT_NAME,
        version: previous?.version ?? null,
        message,
      } satisfies StoredStatus);
      await transaction.exec();
      return revision;
    },
    async setStatus(clientId, status) {
      const keys = sessionKeys(clientId);
      const [stored, desiredValue, leaseOwner] = await redis.mget<[
        StoredStatus | null,
        DesiredState | boolean | null,
        string | null,
      ]>(keys.status, keys.desired, keys.lease);
      const previous = stored ?? emptyStatus();
      const desired = normalizeDesired(desiredValue);
      if (!status.agentInstanceId || leaseOwner !== status.agentInstanceId) {
        return false;
      }
      if (
        status.sharingRevision !== desired.revision ||
        (status.recording && !desired.enabled)
      ) {
        return false;
      }
      const next = mergeStatus(
        previous,
        status,
        Date.now(),
        !desired.enabled,
      );
      if (!next) return false;

      const now = Date.now();
      const pipeline = redis.pipeline();
      pipeline.set(keys.status, next);
      pipeline.set(
        keys.heartbeat,
        {
          at: now,
          hostname: status.hostname ?? next.hostname,
          product: status.product?.trim() || next.product || PRODUCT_NAME,
          version: status.version ?? next.version,
        } satisfies Heartbeat,
        { px: HEARTBEAT_TTL_MS },
      );
      pipeline.zadd(SESSION_INDEX, { score: now, member: clientId });
      await pipeline.exec();
      return true;
    },
  };
}

export function getStore(): Store {
  let url: string | undefined;
  let token: string | undefined;
  for (const [urlName, tokenName] of REDIS_ENVIRONMENT_PAIRS) {
    const candidateUrl = process.env[urlName];
    const candidateToken = process.env[tokenName];
    if ((candidateUrl && !candidateToken) || (!candidateUrl && candidateToken)) {
      throw new Error(`${urlName} and ${tokenName} must be configured together`);
    }
    if (candidateUrl && candidateToken) {
      url = candidateUrl;
      token = candidateToken;
      break;
    }
  }
  if (
    !url &&
    !token &&
    process.env.NODE_ENV === "production" &&
    process.env.PROSTAR_ALLOW_EPHEMERAL_STORE !== "1"
  ) {
    throw new Error(
      "Persistent Redis storage is required in production so Prostar sessions survive dashboard restarts",
    );
  }
  const config = url && token ? `redis:${url}\0${token}` : "memory";
  if (local.prostarStore && local.prostarStoreConfig === config) {
    return local.prostarStore;
  }
  local.prostarStore =
    url && token
      ? createRedisStore(new Redis({ url, token }))
      : createMemoryStore();
  local.prostarStoreConfig = config;
  return local.prostarStore;
}
