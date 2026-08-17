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

const windowsScripts = [
  "windows/bootstrap.ps1",
  "windows/cleanup-orphans.ps1",
  "windows/capture-worker.ps1",
  "windows/ensure-runtime.ps1",
  "windows/install-agent.ps1",
  "windows/production-install.ps1",
  "windows/prostar-admin.ps1",
  "windows/uninstall-agent.ps1",
];

test("distribution and admin scripts are valid Bash", () => {
  const parsed = spawnSync("bash", ["-n", ...scripts], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("the production agent archive bundles both platform integrations", () => {
  const builder = readFileSync(
    "dashboard/scripts/build-agent-bundle.mjs",
    "utf8",
  );
  assert.match(builder, /"scripts"/);
  assert.match(builder, /"launchd"/);
  assert.match(builder, /"windows"/);

  for (const scriptPath of windowsScripts) {
    const script = readFileSync(scriptPath, "utf8");
    assert.ok(script.length > 0, `${scriptPath} must not be empty`);
    assert.match(script, /Set-StrictMode/);
  }

  const built = spawnSync(
    process.execPath,
    ["dashboard/scripts/build-agent-bundle.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  const listed = spawnSync(
    "tar",
    ["-tf", "dashboard/public/prostar-agent.tgz"],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const archivePaths = new Set(
    listed.stdout.split(/\r?\n/).filter((path) => path.length > 0),
  );
  for (const path of [...scripts, ...windowsScripts]) {
    assert.ok(archivePaths.has(path), `${path} is missing from the agent archive`);
  }
});

test("public bootstrap is pinned, local-only, and quiet", () => {
  const script = readFileSync("scripts/bootstrap.sh", "utf8");
  assert.match(script, /PROSTAR_REF:-v1\.2\.1/);
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

test("Windows distribution is pinned, persistent, transactional, and quiet", () => {
  const runtime = readFileSync("windows/ensure-runtime.ps1", "utf8");
  assert.match(runtime, /\$NodeVersion = "24\.19\.0"/);
  assert.match(runtime, /\$CloudflaredVersion = "2026\.8\.2"/);
  assert.match(runtime, /Assert-Sha256/);
  assert.match(
    runtime,
    /Assert-Sha256 -LiteralPath \$downloaded[\s\S]*\[IO\.Directory\]::Move\(\$completePath, \$installPath\)/,
  );
  assert.doesNotMatch(runtime, /New-Item -ItemType Directory -Path \$installPath/);
  assert.doesNotMatch(runtime, /\bwinget\b|\bchoco\b|\bscoop\b/i);

  const installer = readFileSync("windows/install-agent.ps1", "utf8");
  assert.match(installer, /Schedule\.Service/);
  assert.match(installer, /LogonType = 3/);
  assert.match(installer, /RunLevel = 0/);
  assert.match(installer, /ExecutionTimeLimit = "PT0S"/);
  assert.match(installer, /RestartInterval = "PT1M"/);
  assert.match(installer, /\.install-pending\.json/);
  assert.match(installer, /RollbackInstall/);
  assert.match(installer, /FinalizeInstall/);
  assert.match(
    installer,
    /Write-AtomicText -LiteralPath \$PendingMarker -Value \(\$marker \| ConvertTo-Json -Compress\)/,
  );
  assert.doesNotMatch(
    installer,
    /\[IO\.File\]::WriteAllText\(\s*\$PendingMarker/,
  );
  const finalizeStart = installer.indexOf("if ($FinalizeInstall)");
  const finalizeBlock = installer.slice(
    finalizeStart,
    installer.indexOf("Assert-InstallPaths", finalizeStart),
  );
  assert.ok(
    finalizeBlock.indexOf("Write-LauncherFiles") <
      finalizeBlock.indexOf("Remove-Item -LiteralPath $PendingMarker"),
    "finalization must retain the rollback marker until launcher writes succeed",
  );

  const production = readFileSync("windows/production-install.ps1", "utf8");
  for (const endpoint of ["verify", "enroll", "activate", "deenroll"]) {
    assert.match(production, new RegExp(`/api/agent/${endpoint}`));
  }
  assert.match(production, /-WithCloudflared/);
  assert.match(production, /npm_config_cache/);
  assert.match(production, /Invoke-FailureCleanup/);
  assert.match(production, /\$ErrorActionPreference = "Continue"/);
  assert.match(production, /\[IO\.File\]::AppendAllText/);
  assert.match(production, /\*> \$nativeOutputPath/);
  assert.match(production, /\$global:LASTEXITCODE = 1/);
  assert.match(production, /\$exitCode = \$global:LASTEXITCODE/);
  assert.doesNotMatch(production, /\*>> \$InstallLog/);
  assert.doesNotMatch(production, /2>&1\s*\|/);
  assert.match(production, /\$env:PROSTAR_APP_ROOT = \$AppRoot/);
  assert.match(production, /Phase: verifying Windows screen capture/);
  assert.match(
    production,
    /Write-AtomicText -LiteralPath \$PendingIdentity -Value \$contents/,
  );
  assert.doesNotMatch(
    production,
    /\[IO\.File\]::WriteAllText\(\$PendingIdentity/,
  );
  const enrollmentAccepted = production.indexOf(
    'if ($enrollStatus -ne 204)',
  );
  const cleanupOwnership = production.indexOf(
    "$EnrolledNewIdentity = $true",
    enrollmentAccepted,
  );
  const pendingIdentityWrite = production.indexOf(
    "Write-PendingIdentity",
    cleanupOwnership,
  );
  assert.ok(
    enrollmentAccepted >= 0 &&
      cleanupOwnership > enrollmentAccepted &&
      pendingIdentityWrite > cleanupOwnership,
    "successful enrollment must acquire cleanup ownership before writing recovery state",
  );
  assert.match(
    production,
    /Join-Path \$SourceRoot "windows\\install-agent\.ps1"[\s\S]*\$ReleasePath = \$recoveryRelease[\s\S]*-RollbackInstall/,
  );

  for (const scriptPath of windowsScripts) {
    const script = readFileSync(scriptPath, "utf8");
    assert.equal(
      /[^\x00-\x7f]/.test(script),
      false,
      `${scriptPath} must remain ASCII for Windows PowerShell 5.1`,
    );
    assert.doesNotMatch(script, /\\\s*$/m);
  }
});

test("Windows full uninstall fails closed and stops every owned process class", () => {
  const script = readFileSync("windows/uninstall-agent.ps1", "utf8");
  assert.match(script, /EnumerateFileSystemInfos/);
  assert.match(script, /FileAttributes\]::ReparsePoint/);
  assert.match(script, /capture-worker\.ps1/);
  assert.match(script, /cloudflared\.exe|RuntimeRoot/);
  assert.match(script, /prostar-launcher\.cmd/);
  assert.match(script, /@\(Get-OwnedProstarProcesses\)\.Count -gt 0/);
  assert.match(script, /api\/agent\/deenroll/);
  assert.match(script, /status -ne 204/);
  assert.match(script, /LocalOnly/);
  assert.match(script, /AUTO_TUNNEL/);
  assert.match(
    script,
    /Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/,
  );
  assert.doesNotMatch(script, /\btaskkill\b|Stop-Process\s+-Name/i);
});

test("public Windows bootstrap is pinned, local-only, transactional, and quiet", () => {
  const script = readFileSync("windows/bootstrap.ps1", "utf8");
  assert.match(script, /\[string\]\$Ref = "v1\.2\.1"/);
  assert.match(script, /"AUTO_TUNNEL=0"/);
  assert.match(script, /"CONTROL_PLANE_URL="/);
  assert.match(script, /-NodeOnly/);
  assert.doesNotMatch(script, /-WithCloudflared/);
  assert.match(script, /-RollbackInstall/);
  assert.match(script, /-FinalizeInstall/);
  assert.match(script, /\.setup\.lock/);
  assert.ok(
    script.indexOf("$sourceRoot = Expand-SafeSourceArchive") <
      script.indexOf("if (Test-Path -LiteralPath $PendingMarker"),
    "the verified staged helper must exist before interrupted-install recovery",
  );
  assert.match(
    script,
    /Join-Path \$sourceRoot "windows\\install-agent\.ps1"[\s\S]*-RollbackInstall/,
  );
  assert.equal(script.match(/Prostar installed successfully\./g)?.length, 1);
  assert.equal(script.match(/Write-Output/g)?.length, 1);
  assert.match(script, /\$FailureMessage/);
  assert.match(script, /Details: /);
});

test("Windows launcher cleans exact child processes across hard Node crashes", () => {
  const installer = readFileSync("windows/install-agent.ps1", "utf8");
  const cleanup = readFileSync("windows/cleanup-orphans.ps1", "utf8");
  assert.ok(
    installer.match(/cleanup-orphans\.ps1/g)?.length === 3,
    "the release check plus pre-start and post-exit cleanup must remain",
  );
  assert.match(cleanup, /cloudflared\.exe/);
  assert.match(cleanup, /capture-worker\.ps1/);
  assert.match(cleanup, /CreationDate/);
  assert.match(cleanup, /Test-SameProcess/);
  assert.match(
    cleanup,
    /Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/,
  );
  assert.doesNotMatch(cleanup, /Stop-Process\s+-Name|\btaskkill\b/i);
});
