import assert from "node:assert/strict";
import test from "node:test";
import { GET as downloadInstaller } from "../src/app/api/install-agent/raw/route";
import { createInstallToken } from "../src/lib/install-token";

test("raw installer route serves Windows PowerShell and preserves macOS default", async () => {
  process.env.PROSTAR_ENROLLMENT_SECRET = "p".repeat(48);
  const token = createInstallToken();

  const windows = await downloadInstaller(
    new Request(
      `https://dashboard.test/api/install-agent/raw?token=${encodeURIComponent(token)}&platform=windows`,
    ),
  );
  assert.equal(windows.status, 200);
  assert.match(windows.headers.get("content-type") ?? "", /^text\/plain/);
  const windowsScript = await windows.text();
  assert.match(windowsScript, /Set-StrictMode -Version 2\.0/);
  assert.match(windowsScript, /windows\\production-install\.ps1/);

  const defaultResponse = await downloadInstaller(
    new Request(
      `https://dashboard.test/api/install-agent/raw?token=${encodeURIComponent(token)}`,
    ),
  );
  assert.equal(defaultResponse.status, 200);
  assert.match(await defaultResponse.text(), /^#!\/bin\/bash/);

  const unsupported = await downloadInstaller(
    new Request(
      `https://dashboard.test/api/install-agent/raw?token=${encodeURIComponent(token)}&platform=linux`,
    ),
  );
  assert.equal(unsupported.status, 400);
});
