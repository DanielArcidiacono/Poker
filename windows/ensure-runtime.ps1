[CmdletBinding()]
param(
  [switch]$NodeOnly,
  [switch]$WithCloudflared
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# Prostar owns its runtime instead of modifying the machine-wide Node.js or
# cloudflared installation. Every artifact is pinned and verified before use.
$NodeVersion = "24.19.0"
$CloudflaredVersion = "2026.8.2"
$NodeX64ArchiveHash = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$NodeArm64ArchiveHash = "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f"
$NodeX64BinaryHash = "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"
$NodeArm64BinaryHash = "3958e4bb3f2d4ef37c938215dfc65a9d3c9d839b5060fec103bd2345fa78e951"
$CloudflaredAmd64Hash = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5"

if ($NodeOnly -and $WithCloudflared) {
  throw "Choose either -NodeOnly or -WithCloudflared, not both."
}
if (-not $NodeOnly -and -not $WithCloudflared) {
  $NodeOnly = $true
}
if ($env:OS -ne "Windows_NT") {
  throw "The Windows runtime installer can run only on Windows."
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Prostar requires Windows PowerShell 5.1 or later."
}

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
  throw "Windows did not provide a Local AppData folder."
}
$DefaultAppRoot = Join-Path $LocalAppData "Prostar"
$AppRoot = if ([string]::IsNullOrWhiteSpace($env:PROSTAR_APP_ROOT)) {
  $DefaultAppRoot
} else {
  [IO.Path]::GetFullPath($env:PROSTAR_APP_ROOT)
}
$RuntimeRoot = Join-Path $AppRoot "runtime"
$StagingPath = $null
$LockStream = $null

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return $false
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-OrdinaryDirectory {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  if (Test-Path -LiteralPath $LiteralPath) {
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if (-not $item.PSIsContainer -or (Test-ReparsePoint -LiteralPath $LiteralPath)) {
      throw "$LiteralPath must be an ordinary directory."
    }
  }
}

function Protect-ProstarDirectory {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($sidText in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sidText)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      $allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

function Get-NativeArchitecture {
  $architecture = $null
  try {
    $registryPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    $nativeEnvironment = Get-ItemProperty -LiteralPath $registryPath -Name PROCESSOR_ARCHITECTURE
    $architecture = $nativeEnvironment.PROCESSOR_ARCHITECTURE
  } catch {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
      $architecture = $env:PROCESSOR_ARCHITECTURE
    }
  }

  switch ([string]$architecture) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default { throw "Unsupported Windows architecture: $architecture" }
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $actual = Get-Sha256 -LiteralPath $LiteralPath
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "Checksum verification failed for $([IO.Path]::GetFileName($LiteralPath))."
  }
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if ($Uri.Scheme -ne "https") {
    throw "Runtime downloads require HTTPS."
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

function Write-AtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $parent = Split-Path -Parent $LiteralPath
  $temporary = Join-Path $parent (".write-" + [Guid]::NewGuid().ToString("N"))
  try {
    [IO.File]::WriteAllText($temporary, $Value + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
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

function Expand-VerifiedNodeArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ExpectedRoot,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $prefix = $ExpectedRoot + "/"
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName.Replace("\", "/")
      if ([string]::IsNullOrWhiteSpace($name)) {
        continue
      }
      if ($name.StartsWith("/") -or $name.Contains(":") -or
          -not ($name -eq $ExpectedRoot -or $name.StartsWith($prefix))) {
        throw "The Node.js archive contains an unexpected path."
      }
      foreach ($part in $name.Split("/")) {
        if ($part -eq "..") {
          throw "The Node.js archive contains an unsafe path."
        }
      }
    }
  } finally {
    $archive.Dispose()
  }
  [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Destination)
}

function Install-NodeRuntime {
  param([Parameter(Mandatory = $true)][string]$Architecture)

  if ($Architecture -eq "arm64") {
    $archiveHash = $NodeArm64ArchiveHash
    $binaryHash = $NodeArm64BinaryHash
  } else {
    $archiveHash = $NodeX64ArchiveHash
    $binaryHash = $NodeX64BinaryHash
  }
  $archiveName = "node-v$NodeVersion-win-$Architecture.zip"
  $archiveRoot = "node-v$NodeVersion-win-$Architecture"
  $installId = "$archiveRoot-$($archiveHash.Substring(0, 12))"
  $installPath = Join-Path $RuntimeRoot $installId
  $nodePath = Join-Path $installPath "node.exe"
  $npmPath = Join-Path $installPath "npm.cmd"

  if (Test-Path -LiteralPath $installPath) {
    Assert-OrdinaryDirectory -LiteralPath $installPath
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
      throw "The installed Prostar Node.js runtime is incomplete."
    }
    Assert-Sha256 -LiteralPath $nodePath -Expected $binaryHash
  } else {
    $script:StagingPath = Join-Path $RuntimeRoot (".staging-node-" + [Guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $script:StagingPath)
    $archivePath = Join-Path $script:StagingPath $archiveName
    Invoke-Download -Uri ([Uri]"https://nodejs.org/dist/v$NodeVersion/$archiveName") -Destination $archivePath
    Assert-Sha256 -LiteralPath $archivePath -Expected $archiveHash
    $extractPath = Join-Path $script:StagingPath "extracted"
    [void](New-Item -ItemType Directory -Path $extractPath)
    Expand-VerifiedNodeArchive -ArchivePath $archivePath -ExpectedRoot $archiveRoot -Destination $extractPath
    $extractedRoot = Join-Path $extractPath $archiveRoot
    $extractedNode = Join-Path $extractedRoot "node.exe"
    $extractedNpm = Join-Path $extractedRoot "npm.cmd"
    if (-not (Test-Path -LiteralPath $extractedNode -PathType Leaf) -or
        -not (Test-Path -LiteralPath $extractedNpm -PathType Leaf)) {
      throw "The Node.js archive is incomplete."
    }
    Assert-Sha256 -LiteralPath $extractedNode -Expected $binaryHash
    [IO.Directory]::Move($extractedRoot, $installPath)
    Remove-Item -LiteralPath $script:StagingPath -Recurse -Force
    $script:StagingPath = $null
  }

  $version = (& $nodePath --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -ne "v$NodeVersion") {
    throw "The private Node.js runtime has the wrong version."
  }
  Write-AtomicText -LiteralPath (Join-Path $RuntimeRoot "node-current.txt") -Value $installId
}

function Install-CloudflaredRuntime {
  # Cloudflare does not publish a Windows ARM64 binary for this release.
  # Windows 11 on ARM runs the official x64 binary through built-in emulation.
  $assetName = "cloudflared-windows-amd64.exe"
  $installId = "cloudflared-$CloudflaredVersion-windows-amd64-$($CloudflaredAmd64Hash.Substring(0, 12))"
  $installPath = Join-Path $RuntimeRoot $installId
  $binaryPath = Join-Path $installPath "cloudflared.exe"

  if (Test-Path -LiteralPath $installPath) {
    Assert-OrdinaryDirectory -LiteralPath $installPath
    if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
      throw "The installed Prostar cloudflared runtime is incomplete."
    }
    Assert-Sha256 -LiteralPath $binaryPath -Expected $CloudflaredAmd64Hash
  } else {
    $script:StagingPath = Join-Path $RuntimeRoot (".staging-cloudflared-" + [Guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $script:StagingPath)
    $completePath = Join-Path $script:StagingPath "complete"
    [void](New-Item -ItemType Directory -Path $completePath)
    $downloaded = Join-Path $completePath "cloudflared.exe"
    $url = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/$assetName"
    Invoke-Download -Uri ([Uri]$url) -Destination $downloaded
    Assert-Sha256 -LiteralPath $downloaded -Expected $CloudflaredAmd64Hash
    [IO.Directory]::Move($completePath, $installPath)
    Remove-Item -LiteralPath $script:StagingPath -Recurse -Force
    $script:StagingPath = $null
  }

  $versionText = ((& $binaryPath --version 2>&1) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch [Regex]::Escape("cloudflared version $CloudflaredVersion")) {
    throw "The private cloudflared runtime has the wrong version."
  }
  Write-AtomicText -LiteralPath (Join-Path $RuntimeRoot "cloudflared-current.txt") -Value $installId
}

try {
  Assert-OrdinaryDirectory -LiteralPath $AppRoot
  if (-not (Test-Path -LiteralPath $AppRoot)) {
    [void](New-Item -ItemType Directory -Path $AppRoot)
  }
  Protect-ProstarDirectory -LiteralPath $AppRoot
  Assert-OrdinaryDirectory -LiteralPath $RuntimeRoot
  if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    [void](New-Item -ItemType Directory -Path $RuntimeRoot)
  }
  [IO.File]::WriteAllText(
    (Join-Path $RuntimeRoot ".prostar-runtime"),
    "Prostar managed runtime" + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )

  $lockPath = Join-Path $RuntimeRoot ".install.lock"
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ($null -eq $LockStream) {
    try {
      $LockStream = New-Object IO.FileStream(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for another Prostar runtime installation."
      }
      Start-Sleep -Milliseconds 500
    }
  }

  $architecture = Get-NativeArchitecture
  Install-NodeRuntime -Architecture $architecture
  if ($WithCloudflared) {
    Install-CloudflaredRuntime
  }
} finally {
  if ($LockStream) {
    $LockStream.Dispose()
  }
  if ($StagingPath -and (Test-Path -LiteralPath $StagingPath)) {
    $runtimePrefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
    $fullStaging = [IO.Path]::GetFullPath($StagingPath)
    if ($fullStaging.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($fullStaging).StartsWith(".staging-")) {
      Remove-Item -LiteralPath $fullStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
