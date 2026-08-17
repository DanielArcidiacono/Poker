[CmdletBinding()]
param([switch]$Purge)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "The Windows Prostar uninstaller can run only on Windows."
}

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$ReleasesRoot = Join-Path $AppRoot "releases"
$RuntimeRoot = Join-Path $AppRoot "runtime"
$CurrentPointer = Join-Path $AppRoot "current.txt"
$PendingIdentity = Join-Path $AppRoot ".pending-enrollment"
$LauncherPath = Join-Path $AppRoot "prostar-launcher.cmd"

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

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return $false
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-PurgePaths {
  $knownLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $expected = [IO.Path]::GetFullPath((Join-Path $knownLocalAppData "Prostar"))
  if (-not $AppRoot.Equals($expected, [StringComparison]::OrdinalIgnoreCase) -or
      $AppRoot.Length -le 3) {
    throw "Refusing to purge an unexpected Prostar application path."
  }
  if (Test-ReparsePoint -LiteralPath $AppRoot) {
    throw "Refusing to purge a Prostar application root that is a reparse point."
  }
  foreach ($path in @($CurrentPointer, $PendingIdentity)) {
    if (Test-ReparsePoint -LiteralPath $path) {
      throw "Refusing to purge an unsafe Prostar state file."
    }
  }
  if (Test-Path -LiteralPath $AppRoot -PathType Container) {
    $pendingDirectories = New-Object System.Collections.Stack
    $pendingDirectories.Push((Get-Item -LiteralPath $AppRoot -Force))
    while ($pendingDirectories.Count -gt 0) {
      $directory = $pendingDirectories.Pop()
      foreach ($entry in $directory.EnumerateFileSystemInfos()) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "Refusing to purge Prostar because it contains a reparse point: $($entry.FullName)"
        }
        if (($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          $pendingDirectories.Push($entry)
        }
      }
    }
  }
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
  $expectedArguments = "/d /q /c call `"$LauncherPath`""
  if (-not $actualCommand.Equals($expectedCommand, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([string]$action.Arguments).Trim().Equals(
        $expectedArguments,
        [StringComparison]::OrdinalIgnoreCase
      )) {
    throw "The existing $TaskName task is not owned by this Prostar installation."
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
  $runtimePrefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
  $releasePrefix = [IO.Path]::GetFullPath($ReleasesRoot).TrimEnd("\") + "\"
  $captureSuffix = "\windows\capture-worker.ps1"
  $powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"))
  $cmdPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))
  # A failed full process inventory must never be mistaken for "nothing is
  # running" during a destructive purge.
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
    $isRuntimeProcess = $full.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
    $isCaptureWorker = $full.Equals($powerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf($captureSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $isLauncher = $full.Equals($cmdPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($LauncherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isRuntimeProcess -or $isCaptureWorker -or $isLauncher) {
      $identity = Get-ProcessIdentity -ProcessId ([int]$process.ProcessId)
      if ($identity) {
        [void]$result.Add($identity)
      }
    }
  }
  return $result
}

function Stop-ProstarStrictly {
  param([Parameter(Mandatory = $true)]$Service)
  $task = Get-ProstarTask -Service $Service
  if ($task) {
    Assert-OwnedTask -Task $task
    $task.Enabled = $false
  }
  $identities = @(Get-OwnedProstarProcesses)
  if ($task -and [int]$task.State -eq 4) {
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
  $remaining = @(Get-OwnedProstarProcesses)
  if ($remaining.Count -gt 0) {
    throw "Prostar could not be stopped completely; no application data was deleted."
  }
  $task = Get-ProstarTask -Service $Service
  if ($task -and [int]$task.State -eq 4) {
    throw "The Prostar task is still running; no application data was deleted."
  }
}

function Get-CurrentEnvPath {
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) {
    return $null
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
  $envPath = Join-Path $releasePath ".env"
  if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    return $envPath
  }
  return $null
}

function Get-EnvValueFromFile {
  param(
    [string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Key
  )
  if ([string]::IsNullOrWhiteSpace($FilePath) -or
      -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return ""
  }
  foreach ($line in [IO.File]::ReadAllLines($FilePath)) {
    if ($line.StartsWith($Key + "=", [StringComparison]::Ordinal)) {
      return $line.Substring($Key.Length + 1).TrimEnd("`r")
    }
  }
  return ""
}

function Get-IdentityFromFile {
  param([string]$FilePath)
  return [PSCustomObject]@{
    ControlPlane = Get-EnvValueFromFile -FilePath $FilePath -Key "CONTROL_PLANE_URL"
    ClientId = Get-EnvValueFromFile -FilePath $FilePath -Key "PROSTAR_CLIENT_ID"
    Secret = Get-EnvValueFromFile -FilePath $FilePath -Key "PROSTAR_AGENT_SECRET"
    LocalOnly =
      (Get-EnvValueFromFile -FilePath $FilePath -Key "AUTO_TUNNEL") -eq "0" -and
      [string]::IsNullOrWhiteSpace(
        (Get-EnvValueFromFile -FilePath $FilePath -Key "CONTROL_PLANE_URL")
      )
  }
}

function Invoke-Deenroll {
  param([Parameter(Mandatory = $true)]$Identity)
  if ([bool]$Identity.LocalOnly) {
    return
  }
  if ([string]::IsNullOrWhiteSpace($Identity.ControlPlane) -and
      [string]::IsNullOrWhiteSpace($Identity.ClientId) -and
      [string]::IsNullOrWhiteSpace($Identity.Secret)) {
    return
  }
  if ([string]::IsNullOrWhiteSpace($Identity.ControlPlane) -or
      $Identity.ClientId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" -or
      $Identity.Secret -notmatch "^[A-Za-z0-9_-]{32,256}$") {
    throw "Prostar's dashboard credentials are incomplete; no application data was deleted."
  }
  $baseUri = $null
  if (-not [Uri]::TryCreate($Identity.ControlPlane.TrimEnd("/"), [UriKind]::Absolute, [ref]$baseUri)) {
    throw "Prostar's dashboard URL is invalid; no application data was deleted."
  }
  $isLoopbackHttp = $baseUri.Scheme -eq "http" -and
    ($baseUri.Host -eq "127.0.0.1" -or $baseUri.Host -eq "localhost")
  if ($baseUri.Scheme -ne "https" -and -not $isLoopbackHttp) {
    throw "Prostar's dashboard URL is invalid; no application data was deleted."
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create([Uri]::new($baseUri, "/api/agent/deenroll"))
  $request.Method = "DELETE"
  $request.ContentType = "application/json"
  $request.Headers["Authorization"] = "Bearer $($Identity.Secret)"
  $request.Timeout = 20000
  $request.ReadWriteTimeout = 20000
  $request.AllowAutoRedirect = $false
  $body = [Text.Encoding]::UTF8.GetBytes((@{ clientId = $Identity.ClientId } | ConvertTo-Json -Compress))
  $request.ContentLength = $body.Length
  $stream = $request.GetRequestStream()
  try {
    $stream.Write($body, 0, $body.Length)
  } finally {
    $stream.Dispose()
  }
  $status = 0
  try {
    $response = $request.GetResponse()
    try {
      $status = [int]$response.StatusCode
    } finally {
      $response.Dispose()
    }
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $_.Exception.Response.Dispose()
    }
  }
  if ($status -ne 204) {
    $description = if ($status -eq 0) { "unreachable" } else { [string]$status }
    throw "The dashboard session could not be revoked (HTTP $description); no application data was deleted."
  }
}

try {
  Assert-PurgePaths
  $service = Connect-TaskScheduler
  if (-not $Purge) {
    Stop-ProstarStrictly -Service $service
    $task = Get-ProstarTask -Service $service
    if ($task) {
      Assert-OwnedTask -Task $task
      $service.GetFolder("\").DeleteTask($TaskName, 0)
    }
    Write-Output "Removed the Prostar background task."
    exit 0
  }

  # Snapshot revocation material before stopping or deleting any release.
  $currentIdentity = Get-IdentityFromFile -FilePath (Get-CurrentEnvPath)
  $pendingIdentity = Get-IdentityFromFile -FilePath $PendingIdentity

  Stop-ProstarStrictly -Service $service
  Invoke-Deenroll -Identity $currentIdentity
  Invoke-Deenroll -Identity $pendingIdentity

  $task = Get-ProstarTask -Service $service
  if ($task) {
    Assert-OwnedTask -Task $task
    $service.GetFolder("\").DeleteTask($TaskName, 0)
  }
  if (@(Get-OwnedProstarProcesses).Count -gt 0) {
    throw "A Prostar process reappeared; no application data was deleted."
  }

  # The uninstaller may have been launched with its own release directory as
  # the process working directory. PowerShell's provider location and the
  # process working directory are distinct on Windows; move both before
  # deleting the release that contains this script.
  $outsideDirectory = [IO.Path]::GetFullPath($LocalAppData)
  Set-Location -LiteralPath $outsideDirectory
  [Environment]::CurrentDirectory = $outsideDirectory
  $normalizedWorkingDirectory = ([IO.Path]::GetFullPath([Environment]::CurrentDirectory)).TrimEnd("\")
  $normalizedAppRoot = ([IO.Path]::GetFullPath($AppRoot)).TrimEnd("\")
  if ($normalizedWorkingDirectory -ieq $normalizedAppRoot -or
      $normalizedWorkingDirectory.StartsWith($normalizedAppRoot + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The uninstaller could not leave the Prostar application directory."
  }
  if (Test-Path -LiteralPath $AppRoot) {
    Remove-Item -LiteralPath $AppRoot -Recurse -Force
  }
  Write-Output "Removed Prostar and all of its private data."
  exit 0
} catch {
  [Console]::Error.WriteLine("Error: " + $_.Exception.Message)
  exit 1
}
