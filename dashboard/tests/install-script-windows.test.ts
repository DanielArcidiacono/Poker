import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildWindowsInstallScript } from "../src/lib/install-script-windows";

const options = {
  controlPlane: "https://dashboard.example",
  clientId: "55555555-5555-4555-8555-555555555555",
  installToken:
    "9999999999.55555555-5555-4555-8555-555555555555.signed-claim",
};

test("generated Windows installer is quiet, scoped, and self-contained", () => {
  const script = buildWindowsInstallScript(options);

  assert.equal(/[^\x00-\x7f]/.test(script), false);
  assert.equal(script.includes(options.installToken), false);
  assert.equal(
    script.includes(Buffer.from(options.installToken).toString("base64")),
    true,
  );
  assert.match(script, /Set-StrictMode -Version 2\.0/);
  assert.match(script, /Windows 10 version 1809 or later/);
  assert.match(script, /Arm64 requires Windows 11 or later/);
  assert.match(script, /prostar-agent\.tgz\.sha256/);
  assert.match(script, /Get-FileHash .*SHA256/);
  assert.match(script, /tar\.exe/);
  assert.match(script, /windows\\production-install\.ps1/);
  assert.match(script, /@installArguments \*> \$null/);
  assert.match(script, /tarListExitCode/);
  assert.match(script, /tarExtractExitCode/);
  assert.match(script, /Details: /);
  assert.match(script, /\$FailureMessage/);
  assert.match(script, /%LOCALAPPDATA%|LocalApplicationData/);
  assert.doesNotMatch(script, /\bwinget\b|\bchoco\b|\bscoop\b|\bnpm install -g\b/i);
  assert.doesNotMatch(script, /\\\s*$/m);
  assert.equal(
    script.match(/Prostar installed successfully\./g)?.length,
    1,
  );
  assert.equal(script.match(/Write-Output/g)?.length, 1);
});

test("generated Windows installer parses in Windows PowerShell 5.1", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell 5.1 parser is available in Windows CI");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "prostar-windows-script-"));
  const scriptPath = join(directory, "install.ps1");
  try {
    writeFileSync(scriptPath, buildWindowsInstallScript(options), "ascii");
    const parser = [
      "$tokens = $null",
      "$errors = $null",
      "[void][System.Management.Automation.Language.Parser]::ParseFile($env:PROSTAR_PARSE_FILE, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
    ].join("; ");
    const parsed = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", parser],
      {
        encoding: "utf8",
        env: { ...process.env, PROSTAR_PARSE_FILE: scriptPath },
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
