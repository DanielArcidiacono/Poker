import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAgentPlatform,
  platformDisplayName,
} from "../src/lib/platform";

test("agent platforms are validated and have device-friendly labels", () => {
  assert.equal(normalizeAgentPlatform("macos"), "macos");
  assert.equal(normalizeAgentPlatform("windows"), "windows");
  assert.equal(normalizeAgentPlatform("other"), "other");
  assert.equal(normalizeAgentPlatform("win32"), null);
  assert.equal(normalizeAgentPlatform({ platform: "windows" }), null);

  assert.equal(platformDisplayName("macos"), "macOS");
  assert.equal(platformDisplayName("windows"), "Windows");
  assert.equal(platformDisplayName(null), "Device");
});
