import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildInstallScript } from "../src/lib/install-script";

test("generated Prostar installer is valid Bash and carries only scoped identity", () => {
  const script = buildInstallScript({
    controlPlane: "https://dashboard.example",
    clientId: "55555555-5555-4555-8555-555555555555",
    installToken:
      "9999999999.55555555-5555-4555-8555-555555555555.signed-claim",
  });
  const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(script, /PROSTAR_CLIENT_ID/);
  assert.match(script, /PROSTAR_AGENT_SECRET/);
  assert.match(script, /uuidgen/);
  assert.match(script, /credentialHash/);
  assert.doesNotMatch(script, /scoped-prostar-secret/);
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
  assert.match(script, /ensure-runtime\.sh" --with-cloudflared/);
  assert.match(script, /runtime\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
  assert.match(script, /Reusing this Mac's existing Prostar identity/);
  assert.match(script, /EXISTING_CONTROL_PLANE/);
  assert.match(script, /\/api\/agent\/verify/);
  assert.match(script, /\/api\/agent\/enroll/);
  assert.match(script, /\/api\/agent\/activate/);
  assert.match(script, /\/api\/agent\/deenroll/);
  assert.match(script, /\/api\/control-plane\/health/);
  assert.match(script, /\.pending-enrollment/);
  assert.match(script, /for _ in 1 2 3 4 5/);
  assert.match(script, /PROSTAR_CLOUDFLARED_BIN/);
  assert.doesNotMatch(script, /\bbrew\b/);
  assert.doesNotMatch(script, /Node\.js 20\.9 or later is required/);
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
  assert.ok(
    script.indexOf("/api/agent/enroll") <
      script.indexOf('echo "Downloading agent from dashboard'),
    "the short-lived setup claim must be consumed before large downloads",
  );
  assert.ok(
    script.indexOf("--with-cloudflared") <
      script.indexOf("npm ci --foreground-scripts"),
    "the private runtime must exist before npm is invoked",
  );
});
