import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scripts = [
  "scripts/bootstrap.sh",
  "scripts/ensure-runtime.sh",
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
  assert.match(script, /PROSTAR_REF:-v1\.1\.0/);
  assert.match(script, /'AUTO_TUNNEL=0'/);
  assert.match(script, /'CONTROL_PLANE_URL='/);
  assert.doesNotMatch(script, /cloudflared/);
  assert.match(script, /ensure-runtime\.sh" --node-only/);
  assert.match(script, /runtime\/bin/);
  assert.match(script, /npm_config_cache="\$APP_ROOT\/runtime\/npm-cache"/);
  assert.doesNotMatch(script, /\bbrew\b/);
  assert.equal(
    script.match(/Prostar installed successfully\./g)?.length,
    1,
  );
  assert.match(
    script,
    /Prostar installation failed\. See %s/,
  );
});

test("agent installs keep npm state inside Prostar's private runtime", () => {
  const script = readFileSync("scripts/install-agent.sh", "utf8");
  assert.match(script, /npm_config_cache="\$APP_ROOT\/runtime\/npm-cache"/);
  assert.match(script, /npm_config_update_notifier=false/);
});

test("full uninstall stops exact jobs and revokes the scoped session", () => {
  const script = readFileSync("scripts/uninstall-agent.sh", "utf8");
  assert.match(script, /api\/agent\/deenroll/);
  assert.match(script, /\.pending-enrollment/);
  assert.match(script, /status.*"204"/);
  assert.doesNotMatch(script, /status.*"401"/);
  assert.match(script, /signal_captured_processes TERM/);
  assert.match(script, /signal_captured_processes KILL/);
  assert.doesNotMatch(script, /Application Support\/ScreenViewer/);
  assert.match(script, /screenviewer\.out\.log/);
  assert.match(script, /screenviewer\.err\.log/);
  assert.doesNotMatch(script, /\bpkill\b|\bkillall\b/);
});

test("private runtime is pinned, verified, and never uses package managers", () => {
  const script = readFileSync("scripts/ensure-runtime.sh", "utf8");
  assert.match(script, /NODE_VERSION="24\.19\.0"/);
  assert.match(script, /CLOUDFLARED_VERSION="2026\.8\.2"/);
  assert.match(script, /shasum -a 256/);
  assert.match(script, /--proto '=https'/);
  assert.match(script, /curl -q/);
  assert.match(script, /lockf -k -t 120/);
  assert.doesNotMatch(script, /\bbrew\b|\bsudo\b/);
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
  assert.match(script, /uninstall-agent\.sh" --purge/);
});
