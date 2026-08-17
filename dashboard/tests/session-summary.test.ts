import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSession } from "../src/lib/session-summary";
import type { SessionReport } from "../src/lib/store";

function report(
  platform: SessionReport["platform"],
  hostname: string | null = null,
): SessionReport {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    online: true,
    lastSeen: 123,
    desiredSharing: false,
    sharingRevision: "0",
    recording: false,
    publicUrl: null,
    publicUrlUpdatedAt: null,
    watchToken: null,
    viewerCount: 0,
    message: "Ready to share.",
    hostname,
    platform,
    product: "Prostar",
    version: "1.1.0",
  };
}

test("session summaries carry platform and use platform-aware fallback names", () => {
  assert.deepEqual(
    {
      name: summarizeSession(report("windows")).name,
      platform: summarizeSession(report("windows")).platform,
    },
    { name: "Windows PC 11111111", platform: "windows" },
  );
  assert.equal(summarizeSession(report("macos")).name, "Mac 11111111");
  assert.equal(summarizeSession(report(null)).name, "Device 11111111");
  assert.equal(
    summarizeSession(report("windows", "DESKTOP-PROSTAR")).name,
    "DESKTOP-PROSTAR",
  );
});
