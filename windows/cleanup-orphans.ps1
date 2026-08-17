[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "The Prostar runtime cleanup can run only on Windows."
}

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$RuntimePrefix = [IO.Path]::GetFullPath((Join-Path $AppRoot "runtime")).TrimEnd("\") + "\"
$ReleasePrefix = [IO.Path]::GetFullPath((Join-Path $AppRoot "releases")).TrimEnd("\") + "\"
$PowerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"))
$CaptureSuffix = "\windows\capture-worker.ps1"

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

function Get-OrphanedChildProcesses {
  $result = New-Object System.Collections.ArrayList
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
    $path = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }
    try {
      $fullPath = [IO.Path]::GetFullPath($path)
    } catch {
      continue
    }
    $commandLine = [string]$process.CommandLine
    $isCloudflared = $fullPath.StartsWith($RuntimePrefix, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($fullPath).Equals("cloudflared.exe", [StringComparison]::OrdinalIgnoreCase)
    $isCaptureWorker = $fullPath.Equals($PowerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine.IndexOf($ReleasePrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $commandLine.IndexOf($CaptureSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isCloudflared -or $isCaptureWorker) {
      $identity = Get-ProcessIdentity -ProcessId ([int]$process.ProcessId)
      if ($identity) {
        [void]$result.Add($identity)
      }
    }
  }
  return $result
}

$identities = @(Get-OrphanedChildProcesses)
foreach ($identity in $identities) {
  if (Test-SameProcess -Identity $identity) {
    Stop-Process -Id ([int]$identity.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}
if ($identities.Count -gt 0) {
  Start-Sleep -Milliseconds 500
}
if (@(Get-OrphanedChildProcesses).Count -gt 0) {
  throw "A private Prostar child process survived agent cleanup."
}
