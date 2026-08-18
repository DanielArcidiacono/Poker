[CmdletBinding()]
param(
  [switch]$FinalizeInstall,
  [switch]$RollbackInstall
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($FinalizeInstall -and $RollbackInstall) {
  throw "Choose only one install-agent mode."
}
if ($env:OS -ne "Windows_NT") {
  throw "The Windows agent installer can run only on Windows."
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Prostar requires Windows PowerShell 5.1 or later."
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReleaseRoot = [IO.Path]::GetFullPath((Split-Path -Parent $ScriptDirectory))
$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$ReleasesRoot = Join-Path $AppRoot "releases"
$RuntimeRoot = Join-Path $AppRoot "runtime"
$LogsRoot = Join-Path $AppRoot "logs"
$CurrentPointer = Join-Path $AppRoot "current.txt"
$PendingMarker = Join-Path $AppRoot ".install-pending.json"
$LauncherPath = Join-Path $AppRoot "prostar-launcher.cmd"
$TaskHostPath = Join-Path $AppRoot "prostar-task-host-v2.exe"
$TaskHostSourcePath = Join-Path $ReleaseRoot "windows\task-host.cs"
$AdminWrapperPath = Join-Path $AppRoot "prostar-admin.ps1"
$AdminCommandPath = Join-Path $AppRoot "prostar-admin.cmd"
$EnvPath = Join-Path $ReleaseRoot ".env"
$VerboseOutput = $env:PROSTAR_ADMIN_VERBOSE -eq "1"
$HandoffActive = $false

function Write-Detail {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ($VerboseOutput) {
    Write-Output $Message
  }
}

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return $false
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-InstallPaths {
  $expectedRoot = [IO.Path]::GetFullPath($ReleasesRoot).TrimEnd("\") + "\"
  if (-not $ReleaseRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Windows agent must be installed from Prostar's releases directory."
  }
  $releaseId = [IO.Path]::GetFileName($ReleaseRoot)
  if ($releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The Prostar release directory name is invalid."
  }
  foreach ($path in @($AppRoot, $ReleasesRoot, $RuntimeRoot, $ReleaseRoot)) {
    if (Test-ReparsePoint -LiteralPath $path) {
      throw "$path must not be a reparse point."
    }
  }
  if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
    throw "The Prostar release has no .env configuration."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ReleaseRoot "dist\server.js") -PathType Leaf)) {
    throw "The Prostar release has not been built."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ReleaseRoot "windows\cleanup-orphans.ps1") -PathType Leaf)) {
    throw "The Prostar release has no Windows child-process cleanup helper."
  }
  if (-not (Test-Path -LiteralPath $TaskHostSourcePath -PathType Leaf)) {
    throw "The Prostar release has no Windows background task-host source."
  }
}

function Get-TaskName {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($sid)
    $hash = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }
  $suffix = -join ($hash[0..5] | ForEach-Object { $_.ToString("x2") })
  return "Prostar Agent $suffix"
}

$TaskName = Get-TaskName

function Connect-TaskScheduler {
  $service = New-Object -ComObject "Schedule.Service"
  $service.Connect()
  return $service
}

function Get-ProstarTask {
  param($Service)
  $folder = $Service.GetFolder("\")
  try {
    return $folder.GetTask("\$TaskName")
  } catch {
    return $null
  }
}

function Get-TaskActionVariant {
  param($Task)
  if ($null -eq $Task) {
    return
  }
  $actions = $Task.Definition.Actions
  if ($actions.Count -ne 1) {
    throw "The existing $TaskName task is not owned by this Prostar installation."
  }
  $action = $actions.Item(1)
  $actualCommand = [IO.Path]::GetFullPath([string]$action.Path)
  $actualArguments = ([string]$action.Arguments).Trim()
  $expectedTaskHost = [IO.Path]::GetFullPath($TaskHostPath)
  $expectedLegacyCommand = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))
  $expectedLegacyArguments = "/d /q /c call `"$LauncherPath`""
  $isCurrent = $actualCommand.Equals($expectedTaskHost, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::IsNullOrWhiteSpace($actualArguments)
  $isLegacy = $actualCommand.Equals($expectedLegacyCommand, [StringComparison]::OrdinalIgnoreCase) -and
    $actualArguments.Equals($expectedLegacyArguments, [StringComparison]::OrdinalIgnoreCase)
  if ($isCurrent) { return "gui-v2" }
  if ($isLegacy) { return "legacy-cmd" }
  throw "The existing $TaskName task is not owned by this Prostar installation."
}

function Assert-OwnedTask {
  param($Task)
  if ($null -ne $Task) {
    [void](Get-TaskActionVariant -Task $Task)
  }
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
    ParentProcessId = [int]$process.ParentProcessId
    CreationDate = $creation
    ExecutablePath = [string]$process.ExecutablePath
    CommandLine = [string]$process.CommandLine
  }
}

function Add-ProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][System.Collections.ArrayList]$Identities,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$Seen
  )
  if ($ProcessId -le 4 -or -not $Seen.Add($ProcessId)) {
    return
  }
  $identity = Get-ProcessIdentity -ProcessId $ProcessId
  if ($null -eq $identity) {
    return
  }
  [void]$Identities.Add($identity)
  $children = Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in @($children)) {
    Add-ProcessTree -ProcessId ([int]$child.ProcessId) -Identities $Identities -Seen $Seen
  }
}

function Get-OwnedProstarProcesses {
  $result = New-Object System.Collections.ArrayList
  $runtimePrefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
  $releasePrefix = [IO.Path]::GetFullPath($ReleasesRoot).TrimEnd("\") + "\"
  $captureSuffix = "\windows\capture-worker.ps1"
  $powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"))
  $cmdPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))
  $all = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
  foreach ($process in @($all)) {
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
    $isRuntimeProcess = $full.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
    $isCaptureWorker = $full.Equals($powerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf($captureSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isTaskHost = $full.Equals([IO.Path]::GetFullPath($TaskHostPath), [StringComparison]::OrdinalIgnoreCase)
    $isLauncher = $full.Equals($cmdPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($LauncherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isRuntimeProcess -or $isCaptureWorker -or $isTaskHost -or $isLauncher) {
      $identity = Get-ProcessIdentity -ProcessId ([int]$process.ProcessId)
      if ($identity) {
        [void]$result.Add($identity)
      }
    }
  }
  return $result
}

function Test-SameProcess {
  param([Parameter(Mandatory = $true)]$Identity)
  $current = Get-ProcessIdentity -ProcessId ([int]$Identity.ProcessId)
  if ($null -eq $current) {
    return $false
  }
  return $current.CreationDate -eq $Identity.CreationDate -and
    $current.ExecutablePath -eq $Identity.ExecutablePath -and
    $current.CommandLine -eq $Identity.CommandLine
}

function Stop-ProstarTaskStrictly {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [switch]$Disable
  )

  $task = Get-ProstarTask -Service $Service
  if ($task) {
    Assert-OwnedTask -Task $task
  }
  $identities = New-Object System.Collections.ArrayList
  $seen = New-Object "System.Collections.Generic.HashSet[int]"
  if ($task) {
    $instances = $task.GetInstances(0)
    for ($index = 1; $index -le $instances.Count; $index++) {
      $instance = $instances.Item($index)
      Add-ProcessTree -ProcessId ([int]$instance.EnginePID) -Identities $identities -Seen $seen
    }
  }
  foreach ($identity in @(Get-OwnedProstarProcesses)) {
    if ($seen.Add([int]$identity.ProcessId)) {
      [void]$identities.Add($identity)
    }
  }

  if ($task) {
    if ($Disable) {
      $task.Enabled = $false
    }
    $task.Stop(0)
  }

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $alive = @($identities | Where-Object { Test-SameProcess -Identity $_ })
    if ($alive.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  $reverse = @($identities)
  [Array]::Reverse($reverse)
  foreach ($identity in $reverse) {
    if (Test-SameProcess -Identity $identity) {
      Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 500
  $remaining = @($identities | Where-Object { Test-SameProcess -Identity $_ })
  if ($remaining.Count -gt 0) {
    throw "Prostar could not stop all of its existing processes."
  }

  # A capture request can create its PowerShell worker between the first
  # process snapshot and Task Scheduler stopping the launcher. Sweep once more
  # only after the task is stopped, then fail closed if anything reappears.
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
}

function Write-AtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $contents = $Value + [Environment]::NewLine
  if ((Test-Path -LiteralPath $LiteralPath -PathType Leaf) -and
      [IO.File]::ReadAllText($LiteralPath).Equals($contents, [StringComparison]::Ordinal)) {
    return
  }
  $parent = Split-Path -Parent $LiteralPath
  $temporary = Join-Path $parent (".write-" + [Guid]::NewGuid().ToString("N"))
  try {
    [IO.File]::WriteAllText($temporary, $contents, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $LiteralPath) {
      $backup = Join-Path $parent (".backup-" + [Guid]::NewGuid().ToString("N"))
      try {
        [IO.File]::Replace($temporary, $LiteralPath, $backup, $true)
      } finally {
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
      }
    } else {
      [IO.File]::Move($temporary, $LiteralPath)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Get-CurrentReleaseId {
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) {
    return $null
  }
  if (Test-ReparsePoint -LiteralPath $CurrentPointer) {
    throw "The Prostar current-release pointer must not be a reparse point."
  }
  $releaseId = ([IO.File]::ReadAllText($CurrentPointer)).Trim()
  if ($releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The Prostar current-release pointer is invalid."
  }
  $releasePath = [IO.Path]::GetFullPath((Join-Path $ReleasesRoot $releaseId))
  $prefix = [IO.Path]::GetFullPath($ReleasesRoot).TrimEnd("\") + "\"
  if (-not $releasePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Prostar current-release pointer is unsafe."
  }
  return $releaseId
}

function Test-WindowsGuiExecutable {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  try {
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf) -or
        (Test-ReparsePoint -LiteralPath $LiteralPath)) {
      return $false
    }
    [byte[]]$bytes = [IO.File]::ReadAllBytes($LiteralPath)
    if ($bytes.Length -lt 1024 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
      return $false
    }
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($peOffset -lt 0x40 -or $peOffset + 94 -gt $bytes.Length -or
        $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
      return $false
    }
    return [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68) -eq 2
  } catch {
    return $false
  }
}

function Write-LauncherFiles {
  $launcher = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PROSTAR_ROOT=%LOCALAPPDATA%\Prostar"
if not exist "%PROSTAR_ROOT%\current.txt" exit /b 2
set "PROSTAR_RELEASE="
set /p "PROSTAR_RELEASE="<"%PROSTAR_ROOT%\current.txt"
if not defined PROSTAR_RELEASE exit /b 3
if not exist "%PROSTAR_ROOT%\runtime\node-current.txt" exit /b 4
set "PROSTAR_NODE_RELEASE="
set /p "PROSTAR_NODE_RELEASE="<"%PROSTAR_ROOT%\runtime\node-current.txt"
if not defined PROSTAR_NODE_RELEASE exit /b 5
set "PROSTAR_RELEASE_ROOT=%PROSTAR_ROOT%\releases\%PROSTAR_RELEASE%"
set "PROSTAR_NODE=%PROSTAR_ROOT%\runtime\%PROSTAR_NODE_RELEASE%\node.exe"
if not exist "%PROSTAR_RELEASE_ROOT%\dist\server.js" exit /b 6
if not exist "%PROSTAR_NODE%" exit /b 7
if not exist "%PROSTAR_ROOT%\logs" mkdir "%PROSTAR_ROOT%\logs"
:prostar_restart
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PROSTAR_RELEASE_ROOT%\windows\cleanup-orphans.ps1" >>"%PROSTAR_ROOT%\logs\prostar.out.log" 2>>"%PROSTAR_ROOT%\logs\prostar.err.log"
if errorlevel 1 exit /b 9
cd /d "%PROSTAR_RELEASE_ROOT%" || exit /b 8
"%PROSTAR_NODE%" "dist\server.js" >>"%PROSTAR_ROOT%\logs\prostar.out.log" 2>>"%PROSTAR_ROOT%\logs\prostar.err.log"
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PROSTAR_RELEASE_ROOT%\windows\cleanup-orphans.ps1" >>"%PROSTAR_ROOT%\logs\prostar.out.log" 2>>"%PROSTAR_ROOT%\logs\prostar.err.log"
if errorlevel 1 exit /b 9
%SystemRoot%\System32\ping.exe -n 11 127.0.0.1 >nul 2>nul
goto prostar_restart
'@
  Write-AtomicText -LiteralPath $LauncherPath -Value ($launcher.Replace("`n", "`r`n").TrimEnd([char[]]"`r`n"))

  if (Test-Path -LiteralPath $TaskHostPath) {
    if (-not (Test-WindowsGuiExecutable -LiteralPath $TaskHostPath)) {
      throw "The existing Prostar background task host is unsafe."
    }
  } else {
    if (-not (Test-Path -LiteralPath $TaskHostSourcePath -PathType Leaf)) {
      throw "The Prostar background task-host source is unavailable."
    }
    $temporaryTaskHost = Join-Path $AppRoot (".prostar-task-host." + [Guid]::NewGuid().ToString("N") + ".exe")
    try {
      Add-Type `
        -LiteralPath $TaskHostSourcePath `
        -OutputAssembly $temporaryTaskHost `
        -OutputType WindowsApplication
      if (-not (Test-WindowsGuiExecutable -LiteralPath $temporaryTaskHost)) {
        throw "The Prostar background task host could not be built."
      }
      [IO.File]::Move($temporaryTaskHost, $TaskHostPath)
    } finally {
      Remove-Item -LiteralPath $temporaryTaskHost -Force -ErrorAction SilentlyContinue
    }
  }

  $adminWrapper = @'
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = "Stop"
$root = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Prostar"
$releaseId = ([IO.File]::ReadAllText((Join-Path $root "current.txt"))).Trim()
if ($releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") { throw "The Prostar current release is invalid." }
$script = Join-Path (Join-Path (Join-Path $root "releases") $releaseId) "windows\prostar-admin.ps1"
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "The Prostar admin script is unavailable." }
& $script @Arguments
exit $LASTEXITCODE
'@
  Write-AtomicText -LiteralPath $AdminWrapperPath -Value ($adminWrapper.Replace("`n", "`r`n").TrimEnd([char[]]"`r`n"))

  $adminCommand = @'
@echo off
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Prostar\prostar-admin.ps1" %*
exit /b %ERRORLEVEL%
'@
  Write-AtomicText -LiteralPath $AdminCommandPath -Value ($adminCommand.Replace("`n", "`r`n").TrimEnd([char[]]"`r`n"))
}

function Register-ProstarTask {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [ValidateSet("gui-v2", "legacy-cmd")][string]$ActionVariant = "gui-v2"
  )
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $folder = $Service.GetFolder("\")
  $definition = $Service.NewTask(0)
  $definition.RegistrationInfo.Author = "Prostar"
  $definition.RegistrationInfo.Description = "Keeps the Prostar screen agent available after sign-in."
  $definition.RegistrationInfo.Source = "Prostar"
  $definition.Principal.UserId = $sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0

  $trigger = $definition.Triggers.Create(9)
  $trigger.UserId = $sid
  $trigger.Enabled = $true

  $action = $definition.Actions.Create(0)
  if ($ActionVariant -eq "legacy-cmd") {
    $action.Path = Join-Path $env:SystemRoot "System32\cmd.exe"
    $action.Arguments = "/d /q /c call `"$LauncherPath`""
  } else {
    $action.Path = $TaskHostPath
    $action.Arguments = ""
  }
  $action.WorkingDirectory = $AppRoot

  $settings = $definition.Settings
  $settings.Enabled = $true
  $settings.AllowDemandStart = $true
  $settings.AllowHardTerminate = $true
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.RunOnlyIfIdle = $false
  $settings.RunOnlyIfNetworkAvailable = $false
  $settings.StartWhenAvailable = $true
  $settings.WakeToRun = $false
  $settings.Hidden = $false
  $settings.MultipleInstances = 2
  $settings.ExecutionTimeLimit = "PT0S"
  $settings.RestartInterval = "PT1M"
  $settings.RestartCount = 255

  $registered = $folder.RegisterTaskDefinition($TaskName, $definition, 6, $null, $null, 3, $null)
  $registered.Enabled = $true
  return $registered
}

function Test-LocalHealth {
  $port = 8787
  foreach ($line in [IO.File]::ReadAllLines($EnvPath)) {
    if ($line -match "^PORT=([0-9]+)$") {
      $port = [int]$Matches[1]
      break
    }
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
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

function Restore-PreviousInstall {
  if (-not (Test-Path -LiteralPath $PendingMarker -PathType Leaf)) {
    return
  }
  $marker = [IO.File]::ReadAllText($PendingMarker) | ConvertFrom-Json
  $previousActionVariant = "legacy-cmd"
  $variantProperty = $marker.PSObject.Properties["taskActionVariant"]
  if ($null -ne $variantProperty) {
    $previousActionVariant = [string]$variantProperty.Value
  }
  if ($previousActionVariant -notin @("gui-v2", "legacy-cmd")) {
    throw "The saved Prostar task action is invalid."
  }
  $service = Connect-TaskScheduler
  Stop-ProstarTaskStrictly -Service $service -Disable

  $previousRelease = [string]$marker.previousRelease
  if ([string]::IsNullOrWhiteSpace($previousRelease)) {
    Remove-Item -LiteralPath $CurrentPointer -Force -ErrorAction SilentlyContinue
  } else {
    if ($previousRelease -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
      throw "The saved Prostar rollback release is invalid."
    }
    Write-AtomicText -LiteralPath $CurrentPointer -Value $previousRelease
  }

  $task = Get-ProstarTask -Service $service
  if (-not [bool]$marker.taskExisted) {
    if ($task) {
      Assert-OwnedTask -Task $task
      $service.GetFolder("\").DeleteTask($TaskName, 0)
    }
  } else {
    $task = Register-ProstarTask -Service $service -ActionVariant $previousActionVariant
    if ([bool]$marker.taskEnabled) {
      $task.Enabled = $true
      if ([bool]$marker.taskWasRunning -and -not [string]::IsNullOrWhiteSpace($previousRelease)) {
        [void]$task.Run($null)
      }
    } else {
      $task.Enabled = $false
    }
  }
  Remove-Item -LiteralPath $PendingMarker -Force
  $script:HandoffActive = $false
  Write-Detail "Restored the previous Prostar background agent."
}

if ($RollbackInstall) {
  Restore-PreviousInstall
  exit 0
}

if ($FinalizeInstall) {
  Write-LauncherFiles
  Remove-Item -LiteralPath $PendingMarker -Force
  Write-Detail "Completed the Prostar background-agent handoff."
  exit 0
}

Assert-InstallPaths
if (Test-Path -LiteralPath $PendingMarker -PathType Leaf) {
  throw "A previous Prostar installation still needs rollback or finalization."
}
if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "node-current.txt") -PathType Leaf)) {
  throw "Prostar's private Node.js runtime is unavailable."
}
[void](New-Item -ItemType Directory -Path $LogsRoot -Force)
Write-LauncherFiles

$service = Connect-TaskScheduler
$existingTask = Get-ProstarTask -Service $service
if ($existingTask) {
  Assert-OwnedTask -Task $existingTask
}
$previousRelease = Get-CurrentReleaseId
$taskWasRunning = $false
$taskWasEnabled = $false
$taskActionVariant = "legacy-cmd"
if ($existingTask) {
  $taskWasRunning = [int]$existingTask.State -eq 4
  $taskWasEnabled = [bool]$existingTask.Enabled
  $taskActionVariant = Get-TaskActionVariant -Task $existingTask
}
$marker = [ordered]@{
  schema = 2
  previousRelease = if ($previousRelease) { $previousRelease } else { "" }
  taskExisted = $null -ne $existingTask
  taskEnabled = $taskWasEnabled
  taskWasRunning = $taskWasRunning
  taskActionVariant = $taskActionVariant
}
Write-AtomicText -LiteralPath $PendingMarker -Value ($marker | ConvertTo-Json -Compress)
$HandoffActive = $true

try {
  Stop-ProstarTaskStrictly -Service $service -Disable
  Write-AtomicText -LiteralPath $CurrentPointer -Value ([IO.Path]::GetFileName($ReleaseRoot))
  $task = Register-ProstarTask -Service $service
  [void]$task.Run($null)
  if (-not (Wait-LocalHealth)) {
    throw "Prostar did not become healthy after the Windows task started."
  }
  $HandoffActive = $false
  Write-Detail "Installed the $TaskName scheduled task."
} catch {
  if ($HandoffActive) {
    try {
      Restore-PreviousInstall
    } catch {
      Write-Detail "Automatic rollback also failed: $($_.Exception.Message)"
    }
  }
  throw
}
