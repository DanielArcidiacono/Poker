import assert from "node:assert/strict";
import test from "node:test";
import { buildWatchProbeUrl } from "../src/lib/watch-probe";

test("watch readiness probes the exact tunnel origin with a cache buster", () => {
  assert.equal(
    buildWatchProbeUrl(
      "https://quiet-river.trycloudflare.com",
      7,
    ),
    "https://quiet-river.trycloudflare.com/styles.css?prostar-watch-probe=7",
  );
});
