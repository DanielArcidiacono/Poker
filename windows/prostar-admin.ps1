[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$CommandArguments
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$CommandArguments = @($CommandArguments)

if ($env:OS -ne "Windows_NT") {
  throw "The Windows Prostar admin command can run only on Windows."
}

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$RuntimeRoot = Join-Path $AppRoot "runtime"
$LogsRoot = Join-Path $AppRoot "logs"
$CurrentPointer = Join-Path $AppRoot "current.txt"

function Get-TaskName {
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

$TaskName = Get-TaskName

function Show-Usage {
  @'
Prostar administration

Usage: prostar-admin <command>

Commands:
  status       Show service, health, pairing, and local URL
  start        Enable and start the background task
  stop         Stop and disable the background task
  restart      Restart the background task
  logs [-f]    Show recent logs; -f keeps following them
  preflight    Test Windows screen capture through the agent
  open         Open the local viewer in the default browser
  password     Print the local viewer password
  uninstall    Fully remove Prostar, its private runtime, data, and logs
  help         Show this help

The command is installed at:
  %LOCALAPPDATA%\Prostar\prostar-admin.cmd
'@
}

function Get-CurrentReleaseRoot {
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) {
    throw "Prostar is not installed for this Windows user."
  }
  $releaseId = ([IO.File]::ReadAllText($CurrentPointer)).Trim()
  if ($releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The Prostar current-release pointer is invalid."
  }
  $releasesRoot = [IO.Path]::GetFullPath((Join-Path $AppRoot "releases"))
  $releaseRoot = [IO.Path]::GetFullPath((Join-Path $releasesRoot $releaseId))
  $prefix = $releasesRoot.TrimEnd("\") + "\"
  if (-not $releaseRoot.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    throw "The Prostar current release is unavailable."
  }
  return $releaseRoot
}

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$ReleaseRoot = (Get-CurrentReleaseRoot)
  )
  $envPath = Join-Path $ReleaseRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    return ""
  }
  foreach ($line in [IO.File]::ReadAllLines($envPath)) {
    if ($line.StartsWith($Key + "=", [StringComparison]::Ordinal)) {
      return $line.Substring($Key.Length + 1).TrimEnd("`r")
    }
  }
  return ""
}

function Get-Port {
  $raw = Get-EnvValue -Key "PORT"
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return 8787
  }
  $port = 0
  if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "The configured Prostar port is invalid."
  }
  return $port
}

function Connect-TaskScheduler {
  $service = New-Object -ComObject "Schedule.Service"
  $service.Connect()
  return $service
}

function Get-ProstarTask {
  param($Service)
  try {
    return $Service.GetFolder("\").GetTask("\$TaskName")
  } catch {
    return $null
  }
}

function Resolve-TaskAccountSid {
  param([string]$Identity)
  if ([string]::IsNullOrWhiteSpace($Identity)) {
    return ""
  }
  try {
    $sid = New-Object Security.Principal.SecurityIdentifier($Identity)
    return $sid.Value
  } catch {
    try {
      $account = New-Object Security.Principal.NTAccount($Identity)
      $sid = $account.Translate([Security.Principal.SecurityIdentifier])
      return $sid.Value
    } catch {
      return ""
    }
  }
}

function Assert-OwnedTask {
  param($Task)
  if ($null -eq $Task) {
    return
  }
  $actions = $Task.Definition.Actions
  if ($actions.Count -ne 1) {
    throw "The existing $TaskName task is not owned by this Prostar installation."
  }
  $action = $actions.Item(1)
  $expectedCommand = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))
  $actualCommand = [IO.Path]::GetFullPath([string]$action.Path)
  $launcherPath = Join-Path $AppRoot "prostar-launcher.cmd"
  $expectedArguments = "/d /q /c call `"$launcherPath`""
  if (-not $actualCommand.Equals($expectedCommand, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([string]$action.Arguments).Trim().Equals(
        $expectedArguments,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw "The existing $TaskName task is not owned by this Prostar installation."
  }
}

function Test-LocalHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$(Get-Port)/api/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-LocalHealth {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-LocalHealth) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-ProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }
  $creation = if ($process.CreationDate -is [DateTime]) {
    $process.CreationDate.ToUniversalTime().ToString("o")
  } else {
    [string]$process.CreationDate
  }
  return [PSCustomObject]@{
    ProcessId = [int]$process.ProcessId
    CreationDate = $creation
    ExecutablePath = [string]$process.ExecutablePath
    CommandLine = [string]$process.CommandLine
  }
}

function Test-SameProcess {
  param([Parameter(Mandatory = $true)]$Identity)
  $current = Get-ProcessIdentity -ProcessId ([int]$Identity.ProcessId)
  return $null -ne $current -and
    $current.CreationDate -eq $Identity.CreationDate -and
    $current.ExecutablePath -eq $Identity.ExecutablePath -and
    $current.CommandLine -eq $Identity.CommandLine
}

function Get-OwnedProstarProcesses {
  $result = New-Object System.Collections.ArrayList
  $prefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
  $releasePrefix = [IO.Path]::GetFullPath((Join-Path $AppRoot "releases")).TrimEnd("\") + "\"
  $captureSuffix = "\windows\capture-worker.ps1"
  $powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"))
  $launcherPath = Join-Path $AppRoot "prostar-launcher.cmd"
  $cmdPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
    $path = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }
    try {
      $full = [IO.Path]::GetFullPath($path)
    } catch {
      continue
    }
    $commandLine = [string]$process.CommandLine
    $isRuntimeProcess = $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    $isCaptureWorker = $full.Equals($powerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf($captureSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isLauncher = $full.Equals($cmdPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isRuntimeProcess -or $isCaptureWorker -or $isLauncher) {
      $identity = Get-ProcessIdentity -ProcessId ([int]$process.ProcessId)
      if ($identity) {
        [void]$result.Add($identity)
      }
    }
  }
  return $result
}

function Stop-ProstarTask {
  param([switch]$Disable)
  $service = Connect-TaskScheduler
  $task = Get-ProstarTask -Service $service
  if ($null -eq $task) {
    throw "Prostar is not installed for this Windows user."
  }
  Assert-OwnedTask -Task $task
  $wasEnabled = [bool]$task.Enabled
  $task.Enabled = $false
  $identities = @(Get-OwnedProstarProcesses)
  if ([int]$task.State -eq 4) {
    $task.Stop(0)
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (@($identities | Where-Object { Test-SameProcess -Identity $_ }).Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  foreach ($identity in $identities) {
    if (Test-SameProcess -Identity $identity) {
      Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 500
  if (@($identities | Where-Object { Test-SameProcess -Identity $_ }).Count -gt 0) {
    throw "Prostar could not stop all of its processes."
  }
  $lateProcesses = @(Get-OwnedProstarProcesses)
  foreach ($identity in $lateProcesses) {
    if (Test-SameProcess -Identity $identity) {
      Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  if ($lateProcesses.Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
  if (@(Get-OwnedProstarProcesses).Count -gt 0) {
    throw "A Prostar process reappeared after the background task stopped."
  }
  if (-not $Disable -and $wasEnabled) {
    $task.Enabled = $true
  }
}

function Start-ProstarTask {
  $service = Connect-TaskScheduler
  $task = Get-ProstarTask -Service $service
  if ($null -eq $task) {
    throw "Prostar is not installed for this Windows user."
  }
  Assert-OwnedTask -Task $task
  $task.Enabled = $true
  if ([int]$task.State -ne 4) {
    [void]$task.Run($null)
  }
  if (-not (Wait-LocalHealth)) {
    throw "Prostar did not become healthy. Check the error log."
  }
}

function Test-DashboardConnection {
  try {
    $response = Invoke-AgentRequest `
      -Path "/api/control-plane/health" `
      -Method "GET" `
      -TimeoutSec 2
    return $response.StatusCode -eq 204
  } catch {
    return $false
  }
}

function Show-Status {
  $releaseRoot = Get-CurrentReleaseRoot
  $service = Connect-TaskScheduler
  $task = Get-ProstarTask -Service $service
  Write-Output "Release: $releaseRoot"
  if ($null -eq $task) {
    Write-Output "Service: not installed"
  } else {
    Assert-OwnedTask -Task $task
    $stateNames = @("unknown", "disabled", "queued", "ready", "running")
    $state = [int]$task.State
    $stateName = if ($state -ge 0 -and $state -lt $stateNames.Count) { $stateNames[$state] } else { "unknown" }
    Write-Output "Service: $stateName"
    Write-Output "Task enabled: $([bool]$task.Enabled)"

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $principalSid = Resolve-TaskAccountSid -Identity ([string]$task.Definition.Principal.UserId)
    $logonType = [int]$task.Definition.Principal.LogonType
    $principalMatches = $principalSid.Equals(
      $currentSid,
      [StringComparison]::OrdinalIgnoreCase
    )
    $principalStatus = if ($principalMatches -and $logonType -eq 3) {
      "current interactive user"
    } elseif ($principalMatches) {
      "current user (logon type $logonType)"
    } else {
      "different user (logon type $logonType)"
    }
    Write-Output "Task principal: $principalStatus"

    $hasLogonTrigger = $false
    $hasMatchingLogonTrigger = $false
    $hasEnabledMatchingLogonTrigger = $false
    $triggers = $task.Definition.Triggers
    for ($index = 1; $index -le $triggers.Count; $index++) {
      $trigger = $triggers.Item($index)
      if ([int]$trigger.Type -ne 9) {
        continue
      }
      $hasLogonTrigger = $true
      $triggerSid = Resolve-TaskAccountSid -Identity ([string]$trigger.UserId)
      if ($triggerSid.Equals($currentSid, [StringComparison]::OrdinalIgnoreCase)) {
        $hasMatchingLogonTrigger = $true
        if ([bool]$trigger.Enabled) {
          $hasEnabledMatchingLogonTrigger = $true
        }
      }
    }
    $triggerStatus = if ($hasEnabledMatchingLogonTrigger) {
      "current user (enabled)"
    } elseif ($hasMatchingLogonTrigger) {
      "current user (disabled)"
    } elseif ($hasLogonTrigger) {
      "different user"
    } else {
      "missing"
    }
    Write-Output "Sign-in trigger: $triggerStatus"

    $lastRun = [DateTime]$task.LastRunTime
    $lastRunText = if ($lastRun.Year -gt 1900) {
      $lastRun.ToUniversalTime().ToString("o")
    } else {
      "never"
    }
    $lastResult = [int64]$task.LastTaskResult
    $unsignedResult = if ($lastResult -lt 0) {
      $lastResult + 4294967296
    } else {
      $lastResult
    }
    $lastResultHex = $unsignedResult.ToString("X8")
    Write-Output "Task last run: $lastRunText"
    Write-Output "Task last result: $lastResult (0x$lastResultHex)"
    Write-Output "Task missed runs: $([int]$task.NumberOfMissedRuns)"
  }
  $healthy = Test-LocalHealth
  Write-Output "Health: $(if ($healthy) { 'healthy' } else { 'unavailable' })"
  Write-Output "Local URL: http://127.0.0.1:$(Get-Port)"
  $controlPlane = Get-EnvValue -Key "CONTROL_PLANE_URL" -ReleaseRoot $releaseRoot
  $clientId = Get-EnvValue -Key "PROSTAR_CLIENT_ID" -ReleaseRoot $releaseRoot
  $agentSecret = Get-EnvValue -Key "PROSTAR_AGENT_SECRET" -ReleaseRoot $releaseRoot
  if ([string]::IsNullOrWhiteSpace($agentSecret)) {
    $agentSecret = Get-EnvValue -Key "AGENT_TOKEN" -ReleaseRoot $releaseRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($controlPlane) -and
      -not [string]::IsNullOrWhiteSpace($clientId) -and
      -not [string]::IsNullOrWhiteSpace($agentSecret)) {
    Write-Output "Dashboard configuration: configured ($controlPlane)"
    $dashboardConnected = $healthy -and (Test-DashboardConnection)
    Write-Output "Dashboard connection: $(if ($dashboardConnected) { 'connected' } else { 'unavailable' })"
    Write-Output "Session: $clientId"
    Write-Output "Cloudflare: dashboard-controlled"
  } else {
    $hasPartialDashboardConfiguration =
      -not [string]::IsNullOrWhiteSpace($controlPlane) -or
      -not [string]::IsNullOrWhiteSpace($clientId)
    Write-Output "Dashboard configuration: $(if ($hasPartialDashboardConfiguration) { 'incomplete' } else { 'not configured' })"
    Write-Output "Dashboard connection: unavailable"
    Write-Output "Cloudflare: disabled"
  }
  Write-Output "Logs: $LogsRoot"
}

function Show-Logs {
  param([string]$Option)
  [string[]]$paths = @(
    foreach ($candidate in @(
        (Join-Path $LogsRoot "prostar.out.log"),
        (Join-Path $LogsRoot "prostar.err.log")
      )) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $candidate
      }
    }
  )
  if ($paths.Count -eq 0) {
    Write-Output "No Prostar logs exist yet in $LogsRoot."
    return
  }
  if ([string]::IsNullOrWhiteSpace($Option)) {
    Get-Content -LiteralPath $paths -Tail 80
  } elseif ($Option -eq "-f" -or $Option -eq "--follow") {
    Get-Content -LiteralPath $paths -Tail 80 -Wait
  } else {
    throw "Unknown logs option: $Option"
  }
}

function Invoke-AgentRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Method,
    [int]$TimeoutSec = 20
  )
  $secret = Get-EnvValue -Key "PROSTAR_AGENT_SECRET"
  if ([string]::IsNullOrWhiteSpace($secret)) {
    $secret = Get-EnvValue -Key "AGENT_TOKEN"
  }
  if ([string]::IsNullOrWhiteSpace($secret)) {
    throw "This release has no local agent credential."
  }
  $headers = @{ Authorization = "Bearer $secret" }
  $uri = "http://127.0.0.1:$(Get-Port)$Path"
  return Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method -Headers $headers -TimeoutSec $TimeoutSec
}

try {
  switch ($Command.ToLowerInvariant()) {
    "help" { Show-Usage }
    "-h" { Show-Usage }
    "--help" { Show-Usage }
    "status" { Show-Status }
    "start" {
      Start-ProstarTask
      Write-Output "Prostar is running at http://127.0.0.1:$(Get-Port)."
    }
    "stop" {
      Stop-ProstarTask -Disable
      Write-Output "Prostar is stopped and disabled."
    }
    "restart" {
      Stop-ProstarTask
      Start-ProstarTask
      Write-Output "Prostar restarted successfully."
    }
    "logs" {
      $option = if ($CommandArguments.Count -gt 0) { $CommandArguments[0] } else { "" }
      Show-Logs -Option $option
    }
    "preflight" {
      if (-not (Test-LocalHealth)) {
        throw "Prostar is not running. Run 'prostar-admin start' first."
      }
      $response = Invoke-AgentRequest -Path "/api/capture/preflight" -Method "POST"
      if ($response.StatusCode -ne 204) {
        throw "Windows screen capture preflight failed."
      }
      Write-Output "Windows screen capture is ready."
    }
    "open" {
      if (-not (Test-LocalHealth)) {
        throw "Prostar is not running. Run 'prostar-admin start' first."
      }
      Start-Process "http://127.0.0.1:$(Get-Port)/"
      Write-Output "Opened the local Prostar viewer."
    }
    "password" {
      $password = Get-EnvValue -Key "PROSTAR_VIEWER_PASSWORD"
      if ([string]::IsNullOrWhiteSpace($password)) {
        $password = Get-EnvValue -Key "VIEWER_PASSWORD"
      }
      if ([string]::IsNullOrWhiteSpace($password)) {
        throw "No local viewer password is configured."
      }
      Write-Output $password
    }
    "uninstall" {
      $releaseRoot = Get-CurrentReleaseRoot
      $uninstaller = Join-Path $releaseRoot "windows\uninstall-agent.ps1"
      if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "The Prostar uninstaller is unavailable."
      }
      & $uninstaller -Purge
      exit $LASTEXITCODE
    }
    default {
      [Console]::Error.WriteLine((Show-Usage | Out-String).TrimEnd())
      exit 2
    }
  }
} catch {
  [Console]::Error.WriteLine("Error: " + $_.Exception.Message)
  exit 1
}
exit 0
