import assert from "node:assert/strict";
import test from "node:test";
import { getStore } from "../src/lib/store";

const REDIS_ENVIRONMENT_NAMES = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_KV_REST_API_URL",
  "UPSTASH_REDIS_REST_KV_REST_API_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

function preserveEnvironment(names: readonly string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function clearEnvironment(names: readonly string[]): void {
  for (const name of names) delete process.env[name];
}

test("sessions own independent leases, desired state, and streams", async () => {
  const restoreEnvironment = preserveEnvironment(REDIS_ENVIRONMENT_NAMES);
  clearEnvironment(REDIS_ENVIRONMENT_NAMES);

  const firstClient = "11111111-1111-4111-8111-111111111111";
  const secondClient = "22222222-2222-4222-8222-222222222222";
  const firstInstance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondInstance = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  try {
    const store = getStore();
    assert.equal(
      await store.enrollSession(firstClient, "hash-one"),
      true,
    );
    assert.equal(
      await store.enrollSession(secondClient, "hash-two"),
      true,
    );
    assert.equal(
      await store.verifySessionCredential(firstClient, "hash-one"),
      true,
    );
    assert.equal(
      await store.verifySessionCredential(firstClient, "hash-two"),
      false,
    );

    assert.equal(await store.claimAgent(firstClient, firstInstance), true);
    assert.equal(await store.claimAgent(secondClient, secondInstance), true);
    assert.equal(
      await store.claimAgent(
        firstClient,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
      false,
    );
    await store.heartbeat(firstClient, {
      hostname: "Alpha Mac",
      product: "Prostar",
      version: "1.0.0",
    });
    await store.heartbeat(secondClient, {
      hostname: "Beta Mac",
      product: "Prostar",
      version: "1.0.0",
    });

    const firstRevision = await store.setSharing(
      firstClient,
      true,
      "Starting secure tunnel…",
    );
    assert.equal((await store.getSession(secondClient)).desiredSharing, false);

    assert.equal(
      await store.setStatus(firstClient, {
        recording: true,
        publicUrl: "https://stale.trycloudflare.com",
        watchToken: "stale",
        sharingRevision: "old-revision",
        agentInstanceId: firstInstance,
      }),
      false,
    );
    assert.equal(
      await store.setStatus(firstClient, {
        recording: true,
        publicUrl: "https://current.trycloudflare.com",
        watchToken: "current",
        viewerCount: 2,
        sharingRevision: firstRevision,
        agentInstanceId: firstInstance,
      }),
      true,
    );

    const first = await store.getSession(firstClient);
    assert.equal(first.recording, true);
    assert.equal(first.viewerCount, 2);
    assert.equal((await store.getSession(secondClient)).recording, false);
    assert.deepEqual(
      (await store.listSessions()).map((session) => session.hostname),
      ["Alpha Mac", "Beta Mac"],
    );

    await store.setSharing(firstClient, false, "Stopping sharing…");
    const stopped = await store.getSession(firstClient);
    assert.equal(stopped.recording, false);
    assert.equal(stopped.publicUrl, null);
    assert.equal(stopped.watchToken, null);
    assert.equal((await store.getSession(secondClient)).desiredSharing, false);
  } finally {
    restoreEnvironment();
  }
});

test("accepts Vercel marketplace and standard KV Redis variables", () => {
  const environmentNames = [
    ...REDIS_ENVIRONMENT_NAMES,
    "NODE_ENV",
    "PROSTAR_ALLOW_EPHEMERAL_STORE",
  ] as const;
  const restoreEnvironment = preserveEnvironment(environmentNames);
  clearEnvironment(environmentNames);
  Reflect.set(process.env, "NODE_ENV", "production");

  try {
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL =
      "https://marketplace.example.upstash.io";
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = "marketplace-token";
    assert.doesNotThrow(() => getStore());

    clearEnvironment(REDIS_ENVIRONMENT_NAMES);
    process.env.KV_REST_API_URL = "https://kv.example.upstash.io";
    process.env.KV_REST_API_TOKEN = "kv-token";
    assert.doesNotThrow(() => getStore());

    delete process.env.KV_REST_API_TOKEN;
    assert.throws(
      () => getStore(),
      /KV_REST_API_URL and KV_REST_API_TOKEN must be configured together/,
    );
  } finally {
    restoreEnvironment();
  }
});

test("provisional credentials expire unless setup explicitly activates them", async () => {
  const restoreEnvironment = preserveEnvironment(REDIS_ENVIRONMENT_NAMES);
  clearEnvironment(REDIS_ENVIRONMENT_NAMES);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    const store = getStore();
    const expiringClient = "33333333-3333-4333-8333-333333333333";
    const activeClient = "44444444-4444-4444-8444-444444444444";
    assert.equal(
      await store.enrollSession(expiringClient, "expiring"),
      true,
    );
    assert.equal(
      await store.enrollSession(activeClient, "durable"),
      true,
    );
    assert.equal(
      await store.activateSessionCredential(
        activeClient,
        "durable",
      ),
      true,
    );

    now += 60 * 60_000 + 1;
    assert.equal(
      await store.verifySessionCredential(expiringClient, "expiring"),
      false,
    );
    assert.equal(
      await store.verifySessionCredential(activeClient, "durable"),
      true,
    );
  } finally {
    Date.now = originalNow;
    restoreEnvironment();
  }
});
