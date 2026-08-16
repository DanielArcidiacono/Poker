import assert from "node:assert/strict";
import test from "node:test";
import { startControlPlane } from "../src/control-plane.js";

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("desired state stops sharing and failed live status is retried", async () => {
  const originalFetch = globalThis.fetch;
  let shouldShare = true;
  let revision = "1";
  let running = false;
  let publicUrl: string | null = null;
  let stopCount = 0;
  let watchToken: string | null = null;
  let failedLiveStatus = false;
  const statusBodies: Array<{
    clientId: string;
    recording: boolean;
    publicUrl: string | null;
    watchToken: string | null;
    viewerCount: number;
  }> = [];
  const clientId = "11111111-1111-4111-8111-111111111111";

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/agent/poll")) {
      if (init?.method !== "DELETE") {
        const body = JSON.parse(String(init?.body)) as { clientId: string };
        assert.equal(body.clientId, clientId);
      }
      return Response.json({
        isOwner: true,
        shouldShare,
        sharingRevision: revision,
      });
    }
    if (url.endsWith("/api/agent/status")) {
      const body = JSON.parse(String(init?.body)) as (typeof statusBodies)[number];
      statusBodies.push(body);
      if (body.recording && !failedLiveStatus) {
        failedLiveStatus = true;
        return new Response(null, { status: 503 });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const handle = startControlPlane({
    baseUrl: "https://dashboard.example",
    token: "test-token",
    clientId,
    pollMs: 10,
    tunnel: {
      async startQuick() {
        running = true;
        publicUrl = "https://quiet-river.trycloudflare.com";
        return publicUrl;
      },
      stop() {
        stopCount += 1;
        running = false;
        publicUrl = null;
      },
      getStatus() {
        return { running, mode: running ? "quick" : "idle", publicUrl };
      },
    },
    onWatchToken(token) {
      watchToken = token;
    },
  });

  try {
    await waitFor(
      () => statusBodies.filter((body) => body.recording).length >= 2,
    );
    assert.equal(failedLiveStatus, true);
    assert.ok(watchToken);
    handle.setViewerCount(2);
    await waitFor(() => statusBodies.some((body) => body.viewerCount === 2));
    assert.ok(statusBodies.every((body) => body.clientId === clientId));

    shouldShare = false;
    revision = "2";
    await waitFor(
      () =>
        watchToken === null &&
        statusBodies.some(
          (body) =>
            !body.recording &&
            body.publicUrl === null &&
            body.watchToken === null,
        ),
    );
    assert.ok(stopCount >= 2);
  } finally {
    await handle.stop();
    globalThis.fetch = originalFetch;
  }
});

test("sharing fails closed when the dashboard lease can no longer be renewed", async () => {
  const originalFetch = globalThis.fetch;
  let dashboardReachable = true;
  let running = false;
  let watchToken: string | null = null;
  let becameLive = false;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/agent/poll")) {
      if (!dashboardReachable) throw new Error("dashboard offline");
      return Response.json({
        isOwner: true,
        shouldShare: true,
        sharingRevision: "live-revision",
      });
    }
    if (url.endsWith("/api/agent/status")) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const handle = startControlPlane({
    baseUrl: "https://dashboard.example",
    token: "test-token",
    clientId: "77777777-7777-4777-8777-777777777777",
    pollMs: 5,
    disconnectGraceMs: 20,
    tunnel: {
      async startQuick() {
        running = true;
        becameLive = true;
        return "https://fail-closed.trycloudflare.com";
      },
      stop() {
        running = false;
      },
      getStatus() {
        return {
          running,
          mode: running ? "quick" : "idle",
          publicUrl: running
            ? "https://fail-closed.trycloudflare.com"
            : null,
        };
      },
    },
    onWatchToken(token) {
      watchToken = token;
    },
  });

  try {
    await waitFor(() => becameLive && Boolean(watchToken));
    dashboardReachable = false;
    await waitFor(() => !running && watchToken === null, 500);
  } finally {
    await handle.stop();
    globalThis.fetch = originalFetch;
  }
});
