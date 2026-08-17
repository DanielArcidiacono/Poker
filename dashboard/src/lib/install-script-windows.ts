export function buildWindowsInstallScript(opts: {
  controlPlane: string;
  clientId: string;
  installToken: string;
}): string {
  const controlPlaneBase64 = Buffer.from(opts.controlPlane).toString("base64");
  const installTokenBase64 = Buffer.from(opts.installToken).toString("base64");

  return String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ControlPlaneBase64 = "${controlPlaneBase64}"
$ClientId = "${opts.clientId}"
$InstallTokenBase64 = "${installTokenBase64}"
$InstallSucceeded = $false
$FailureMessage = ""
$StagingRoot = $null
$SetupLock = $null

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = Join-Path $LocalAppData "Prostar"
$LogsRoot = Join-Path $AppRoot "logs"
$InstallLog = Join-Path $LogsRoot "install.log"

function Write-InstallFailure {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  try {
    [IO.File]::AppendAllText(
      $InstallLog,
      "[" + [DateTime]::UtcNow.ToString("o") + "] Bootstrap failure: " +
        $ErrorRecord.Exception.ToString() + [Environment]::NewLine,
      (New-Object Text.UTF8Encoding($false))
    )
  } catch {
  }
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $loopbackHttp = $Uri.Scheme -eq "http" -and
    ($Uri.Host -eq "127.0.0.1" -or $Uri.Host -eq "localhost")
  if ($Uri.Scheme -ne "https" -and -not $loopbackHttp) {
    throw "Prostar downloads require HTTPS, except on loopback."
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

try {
  if ($env:OS -ne "Windows_NT") {
    throw "This setup command is for Windows."
  }
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "Prostar requires Windows PowerShell 5.1 or later."
  }
  $build = 0
  try {
    $versionKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $build = [int](Get-ItemProperty -LiteralPath $versionKey -Name CurrentBuildNumber).CurrentBuildNumber
  } catch {
    $build = [Environment]::OSVersion.Version.Build
  }
  if ($build -lt 17763) {
    throw "Prostar requires Windows 10 version 1809 or later."
  }
  $nativeArchitecture = $null
  try {
    $architectureKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    $nativeArchitecture = (Get-ItemProperty -LiteralPath $architectureKey -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch {
    $nativeArchitecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($nativeArchitecture)) {
      $nativeArchitecture = $env:PROCESSOR_ARCHITECTURE
    }
  }
  if ($nativeArchitecture -ne "AMD64" -and $nativeArchitecture -ne "ARM64") {
    throw "Prostar supports only x64 and Arm64 Windows computers."
  }
  if ($nativeArchitecture -eq "ARM64" -and $build -lt 22000) {
    throw "Prostar on Arm64 requires Windows 11 or later."
  }

  [void](New-Item -ItemType Directory -Path $LogsRoot -Force)
  [IO.File]::WriteAllText($InstallLog, "", (New-Object Text.UTF8Encoding($false)))

  $lockPath = Join-Path $AppRoot ".setup.lock"
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
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

  $utf8 = New-Object Text.UTF8Encoding($false)
  $controlPlane = $utf8.GetString([Convert]::FromBase64String($ControlPlaneBase64)).TrimEnd("/")
  $controlPlaneUri = $null
  if (-not [Uri]::TryCreate($controlPlane, [UriKind]::Absolute, [ref]$controlPlaneUri)) {
    throw "The Prostar dashboard address is invalid."
  }
  $loopbackHttp = $controlPlaneUri.Scheme -eq "http" -and
    ($controlPlaneUri.Host -eq "127.0.0.1" -or $controlPlaneUri.Host -eq "localhost")
  if ($controlPlaneUri.Scheme -ne "https" -and -not $loopbackHttp) {
    throw "Production setup requires HTTPS, except for a loopback dashboard."
  }

  $StagingRoot = Join-Path $AppRoot (".installer-staging-" + [Guid]::NewGuid().ToString("N"))
  $extracted = Join-Path $StagingRoot "extracted"
  [void](New-Item -ItemType Directory -Path $extracted -Force)
  $archivePath = Join-Path $StagingRoot "prostar-agent.tgz"
  $checksumPath = Join-Path $StagingRoot "prostar-agent.tgz.sha256"
  Invoke-Download -Uri ([Uri]::new($controlPlaneUri, "/prostar-agent.tgz")) -Destination $archivePath
  Invoke-Download -Uri ([Uri]::new($controlPlaneUri, "/prostar-agent.tgz.sha256")) -Destination $checksumPath

  $checksumText = ([IO.File]::ReadAllText($checksumPath)).Trim()
  if ($checksumText -notmatch "^([0-9a-fA-F]{64})\s+\*?prostar-agent\.tgz$") {
    throw "The Prostar package checksum file is invalid."
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "The downloaded Prostar package failed checksum verification."
  }

  $tarPath = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path -LiteralPath $tarPath -PathType Leaf)) {
    throw "Windows tar.exe is unavailable."
  }
  $tarErrorPath = Join-Path $StagingRoot "tar-error.log"
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 treats redirected native stderr as a PowerShell
    # error. tar.exe's exit code remains authoritative.
    $ErrorActionPreference = "Continue"
    $LASTEXITCODE = 1
    $entries = @(& $tarPath -tzf $archivePath 2> $tarErrorPath)
    $tarListExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($tarListExitCode -ne 0 -or $entries.Count -eq 0) {
    throw "The downloaded Prostar package could not be inspected."
  }
  foreach ($rawEntry in $entries) {
    $entry = ([string]$rawEntry).Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($entry) -or
        $entry.StartsWith("/") -or $entry.Contains(":")) {
      throw "The downloaded Prostar package contains an unsafe path."
    }
    foreach ($part in $entry.Split("/")) {
      if ($part -eq "..") {
        throw "The downloaded Prostar package contains an unsafe path."
      }
    }
  }
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $LASTEXITCODE = 1
    & $tarPath -xzf $archivePath -C $extracted > $null 2> $tarErrorPath
    $tarExtractExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($tarExtractExitCode -ne 0) {
    throw "The downloaded Prostar package could not be extracted."
  }
  $productionInstaller = Join-Path $extracted "windows\production-install.ps1"
  if (-not (Test-Path -LiteralPath $productionInstaller -PathType Leaf)) {
    throw "The downloaded Prostar package has no Windows installer."
  }

  $installArguments = @{
    ControlPlaneBase64 = $ControlPlaneBase64
    ClientId = $ClientId
    InstallTokenBase64 = $InstallTokenBase64
    SourceRoot = $extracted
    InstallLog = $InstallLog
  }
  & $productionInstaller @installArguments *> $null
  $InstallSucceeded = $true
} catch {
  $FailureMessage = ([string]$_.Exception.Message -replace "[\r\n]+", " ").Trim()
  if ($FailureMessage.Length -gt 300) {
    $FailureMessage = $FailureMessage.Substring(0, 300)
  }
  Write-InstallFailure -ErrorRecord $_
} finally {
  $InstallTokenBase64 = ""
  if ($SetupLock) {
    $SetupLock.Dispose()
  }
  if ($StagingRoot -and (Test-Path -LiteralPath $StagingRoot)) {
    $prefix = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\") + "\"
    $fullStaging = [IO.Path]::GetFullPath($StagingRoot)
    if ($fullStaging.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullStaging).StartsWith(".installer-staging-")) {
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
`;
}
