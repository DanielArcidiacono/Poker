[CmdletBinding()]
param(
  [string]$Repository = "DanielArcidiacono/Poker",
  [string]$Ref = "v1.2.1",
  [string]$ViewerPassword = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InstallSucceeded = $false
$FailureMessage = ""
$StagingRoot = $null
$ReleasePath = $null
$SetupLock = $null
$HandoffStarted = $false
$KeepRelease = $false
$AgentSecret = ""
$LastCaptureError = ""

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$ReleasesRoot = Join-Path $AppRoot "releases"
$RuntimeRoot = Join-Path $AppRoot "runtime"
$CurrentPointer = Join-Path $AppRoot "current.txt"
$PendingMarker = Join-Path $AppRoot ".install-pending.json"
$LogsRoot = Join-Path $AppRoot "logs"
$InstallLog = Join-Path $LogsRoot "install.log"
$utf8 = New-Object Text.UTF8Encoding($false)

function Write-InstallLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  [IO.File]::AppendAllText(
    $InstallLog,
    "[$([DateTime]::UtcNow.ToString('o'))] $Message" + [Environment]::NewLine,
    $utf8
  )
}

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return $false
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-CurrentReleaseId {
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) {
    return $null
  }
  if (Test-ReparsePoint -LiteralPath $CurrentPointer) {
    throw "The Prostar current-release pointer is unsafe."
  }
  $releaseId = ([IO.File]::ReadAllText($CurrentPointer)).Trim()
  if ($releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The Prostar current-release pointer is invalid."
  }
  return $releaseId
}

function Get-ReleasePath {
  param([string]$ReleaseId)
  if ([string]::IsNullOrWhiteSpace($ReleaseId) -or
      $ReleaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    return $null
  }
  $path = [IO.Path]::GetFullPath((Join-Path $ReleasesRoot $ReleaseId))
  $prefix = [IO.Path]::GetFullPath($ReleasesRoot).TrimEnd("\") + "\"
  if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "A Prostar release path is unsafe."
  }
  return $path
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
      return $line.Substring($Key.Length + 1).TrimEnd([char]13)
    }
  }
  return ""
}

function New-Secret {
  param([Parameter(Mandatory = $true)][int]$ByteCount)
  $bytes = New-Object byte[] $ByteCount
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if ($Uri.Scheme -ne "https") {
    throw "Prostar source downloads require HTTPS."
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $client = New-Object Net.WebClient
      if ($client.Proxy) {
        $client.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
      }
      try {
        $client.DownloadFile($Uri, $Destination)
      } finally {
        $client.Dispose()
      }
      return
    } catch {
      $lastError = $_
      Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
      if ($attempt -lt 3) {
        Start-Sleep -Seconds $attempt
      }
    }
  }
  throw $lastError
}

function Expand-SafeSourceArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  $rootName = $null
  try {
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace("\", "/")
      if ([string]::IsNullOrWhiteSpace($name) -or
          $name.StartsWith("/") -or $name.Contains(":")) {
        throw "The downloaded Prostar archive contains an unsafe path."
      }
      $parts = @($name.Split("/") | Where-Object { $_.Length -gt 0 })
      if ($parts.Count -eq 0 -or $parts -contains "..") {
        throw "The downloaded Prostar archive contains an unsafe path."
      }
      if ($null -eq $rootName) {
        $rootName = $parts[0]
      } elseif ($parts[0] -ne $rootName) {
        throw "The downloaded Prostar archive has multiple roots."
      }
    }
  } finally {
    $archive.Dispose()
  }
  if ([string]::IsNullOrWhiteSpace($rootName)) {
    throw "The downloaded Prostar archive is empty."
  }
  [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Destination)
  return Join-Path $Destination $rootName
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Description
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = 1
  Push-Location -LiteralPath $WorkingDirectory
  try {
    # Windows PowerShell 5.1 turns redirected native stderr into PowerShell
    # Error records. A warning must not fail a process whose exit code is zero.
    # Append the records explicitly to keep this otherwise quiet log UTF-8.
    $ErrorActionPreference = "Continue"
    $LASTEXITCODE = 1
    & $FilePath @Arguments 2>&1 | ForEach-Object {
      [IO.File]::AppendAllText(
        $InstallLog,
        ([string]$_) + [Environment]::NewLine,
        $utf8
      )
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Description failed with exit code $exitCode."
  }
}

function Invoke-AgentInstaller {
  param(
    [Parameter(Mandatory = $true)][string]$TargetRelease,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments
  )
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $scriptPath = Join-Path $TargetRelease "windows\install-agent.ps1"
  $allArguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $scriptPath
  ) + $Arguments
  Invoke-LoggedNative -FilePath $powerShell -Arguments $allArguments -WorkingDirectory $TargetRelease -Description "Windows background-task installation"
}

function Test-CapturePreflight {
  param([Parameter(Mandatory = $true)][string]$Bearer)
  $script:LastCaptureError = ""
  $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:8787/api/capture/preflight")
  $request.Method = "POST"
  $request.Timeout = 20000
  $request.ReadWriteTimeout = 20000
  $request.AllowAutoRedirect = $false
  $request.Headers["Authorization"] = "Bearer $Bearer"
  try {
    $response = $request.GetResponse()
    try {
      return [int]$response.StatusCode -eq 204
    } finally {
      $response.Dispose()
    }
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      $errorResponse = $_.Exception.Response
      try {
        $reader = New-Object IO.StreamReader($errorResponse.GetResponseStream())
        try {
          $body = $reader.ReadToEnd()
          if (-not [string]::IsNullOrWhiteSpace($body)) {
            try {
              $detail = [string](($body | ConvertFrom-Json).error)
            } catch {
              $detail = $body
            }
            $detail = ($detail -replace "[\r\n]+", " ").Trim()
            if ($detail.Length -gt 500) {
              $detail = $detail.Substring(0, 500)
            }
            $script:LastCaptureError = $detail
          }
        } finally {
          $reader.Dispose()
        }
      } finally {
        $errorResponse.Dispose()
      }
    }
    return $false
  }
}

function Invoke-FailureCleanup {
  if ($HandoffStarted -and $ReleasePath -and
      (Test-Path -LiteralPath $PendingMarker -PathType Leaf)) {
    try {
      Invoke-AgentInstaller -TargetRelease $ReleasePath -Arguments @("-RollbackInstall")
    } catch {
      $script:KeepRelease = $true
      Write-InstallLog "Rollback failed: $($_.Exception.Message)"
    }
  }
  if (-not $KeepRelease -and $ReleasePath -and (Test-Path -LiteralPath $ReleasePath)) {
    $current = Get-CurrentReleaseId
    if ($current -ne [IO.Path]::GetFileName($ReleasePath) -and
        -not (Test-ReparsePoint -LiteralPath $ReleasePath)) {
      Remove-Item -LiteralPath $ReleasePath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  if ($env:OS -ne "Windows_NT") {
    throw "This setup script is for Windows."
  }
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "Prostar requires Windows PowerShell 5.1 or later."
  }
  if ($Repository -notmatch "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" -or
      $Ref -notmatch "^[A-Za-z0-9._/-]+$" -or $Ref.Contains("..")) {
    throw "The Prostar source repository or ref is invalid."
  }

  $build = 0
  try {
    $versionKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $build = [int](Get-ItemProperty -LiteralPath $versionKey -Name CurrentBuildNumber).CurrentBuildNumber
  } catch {
    $build = [Environment]::OSVersion.Version.Build
  }
  $architectureKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
  try {
    $architecture = (Get-ItemProperty -LiteralPath $architectureKey -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
      $architecture = $env:PROCESSOR_ARCHITECTURE
    }
  }
  if ($build -lt 17763 -or ($architecture -ne "AMD64" -and $architecture -ne "ARM64")) {
    throw "Prostar requires Windows 10 version 1809 or later on x64, or Windows 11 on Arm64."
  }
  if ($architecture -eq "ARM64" -and $build -lt 22000) {
    throw "Prostar on Arm64 requires Windows 11 or later."
  }

  if ((Test-ReparsePoint -LiteralPath $AppRoot) -or
      (Test-ReparsePoint -LiteralPath $ReleasesRoot)) {
    throw "Prostar installation paths must be ordinary directories."
  }
  [void](New-Item -ItemType Directory -Path $LogsRoot -Force)
  [IO.File]::WriteAllText($InstallLog, "", $utf8)
  [void](New-Item -ItemType Directory -Path $ReleasesRoot -Force)

  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $lockPath = Join-Path $AppRoot ".setup.lock"
  while ($null -eq $SetupLock) {
    try {
      $SetupLock = New-Object IO.FileStream(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for another Prostar setup."
      }
      Start-Sleep -Milliseconds 500
    }
  }

  $StagingRoot = Join-Path $AppRoot (".bootstrap-staging-" + [Guid]::NewGuid().ToString("N"))
  $extractedRoot = Join-Path $StagingRoot "extracted"
  [void](New-Item -ItemType Directory -Path $extractedRoot -Force)
  $archivePath = Join-Path $StagingRoot "prostar.zip"
  $escapedRef = [Uri]::EscapeDataString($Ref)
  $archiveUri = [Uri]("https://codeload.github.com/$Repository/zip/$escapedRef")
  Invoke-Download -Uri $archiveUri -Destination $archivePath
  $sourceRoot = Expand-SafeSourceArchive -ArchivePath $archivePath -Destination $extractedRoot

  if (Test-Path -LiteralPath $PendingMarker -PathType Leaf) {
    $interruptedRelease = Get-ReleasePath -ReleaseId (Get-CurrentReleaseId)
    $recoveryRelease = if ($interruptedRelease -and
        (Test-Path -LiteralPath (Join-Path $interruptedRelease "windows\install-agent.ps1") -PathType Leaf)) {
      $interruptedRelease
    } elseif (Test-Path -LiteralPath (Join-Path $sourceRoot "windows\install-agent.ps1") -PathType Leaf) {
      $sourceRoot
    } else {
      $null
    }
    if (-not $recoveryRelease) {
      throw "A previous Prostar upgrade needs manual recovery."
    }
    Invoke-AgentInstaller -TargetRelease $recoveryRelease -Arguments @("-RollbackInstall")
  }

  $previousRelease = Get-ReleasePath -ReleaseId (Get-CurrentReleaseId)
  $previousEnv = if ($previousRelease) { Join-Path $previousRelease ".env" } else { $null }
  if ([string]::IsNullOrWhiteSpace($ViewerPassword)) {
    $ViewerPassword = [string]$env:PROSTAR_VIEWER_PASSWORD
  }
  if ([string]::IsNullOrWhiteSpace($ViewerPassword)) {
    $savedPassword = Get-EnvValueFromFile -FilePath $previousEnv -Key "PROSTAR_VIEWER_PASSWORD"
    if ($savedPassword -match "^[A-Za-z0-9_-]{12,128}$") {
      $ViewerPassword = $savedPassword
    }
  }
  if ([string]::IsNullOrWhiteSpace($ViewerPassword)) {
    $ViewerPassword = New-Secret -ByteCount 24
  }
  if ($ViewerPassword -notmatch "^[A-Za-z0-9_-]{12,128}$") {
    throw "PROSTAR_VIEWER_PASSWORD must be 12-128 URL-safe characters."
  }
  $AgentSecret = Get-EnvValueFromFile -FilePath $previousEnv -Key "PROSTAR_AGENT_SECRET"
  if ($AgentSecret -notmatch "^[A-Za-z0-9_-]{32,256}$") {
    $AgentSecret = New-Secret -ByteCount 32
  }

  $releaseId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss") + "-" + [Guid]::NewGuid().ToString("N")
  $ReleasePath = Join-Path $ReleasesRoot $releaseId
  [IO.Directory]::Move([IO.Path]::GetFullPath($sourceRoot), $ReleasePath)
  if (-not (Test-Path -LiteralPath (Join-Path $ReleasePath "package-lock.json") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\ensure-runtime.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\install-agent.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\cleanup-orphans.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "src\server.ts") -PathType Leaf)) {
    throw "The downloaded Prostar source archive is incomplete."
  }

  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $previousAppRootOverride = [string]$env:PROSTAR_APP_ROOT
  try {
    $env:PROSTAR_APP_ROOT = $AppRoot
    Invoke-LoggedNative -FilePath $powerShell -Arguments @(
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $ReleasePath "windows\ensure-runtime.ps1"), "-NodeOnly"
    ) -WorkingDirectory $ReleasePath -Description "Private Node.js runtime installation"
  } finally {
    if ([string]::IsNullOrEmpty($previousAppRootOverride)) {
      Remove-Item Env:PROSTAR_APP_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:PROSTAR_APP_ROOT = $previousAppRootOverride
    }
  }

  $nodeId = ([IO.File]::ReadAllText((Join-Path $RuntimeRoot "node-current.txt"))).Trim()
  if ($nodeId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The private Node.js runtime pointer is invalid."
  }
  $npmPath = Join-Path (Join-Path $RuntimeRoot $nodeId) "npm.cmd"
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw "The private Node.js runtime is incomplete."
  }

  $envContents = @(
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
  [IO.File]::WriteAllText((Join-Path $ReleasePath ".env"), $envContents + [Environment]::NewLine, $utf8)

  $env:npm_config_cache = Join-Path $RuntimeRoot "npm-cache"
  $env:npm_config_update_notifier = "false"
  [void](New-Item -ItemType Directory -Path $env:npm_config_cache -Force)
  Invoke-LoggedNative -FilePath $npmPath -Arguments @(
    "ci", "--foreground-scripts", "--no-audit", "--no-fund"
  ) -WorkingDirectory $ReleasePath -Description "Dependency installation"
  Invoke-LoggedNative -FilePath $npmPath -Arguments @(
    "run", "build", "--silent"
  ) -WorkingDirectory $ReleasePath -Description "Agent build"

  Invoke-AgentInstaller -TargetRelease $ReleasePath -Arguments @()
  $HandoffStarted = $true
  if (-not (Test-CapturePreflight -Bearer $AgentSecret)) {
    $detail = if ([string]::IsNullOrWhiteSpace($LastCaptureError)) {
      ""
    } else {
      " ($LastCaptureError)"
    }
    throw "Windows screen capture is unavailable in the current user session$detail."
  }
  Invoke-AgentInstaller -TargetRelease $ReleasePath -Arguments @("-FinalizeInstall")
  $InstallSucceeded = $true
  Write-InstallLog "Local-only Prostar Windows installation completed successfully."
} catch {
  $FailureMessage = ([string]$_.Exception.Message -replace "[\r\n]+", " ").Trim()
  if ($FailureMessage.Length -gt 300) {
    $FailureMessage = $FailureMessage.Substring(0, 300)
  }
  if (Test-Path -LiteralPath $LogsRoot -PathType Container) {
    Write-InstallLog ("Installation failed: " + $_.Exception.ToString())
  }
  Invoke-FailureCleanup
} finally {
  $AgentSecret = ""
  $ViewerPassword = ""
  if ($SetupLock) {
    $SetupLock.Dispose()
  }
  if ($StagingRoot -and (Test-Path -LiteralPath $StagingRoot)) {
    $prefix = $AppRoot.TrimEnd("\") + "\"
    $fullStaging = [IO.Path]::GetFullPath($StagingRoot)
    if ($fullStaging.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullStaging).StartsWith(".bootstrap-staging-")) {
      Remove-Item -LiteralPath $fullStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($InstallSucceeded) {
  Write-Output "Prostar installed successfully."
  exit 0
}
[Console]::Error.WriteLine(
  "Prostar installation failed" +
    $(if ([string]::IsNullOrWhiteSpace($FailureMessage)) { "." } else { ": " + $FailureMessage })
)
[Console]::Error.WriteLine("Details: " + $InstallLog)
exit 1
