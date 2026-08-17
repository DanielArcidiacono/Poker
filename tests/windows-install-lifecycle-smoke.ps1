[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:OS -ne "Windows_NT") {
  throw "The Windows install lifecycle smoke can run only on Windows."
}
if ($PSVersionTable.PSVersion.Major -ne 5) {
  throw "The Windows install lifecycle smoke requires Windows PowerShell 5.1."
}
if ($env:GITHUB_ACTIONS -ne "true" -or
    $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw "This destructive lifecycle smoke is restricted to an ephemeral GitHub Actions runner."
}

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$RuntimeSmokeRoot = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP "ProstarRuntimeSmoke"))
$RuntimeSource = Join-Path $RuntimeSmokeRoot "runtime"
$RuntimeRoot = Join-Path $AppRoot "runtime"
$ReleaseId = "ci-lifecycle"
$ReleaseRoot = Join-Path (Join-Path $AppRoot "releases") $ReleaseId
$LogsRoot = Join-Path $AppRoot "logs"
$ArtifactLogs = Join-Path $env:RUNNER_TEMP "prostar-lifecycle-logs"
$Bundle = Join-Path $RepositoryRoot "dashboard\public\prostar-agent.tgz"
$ViewerPassword = "prostar-ci-viewer-password"
$AgentSecret = "prostar_ci_agent_secret_0123456789abcdef"
$Utf8 = New-Object Text.UTF8Encoding($false)
$PrimaryError = $null
$CleanupError = $null

function Invoke-NativeStrict {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Description
  )
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Description failed with exit code $exitCode."
  }
}

function Invoke-PowerShellScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ScriptArguments = @(),
    [Parameter(Mandatory = $true)][string]$Description
  )
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $ScriptPath
  ) + $ScriptArguments
  Invoke-NativeStrict -FilePath $powerShell -Arguments $arguments -WorkingDirectory (Split-Path -Parent $ScriptPath) -Description $Description
}

function Get-ProstarTaskName {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid))
  } finally {
    $sha.Dispose()
  }
  $suffix = -join ($hash[0..5] | ForEach-Object { $_.ToString("x2") })
  return "Prostar Agent $suffix"
}

function Get-ProstarTask {
  $service = New-Object -ComObject "Schedule.Service"
  $service.Connect()
  try {
    return $service.GetFolder("\").GetTask("\$(Get-ProstarTaskName)")
  } catch {
    return $null
  }
}

function Wait-Health {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
    }
    Start-Sleep -Seconds 1
  }
  throw "The installed Windows agent did not become healthy."
}

function Assert-CapturePreflight {
  $response = Invoke-WebRequest -UseBasicParsing `
    -Uri "http://127.0.0.1:8787/api/capture/preflight" `
    -Method "POST" `
    -Headers @{ Authorization = "Bearer $AgentSecret" } `
    -TimeoutSec 20
  if ($response.StatusCode -ne 204) {
    throw "The installed Windows agent capture preflight returned HTTP $($response.StatusCode)."
  }
}

function Assert-LoggedNativeImplementation {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if ($parseErrors.Count -gt 0) {
    throw "$Label could not be parsed by Windows PowerShell 5.1."
  }
  $functionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq "Invoke-LoggedNative"
  }, $true)
  if ($null -eq $functionAst) {
    throw "$Label has no Invoke-LoggedNative function."
  }

  $definition = [ScriptBlock]::Create($functionAst.Extent.Text)
  . $definition
  $InstallLog = Join-Path $env:RUNNER_TEMP ("prostar-logged-native-" + [Guid]::NewGuid().ToString("N") + ".log")
  $utf8 = New-Object Text.UTF8Encoding($false)
  $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
  $cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
  try {
    [IO.File]::WriteAllText($InstallLog, "", $utf8)
    Invoke-LoggedNative -FilePath $cmd -Arguments @(
      "/d", "/s", "/c", "echo benign stdout & echo benign stderr 1>&2 & exit /b 0"
    ) -WorkingDirectory $RepositoryRoot -Description "$Label benign-stderr probe"

    $threw = $false
    try {
      Invoke-LoggedNative -FilePath $cmd -Arguments @(
        "/d", "/s", "/c", "echo fatal stderr 1>&2 & exit /b 23"
      ) -WorkingDirectory $RepositoryRoot -Description "$Label nonzero probe"
    } catch {
      $threw = $true
      if ($_.Exception.Message -notmatch "exit code 23") {
        throw
      }
    }
    if (-not $threw) {
      throw "$Label accepted a native process that exited with code 23."
    }

    $bytes = [IO.File]::ReadAllBytes($InstallLog)
    $text = $strictUtf8.GetString($bytes)
    if ($text -notmatch "benign stdout" -or
        $text -notmatch "benign stderr" -or
        $text -notmatch "fatal stderr") {
      throw "$Label did not append native stdout and stderr to the install log."
    }
    if ($bytes -contains [byte]0) {
      throw "$Label wrote mixed UTF-8 and UTF-16 data to the install log."
    }
    if (@(Get-ChildItem -LiteralPath $env:RUNNER_TEMP -Filter ".native-output-*.tmp").Count -gt 0) {
      throw "$Label retained a native-output staging file."
    }
  } finally {
    Remove-Item -LiteralPath $InstallLog -Force -ErrorAction SilentlyContinue
  }
}

function Remove-CiInstall {
  if (-not (Test-Path -LiteralPath $AppRoot)) {
    return
  }
  $uninstaller = Join-Path $RepositoryRoot "windows\uninstall-agent.ps1"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Invoke-PowerShellScript -ScriptPath $uninstaller -ScriptArguments @("-Purge") -Description "Windows task and data cleanup"
  }
  if (Test-Path -LiteralPath $AppRoot) {
    Remove-Item -LiteralPath $AppRoot -Recurse -Force
  }
}

$fixtureWorker = @'
Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$operationsLog = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Prostar\logs\fixture-operations.log"

$bitmap = New-Object Drawing.Bitmap -ArgumentList 8, 8
$jpegStream = New-Object IO.MemoryStream
try {
  for ($y = 0; $y -lt 8; $y++) {
    for ($x = 0; $x -lt 8; $x++) {
      $color = if ((($x + $y) % 2) -eq 0) {
        [Drawing.Color]::FromArgb(255, 25, 105, 220)
      } else {
        [Drawing.Color]::FromArgb(255, 245, 180, 30)
      }
      $bitmap.SetPixel($x, $y, $color)
    }
  }
  $bitmap.Save($jpegStream, [Drawing.Imaging.ImageFormat]::Jpeg)
  $jpeg = $jpegStream.ToArray()
} finally {
  $jpegStream.Dispose()
  $bitmap.Dispose()
}

function Read-Exact {
  param([Parameter(Mandatory = $true)][int]$Length)
  $buffer = New-Object byte[] $Length
  $offset = 0
  while ($offset -lt $Length) {
    $count = $inputStream.Read($buffer, $offset, $Length - $offset)
    if ($count -eq 0) {
      if ($offset -eq 0) {
        return $null
      }
      throw "Unexpected end of capture request."
    }
    $offset += $count
  }
  return ,$buffer
}

function Write-Response {
  param(
    [Parameter(Mandatory = $true)]$Response,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Payload
  )
  $header = $utf8.GetBytes(($Response | ConvertTo-Json -Compress))
  $prefix = [BitConverter]::GetBytes([uint32]$header.Length)
  $outputStream.Write($prefix, 0, $prefix.Length)
  $outputStream.Write($header, 0, $header.Length)
  if ($Payload.Length -gt 0) {
    $outputStream.Write($Payload, 0, $Payload.Length)
  }
  $outputStream.Flush()
}

while ($true) {
  $prefix = Read-Exact -Length 4
  if ($null -eq $prefix) {
    break
  }
  $headerLength = [BitConverter]::ToUInt32($prefix, 0)
  if ($headerLength -lt 1 -or $headerLength -gt 65536) {
    throw "Invalid capture request header."
  }
  $request = ConvertFrom-Json $utf8.GetString((Read-Exact -Length ([int]$headerLength)))
  $operation = [string]$request.op
  [IO.File]::AppendAllText($operationsLog, $operation + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))

  if ($operation -eq "probe") {
    $payload = New-Object byte[] 0
    Write-Response -Response ([ordered]@{
      v = 1; id = [int]$request.id; ok = $true; length = 0; mime = ""; width = 8; height = 8
    }) -Payload $payload
  } elseif ($operation -eq "capture") {
    Write-Response -Response ([ordered]@{
      v = 1; id = [int]$request.id; ok = $true; length = $jpeg.Length; mime = "image/jpeg"; width = 8; height = 8
    }) -Payload $jpeg
  } else {
    $payload = New-Object byte[] 0
    Write-Response -Response ([ordered]@{
      v = 1; id = [int]$request.id; ok = $false; length = 0; code = "invalid_request"; error = "Unsupported operation."
    }) -Payload $payload
  }
}
'@

$viewerSmoke = @'
import WebSocket from "ws";
import sharp from "sharp";

const password = process.argv[2];
const origin = "http://127.0.0.1:8787";
const login = await fetch(`${origin}/login`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
  redirect: "manual",
});
if (login.status !== 302) throw new Error(`Login returned HTTP ${login.status}`);
const setCookie = login.headers.get("set-cookie");
if (!setCookie) throw new Error("Login returned no session cookie");
const cookie = setCookie.split(";", 1)[0];

const jpeg = await new Promise((resolve, reject) => {
  const ws = new WebSocket("ws://127.0.0.1:8787/ws", {
    headers: { Origin: origin, Cookie: cookie },
  });
  const timeout = setTimeout(() => {
    ws.terminate();
    reject(new Error("Timed out waiting for an installed-agent frame"));
  }, 20_000);
  ws.once("message", (data, isBinary) => {
    clearTimeout(timeout);
    ws.close();
    if (!isBinary) {
      reject(new Error("Installed agent returned a text frame"));
      return;
    }
    resolve(Buffer.from(data));
  });
  ws.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

const metadata = await sharp(jpeg).metadata();
if (metadata.format !== "jpeg" || metadata.width !== 8 || metadata.height !== 8) {
  throw new Error(`Installed agent returned an unexpected frame: ${JSON.stringify(metadata)}`);
}
'@

try {
  if (Test-Path -LiteralPath $ArtifactLogs) {
    Remove-Item -LiteralPath $ArtifactLogs -Recurse -Force
  }
  Remove-CiInstall

  Assert-LoggedNativeImplementation `
    -ScriptPath (Join-Path $RepositoryRoot "windows\bootstrap.ps1") `
    -Label "Local bootstrap"
  Assert-LoggedNativeImplementation `
    -ScriptPath (Join-Path $RepositoryRoot "windows\production-install.ps1") `
    -Label "Production installer"

  if (-not (Test-Path -LiteralPath $RuntimeSource -PathType Container)) {
    throw "The private-runtime smoke did not create $RuntimeSource."
  }
  if (-not (Test-Path -LiteralPath $Bundle -PathType Leaf)) {
    throw "The dashboard build did not create the Windows distribution bundle."
  }

  [void](New-Item -ItemType Directory -Path $ReleaseRoot -Force)
  Copy-Item -LiteralPath $RuntimeSource -Destination $RuntimeRoot -Recurse -Force
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  Invoke-NativeStrict -FilePath $tar -Arguments @("-xzf", $Bundle, "-C", $ReleaseRoot) -WorkingDirectory $RepositoryRoot -Description "Agent bundle extraction"

  [IO.File]::WriteAllText((Join-Path $ReleaseRoot "windows\capture-worker.ps1"), $fixtureWorker, $Utf8)
  $environment = @(
    "PROSTAR_VIEWER_PASSWORD=$ViewerPassword",
    "PROSTAR_AGENT_SECRET=$AgentSecret",
    "PORT=8787",
    "FPS=8",
    "JPEG_QUALITY=60",
    "SCALE=0.5",
    "MAX_WIDTH=1920",
    "AUTO_TUNNEL=0",
    "CONTROL_PLANE_URL="
  ) -join [Environment]::NewLine
  [IO.File]::WriteAllText((Join-Path $ReleaseRoot ".env"), $environment + [Environment]::NewLine, $Utf8)

  $nodeId = ([IO.File]::ReadAllText((Join-Path $RuntimeRoot "node-current.txt"))).Trim()
  if ($nodeId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The private Node.js runtime pointer is invalid."
  }
  $npm = Join-Path (Join-Path $RuntimeRoot $nodeId) "npm.cmd"
  $node = Join-Path (Join-Path $RuntimeRoot $nodeId) "node.exe"
  $env:npm_config_cache = Join-Path $RuntimeRoot "npm-cache"
  $env:npm_config_update_notifier = "false"
  Invoke-NativeStrict -FilePath $npm -Arguments @("ci", "--foreground-scripts", "--no-audit", "--no-fund") -WorkingDirectory $ReleaseRoot -Description "Installed-release dependency installation"
  Invoke-NativeStrict -FilePath $npm -Arguments @("run", "build", "--silent") -WorkingDirectory $ReleaseRoot -Description "Installed-release build"

  $installer = Join-Path $ReleaseRoot "windows\install-agent.ps1"
  Invoke-PowerShellScript -ScriptPath $installer -Description "Windows scheduled-task installation"
  Wait-Health

  $task = Get-ProstarTask
  if ($null -eq $task -or -not [bool]$task.Enabled -or [int]$task.State -ne 4) {
    throw "The Prostar scheduled task is not enabled and running."
  }
  if ([int]$task.Definition.Principal.LogonType -ne 3) {
    throw "The Prostar scheduled task is not using the interactive user token."
  }
  $currentRelease = ([IO.File]::ReadAllText((Join-Path $AppRoot "current.txt"))).Trim()
  if ($currentRelease -ne $ReleaseId) {
    throw "The Prostar current-release pointer was not switched atomically."
  }

  Assert-CapturePreflight
  $viewerSmokePath = Join-Path $ReleaseRoot ".ci-viewer-smoke.mjs"
  [IO.File]::WriteAllText($viewerSmokePath, $viewerSmoke, $Utf8)
  Invoke-NativeStrict -FilePath $node -Arguments @($viewerSmokePath, $ViewerPassword) -WorkingDirectory $ReleaseRoot -Description "Installed-agent WebSocket capture"

  $operations = @(Get-Content -LiteralPath (Join-Path $LogsRoot "fixture-operations.log"))
  if ($operations -notcontains "probe" -or $operations -notcontains "capture") {
    throw "The lifecycle smoke did not exercise both probe and full-frame capture operations."
  }

  Invoke-PowerShellScript -ScriptPath $installer -ScriptArguments @("-FinalizeInstall") -Description "Windows scheduled-task finalization"
  if (Test-Path -LiteralPath (Join-Path $AppRoot ".install-pending.json")) {
    throw "The finalized Windows install retained its rollback marker."
  }

  $admin = Join-Path $AppRoot "prostar-admin.ps1"
  Invoke-PowerShellScript -ScriptPath $admin -ScriptArguments @("restart") -Description "Windows admin restart"
  Wait-Health
  Assert-CapturePreflight

  $uninstaller = Join-Path $ReleaseRoot "windows\uninstall-agent.ps1"
  Invoke-PowerShellScript -ScriptPath $uninstaller -ScriptArguments @("-Purge") -Description "Windows full uninstall"
  if ($null -ne (Get-ProstarTask)) {
    throw "The Windows uninstaller left the Prostar scheduled task registered."
  }
  if (Test-Path -LiteralPath $AppRoot) {
    throw "The Windows uninstaller left private application data behind."
  }
} catch {
  $PrimaryError = $_
} finally {
  try {
    if (Test-Path -LiteralPath $LogsRoot -PathType Container) {
      [void](New-Item -ItemType Directory -Path $ArtifactLogs -Force)
      Copy-Item -Path (Join-Path $LogsRoot "*") -Destination $ArtifactLogs -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
  try {
    Remove-CiInstall
  } catch {
    $CleanupError = $_
  }
}

if ($PrimaryError) {
  if ($CleanupError) {
    [Console]::Error.WriteLine("Lifecycle cleanup also failed: " + $CleanupError.Exception.Message)
  }
  throw $PrimaryError
}
if ($CleanupError) {
  throw $CleanupError
}

Write-Output "Windows install, capture, restart, and task-removal lifecycle passed."
