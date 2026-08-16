import assert from "node:assert/strict";
import test from "node:test";
import { getStore } from "../src/lib/store";

test("sessions own independent leases, desired state, and streams", async () => {
  const previousUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const firstClient = "11111111-1111-4111-8111-111111111111";
  const secondClient = "22222222-2222-4222-8222-222222222222";
  const firstInstance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondInstance = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  try {
    const store = getStore();
    assert.equal(await store.enrollSession(firstClient, "hash-one"), true);
    assert.equal(await store.enrollSession(secondClient, "hash-two"), true);
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
    if (previousUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousToken;
  }
});
