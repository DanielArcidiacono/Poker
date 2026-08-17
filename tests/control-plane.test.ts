import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAgentPlatform,
  resolveDeviceDisplayName,
  resolveMacDisplayName,
  startControlPlane,
} from "../src/control-plane.js";

test("Mac display name prefers stable System Configuration names", () => {
  assert.equal(
    resolveMacDisplayName(
      (preference) =>
        preference === "ComputerName" ? "  Studio Mac  \n" : "ignored",
      () => "mac.localdomain",
    ),
    "Studio Mac",
  );
  assert.equal(
    resolveMacDisplayName(
      (preference) => {
        if (preference === "ComputerName") throw new Error("unset");
        return "prostar-mac\n";
      },
      () => "mac.localdomain",
    ),
    "prostar-mac",
  );
  assert.equal(
    resolveMacDisplayName(
      () => {
        throw new Error("unavailable");
      },
      () => "mac.localdomain",
    ),
    "mac.localdomain",
  );
});

test("device identity uses Windows COMPUTERNAME and reports a stable platform", () => {
  assert.equal(
    resolveDeviceDisplayName({
      platform: "win32",
      computerName: () => "  PROSTAR-PC  ",
      hostname: () => "network-name.example",
    }),
    "PROSTAR-PC",
  );
  assert.equal(
    resolveDeviceDisplayName({
      platform: "win32",
      computerName: () => "",
      hostname: () => "fallback-pc",
    }),
    "fallback-pc",
  );
  assert.equal(resolveAgentPlatform("darwin"), "macos");
  assert.equal(resolveAgentPlatform("win32"), "windows");
  assert.equal(resolveAgentPlatform("linux"), "other");
});

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
    platform: "macos" | "windows" | "other";
  }> = [];
  const clientId = "11111111-1111-4111-8111-111111111111";

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/agent/poll")) {
      if (init?.method !== "DELETE") {
        const body = JSON.parse(String(init?.body)) as {
          clientId: string;
          platform: string;
        };
        assert.equal(body.clientId, clientId);
        assert.equal(body.platform, resolveAgentPlatform());
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
    assert.equal(handle.isConnected(), true);
    assert.equal(failedLiveStatus, true);
    assert.ok(watchToken);
    handle.setViewerCount(2);
    await waitFor(() => statusBodies.some((body) => body.viewerCount === 2));
    assert.ok(statusBodies.every((body) => body.clientId === clientId));
    assert.ok(
      statusBodies.every(
        (body) => body.platform === resolveAgentPlatform(),
      ),
    );

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
    assert.equal(handle.isConnected(), false);
  } finally {
    await handle.stop();
    globalThis.fetch = originalFetch;
  }
});
