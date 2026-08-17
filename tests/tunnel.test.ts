import assert from "node:assert/strict";
import test from "node:test";

import { quickTunnelArgs } from "../src/tunnel.js";

test("Windows quick tunnels avoid QUIC and remain loopback-only", () => {
  assert.deepEqual(quickTunnelArgs("8787", "win32"), [
    "tunnel",
    "--protocol",
    "http2",
    "--no-prechecks",
    "--no-autoupdate",
    "--url",
    "http://127.0.0.1:8787",
  ]);
});

test("non-Windows quick tunnels retain Cloudflare transport negotiation", () => {
  assert.deepEqual(quickTunnelArgs("8787", "darwin"), [
    "tunnel",
    "--no-autoupdate",
    "--url",
    "http://127.0.0.1:8787",
  ]);
});
