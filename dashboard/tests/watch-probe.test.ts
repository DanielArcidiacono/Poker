import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildWatchProbeUrl,
  monitorWatchProbe,
} from "../src/lib/watch-probe";

test("watch readiness probes the exact tunnel origin with a cache buster", () => {
  assert.equal(
    buildWatchProbeUrl(
      "https://quiet-river.trycloudflare.com",
      7,
    ),
    "https://quiet-river.trycloudflare.com/styles.css?prostar-watch-probe=7",
  );
});

function createProbe() {
  let removals = 0;
  const probe = {
    onerror: null as (() => void) | null,
    onload: null as (() => void) | null,
    remove() {
      removals += 1;
    },
  };
  return { probe, removals: () => removals };
}

test("watch probe redirects once when the tunnel resource loads", () => {
  const { probe, removals } = createProbe();
  let ready = 0;
  let unavailable = 0;
  monitorWatchProbe(probe, {
    onReady: () => (ready += 1),
    onUnavailable: () => (unavailable += 1),
  });

  probe.onload?.();
  probe.onerror?.();
  assert.equal(ready, 1);
  assert.equal(unavailable, 0);
  assert.equal(removals(), 1);
});

test("watch probe reports an error without allowing late navigation", () => {
  const { probe, removals } = createProbe();
  let ready = 0;
  let unavailable = 0;
  monitorWatchProbe(probe, {
    onReady: () => (ready += 1),
    onUnavailable: () => (unavailable += 1),
  });
  const lateLoad = probe.onload;

  probe.onerror?.();
  lateLoad?.();
  assert.equal(ready, 0);
  assert.equal(unavailable, 1);
  assert.equal(removals(), 1);
});

test("watch probe times out once and cleanup suppresses late events", async () => {
  const timedOut = createProbe();
  let unavailable = 0;
  monitorWatchProbe(timedOut.probe, {
    onReady: () => assert.fail("timed-out probe must not become ready"),
    onUnavailable: () => (unavailable += 1),
    timeoutMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(unavailable, 1);
  assert.equal(timedOut.removals(), 1);

  const unmounted = createProbe();
  let callbacks = 0;
  const stop = monitorWatchProbe(unmounted.probe, {
    onReady: () => (callbacks += 1),
    onUnavailable: () => (callbacks += 1),
    timeoutMs: 1,
  });
  const lateLoad = unmounted.probe.onload;
  stop();
  lateLoad?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(callbacks, 0);
  assert.equal(unmounted.removals(), 1);
});

test("watch bridge always exposes the generation-bound direct fallback", () => {
  const bridge = readFileSync(
    "dashboard/src/components/WatchBridge.tsx",
    "utf8",
  );
  assert.match(bridge, /actionPath=\{readyPath\}/);
  assert.match(bridge, /actionLabel="Open secure link"/);
  assert.doesNotMatch(bridge, /setTimeout\(connectWhenReady/);
});
