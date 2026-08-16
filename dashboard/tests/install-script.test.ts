import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildInstallScript } from "../src/lib/install-script";

test("generated Prostar installer is valid Bash and carries only scoped identity", () => {
  const script = buildInstallScript({
    controlPlane: "https://dashboard.example",
    clientId: "55555555-5555-4555-8555-555555555555",
    agentCredential: "scoped-prostar-secret-000000000000",
    viewerPassword: "viewer-password-000000000000000",
  });
  const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(script, /PROSTAR_CLIENT_ID/);
  assert.match(script, /PROSTAR_AGENT_SECRET/);
  assert.doesNotMatch(script, /AGENT_TOKEN_VALUE/);
  assert.doesNotMatch(script, /SCREEN VIEWER IS READY/);
  assert.match(script, /Prostar installed successfully\./);
  assert.match(
    script,
    /INSTALL_LOG_DIR="\$HOME\/Library\/Logs\/Prostar"/,
  );
  assert.match(script, /INSTALL_LOG="\$INSTALL_LOG_DIR\/install\.log"/);
  assert.match(script, /shasum -a 256 -c prostar-agent\.tgz\.sha256/);
  assert.match(script, /npm ci --foreground-scripts/);
  assert.equal(
    script.match(/Prostar installed successfully\./g)?.length,
    1,
  );
  assert.equal(script.match(/>&3/g)?.length, 1);
  assert.match(script, /--rollback-install/);
  assert.match(script, /--finalize-install/);
  assert.doesNotMatch(script, /DEFER_START/);
  assert.match(script, /mv -hf \"\$NEXT_LINK\" \"\$CURRENT_PATH\"/);
  assert.ok(
    script.indexOf('! -L "$CURRENT_PATH"') <
      script.indexOf("npm run install-agent"),
    "the current-link safety check must run before launchd handoff",
  );
});
