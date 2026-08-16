import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scripts = [
  "scripts/bootstrap.sh",
  "scripts/install-agent.sh",
  "scripts/prostar-admin.sh",
  "scripts/uninstall-agent.sh",
];

test("distribution and admin scripts are valid Bash", () => {
  const parsed = spawnSync("bash", ["-n", ...scripts], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("public bootstrap is pinned, local-only, and quiet", () => {
  const script = readFileSync("scripts/bootstrap.sh", "utf8");
  assert.match(script, /PROSTAR_REF:-v1\.0\.0/);
  assert.match(script, /'AUTO_TUNNEL=0'/);
  assert.match(script, /'CONTROL_PLANE_URL='/);
  assert.doesNotMatch(script, /cloudflared/);
  assert.equal(
    script.match(/Prostar installed successfully\./g)?.length,
    1,
  );
  assert.match(
    script,
    /Prostar installation failed\. See %s/,
  );
});

test("admin command exposes explicit lifecycle and diagnostic controls", () => {
  const script = readFileSync("scripts/prostar-admin.sh", "utf8");
  for (const command of [
    "status",
    "start",
    "stop",
    "restart",
    "logs",
    "preflight",
    "open",
    "password",
    "uninstall",
  ]) {
    assert.match(script, new RegExp(`\\b${command}\\b`));
  }
});
