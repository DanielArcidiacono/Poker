[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ControlPlaneBase64,
  [Parameter(Mandatory = $true)][string]$ClientId,
  [Parameter(Mandatory = $true)][string]$InstallTokenBase64,
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$InstallLog
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "The Windows production installer can run only on Windows."
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Prostar requires Windows PowerShell 5.1 or later."
}
if ($ClientId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$") {
  throw "The Prostar setup client ID is invalid."
}

$utf8 = New-Object Text.UTF8Encoding($false)
$ControlPlane = $utf8.GetString([Convert]::FromBase64String($ControlPlaneBase64)).TrimEnd("/")
$InstallToken = $utf8.GetString([Convert]::FromBase64String($InstallTokenBase64))
$ControlPlaneUri = $null
if (-not [Uri]::TryCreate($ControlPlane, [UriKind]::Absolute, [ref]$ControlPlaneUri)) {
  throw "The Prostar dashboard address is invalid."
}
$loopbackHttp = $ControlPlaneUri.Scheme -eq "http" -and
  ($ControlPlaneUri.Host -eq "127.0.0.1" -or $ControlPlaneUri.Host -eq "localhost")
if ($ControlPlaneUri.Scheme -ne "https" -and -not $loopbackHttp) {
  throw "Production setup requires HTTPS, except for a loopback dashboard."
}
if ($ControlPlaneUri.AbsolutePath -ne "/" -or
    -not [string]::IsNullOrWhiteSpace($ControlPlaneUri.Query) -or
    -not [string]::IsNullOrWhiteSpace($ControlPlaneUri.Fragment)) {
  throw "The Prostar dashboard address must be an origin."
}

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$AppRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData "Prostar"))
$ReleasesRoot = Join-Path $AppRoot "releases"
$RuntimeRoot = Join-Path $AppRoot "runtime"
$CurrentPointer = Join-Path $AppRoot "current.txt"
$PendingIdentity = Join-Path $AppRoot ".pending-enrollment"
$PendingInstall = Join-Path $AppRoot ".install-pending.json"
$ReleasePath = $null
$PreviousReleaseId = $null
$EnrolledNewIdentity = $false
$HandoffStarted = $false
$KeepRelease = $false
$InstallSucceeded = $false
$AgentSecret = ""
$ViewerPassword = ""
$LastLocalStatusError = ""

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

function Protect-ProstarDirectory {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidText in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sidText)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  # Set-Acl asks the Windows PowerShell filesystem provider to persist the
  # complete descriptor, including the SACL. Ordinary users do not have the
  # SeSecurityPrivilege required for SACL access. DirectoryInfo persists only
  # the DACL section modified above, which is all this per-user install needs.
  (Get-Item -LiteralPath $LiteralPath -Force).SetAccessControl($acl)
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

function Write-AtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $parent = Split-Path -Parent $LiteralPath
  $temporary = Join-Path $parent (".write-" + [Guid]::NewGuid().ToString("N"))
  try {
    [IO.File]::WriteAllText($temporary, $Value + [Environment]::NewLine, $utf8)
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

function Get-SecretHash {
  param([Parameter(Mandatory = $true)][string]$Secret)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($utf8.GetBytes($Secret))
  } finally {
    $sha.Dispose()
  }
  return -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Invoke-ProstarHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Bearer = "",
    [string]$JsonBody = "",
    [int]$TimeoutMilliseconds = 15000
  )
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $uri = [Uri]::new($ControlPlaneUri, $Path)
  $request = [Net.HttpWebRequest]::Create($uri)
  $request.Method = $Method
  $request.Timeout = $TimeoutMilliseconds
  $request.ReadWriteTimeout = $TimeoutMilliseconds
  $request.AllowAutoRedirect = $false
  $request.UserAgent = "Prostar-Windows-Installer/1.2.3"
  if (-not [string]::IsNullOrWhiteSpace($Bearer)) {
    $request.Headers["Authorization"] = "Bearer $Bearer"
  }
  if (-not [string]::IsNullOrWhiteSpace($JsonBody)) {
    $request.ContentType = "application/json"
    $body = $utf8.GetBytes($JsonBody)
    $request.ContentLength = $body.Length
    try {
      $stream = $request.GetRequestStream()
      try {
        $stream.Write($body, 0, $body.Length)
      } finally {
        $stream.Dispose()
      }
    } catch {
      return 0
    }
  }
  try {
    $response = $request.GetResponse()
    try {
      return [int]$response.StatusCode
    } finally {
      $response.Dispose()
    }
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      try {
        return [int]$_.Exception.Response.StatusCode
      } finally {
        $_.Exception.Response.Dispose()
      }
    }
    return 0
  }
}

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Request,
    [Parameter(Mandatory = $true)][int[]]$TerminalStatuses
  )
  $status = 0
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $status = & $Request
    if ($TerminalStatuses -contains $status) {
      return $status
    }
    Start-Sleep -Seconds 1
  }
  return $status
}

function Write-PendingIdentity {
  $contents = @(
    "CONTROL_PLANE_URL=$ControlPlane",
    "PROSTAR_CLIENT_ID=$ClientId",
    "PROSTAR_AGENT_SECRET=$AgentSecret"
  ) -join [Environment]::NewLine
  Write-AtomicText -LiteralPath $PendingIdentity -Value $contents
}

function Remove-PendingEnrollment {
  if (-not (Test-Path -LiteralPath $PendingIdentity -PathType Leaf)) {
    return
  }
  if (Test-ReparsePoint -LiteralPath $PendingIdentity) {
    throw "The previous Prostar enrollment state is unsafe."
  }
  $pendingControlPlane = Get-EnvValueFromFile -FilePath $PendingIdentity -Key "CONTROL_PLANE_URL"
  $pendingClientId = Get-EnvValueFromFile -FilePath $PendingIdentity -Key "PROSTAR_CLIENT_ID"
  $pendingSecret = Get-EnvValueFromFile -FilePath $PendingIdentity -Key "PROSTAR_AGENT_SECRET"
  if (-not $pendingControlPlane.TrimEnd("/").Equals($ControlPlane, [StringComparison]::OrdinalIgnoreCase) -or
      $pendingClientId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" -or
      $pendingSecret -notmatch "^[A-Za-z0-9_-]{32,256}$") {
    throw "A previous Prostar enrollment needs manual recovery."
  }
  $body = @{ clientId = $pendingClientId } | ConvertTo-Json -Compress
  $status = Invoke-WithRetry -TerminalStatuses @(204, 401) -Request {
    Invoke-ProstarHttp -Method "DELETE" -Path "/api/agent/deenroll" -Bearer $pendingSecret -JsonBody $body
  }
  if ($status -ne 204) {
    throw "Could not finish cleanup from the previous setup (HTTP $(if ($status) { $status } else { 'unreachable' }))."
  }
  Remove-Item -LiteralPath $PendingIdentity -Force
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
  $nativeOutputPath = Join-Path (Split-Path -Parent $InstallLog) (
    ".native-output-" + [Guid]::NewGuid().ToString("N") + ".tmp"
  )
  Push-Location -LiteralPath $WorkingDirectory
  try {
    # Windows PowerShell 5.1 promotes redirected native stderr to its Error
    # stream. With ErrorActionPreference=Stop, a harmless npm warning can
    # otherwise terminate a command that ultimately exits successfully. It
    # also fails to propagate LASTEXITCODE when the native command is upstream
    # in a pipeline. Redirect the command directly, capture its exit code before
    # running another command, then transcode PowerShell's temporary output to
    # the install log's UTF-8 encoding.
    $ErrorActionPreference = "Continue"
    # LASTEXITCODE is an automatic variable created in global scope. Assigning
    # it without a scope modifier inside this function would create a local
    # shadow that the native process cannot update on Windows PowerShell 5.1.
    $global:LASTEXITCODE = 1
    & $FilePath @Arguments *> $nativeOutputPath
    $exitCode = $global:LASTEXITCODE
    if (Test-Path -LiteralPath $nativeOutputPath -PathType Leaf) {
      $nativeOutput = [IO.File]::ReadAllText($nativeOutputPath)
      if ($nativeOutput.Length -gt 0) {
        [IO.File]::AppendAllText($InstallLog, $nativeOutput, $utf8)
      }
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Remove-Item -LiteralPath $nativeOutputPath -Force -ErrorAction SilentlyContinue
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Description failed with exit code $exitCode."
  }
}

function Invoke-AgentInstaller {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments)
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $scriptPath = Join-Path $ReleasePath "windows\install-agent.ps1"
  $allArguments = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $scriptPath
  ) + $Arguments
  Invoke-LoggedNative -FilePath $powerShell -Arguments $allArguments -WorkingDirectory $ReleasePath -Description "Windows background-task installation"
}

function Wait-LocalStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Method = "GET",
    [string]$Bearer = "",
    [int]$ExpectedStatus = 204,
    [int]$Attempts = 20
  )
  $script:LastLocalStatusError = ""
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:8787$Path")
    $request.Method = $Method
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $request.AllowAutoRedirect = $false
    if (-not [string]::IsNullOrWhiteSpace($Bearer)) {
      $request.Headers["Authorization"] = "Bearer $Bearer"
    }
    try {
      $response = $request.GetResponse()
      try {
        if ([int]$response.StatusCode -eq $ExpectedStatus) {
          return $true
        }
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
                $parsed = $body | ConvertFrom-Json
                $detail = [string]$parsed.error
              } catch {
                $detail = $body
              }
              $detail = ($detail -replace "[\r\n]+", " ").Trim()
              if ($detail.Length -gt 500) {
                $detail = $detail.Substring(0, 500)
              }
              $script:LastLocalStatusError = $detail
            }
          } finally {
            $reader.Dispose()
          }
        } finally {
          $errorResponse.Dispose()
        }
      }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Invoke-FailureCleanup {
  if ($HandoffStarted -and $ReleasePath -and
      (Test-Path -LiteralPath (Join-Path $AppRoot ".install-pending.json") -PathType Leaf)) {
    try {
      Invoke-AgentInstaller -Arguments @("-RollbackInstall")
    } catch {
      $script:KeepRelease = $true
      Write-InstallLog "Rollback failed: $($_.Exception.Message)"
    }
  }

  if ($EnrolledNewIdentity) {
    $body = @{ clientId = $ClientId } | ConvertTo-Json -Compress
    $status = Invoke-WithRetry -TerminalStatuses @(204, 401) -Request {
      Invoke-ProstarHttp -Method "DELETE" -Path "/api/agent/deenroll" -Bearer $AgentSecret -JsonBody $body
    }
    if ($status -eq 204) {
      Remove-Item -LiteralPath $PendingIdentity -Force -ErrorAction SilentlyContinue
    } else {
      $script:KeepRelease = $true
      Write-InstallLog "Enrollment cleanup was ambiguous (HTTP $(if ($status) { $status } else { 'unreachable' }))."
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
  if ((Test-ReparsePoint -LiteralPath $AppRoot) -or
      (Test-ReparsePoint -LiteralPath $ReleasesRoot) -or
      (Test-ReparsePoint -LiteralPath $SourceRoot)) {
    throw "Prostar installation paths must be ordinary directories."
  }
  [void](New-Item -ItemType Directory -Path $AppRoot -Force)
  Protect-ProstarDirectory -LiteralPath $AppRoot
  [void](New-Item -ItemType Directory -Path $ReleasesRoot -Force)

  if (Test-Path -LiteralPath $PendingInstall -PathType Leaf) {
    $interruptedReleaseId = Get-CurrentReleaseId
    $interruptedRelease = Get-ReleasePath -ReleaseId $interruptedReleaseId
    $recoveryRelease = if ($interruptedRelease -and
        (Test-Path -LiteralPath (Join-Path $interruptedRelease "windows\install-agent.ps1") -PathType Leaf)) {
      $interruptedRelease
    } elseif (Test-Path -LiteralPath (Join-Path $SourceRoot "windows\install-agent.ps1") -PathType Leaf) {
      # A clean first install can lose power after writing the rollback marker
      # but before current.txt. The newly verified bundle is an independent,
      # trusted copy of the same recovery helper.
      $SourceRoot
    } else {
      $null
    }
    if (-not $recoveryRelease) {
      throw "A previous Prostar upgrade needs manual recovery."
    }
    $ReleasePath = $recoveryRelease
    Invoke-AgentInstaller -Arguments @("-RollbackInstall")
    $ReleasePath = $null
  }

  Write-InstallLog "Phase: validating dashboard enrollment."
  Remove-PendingEnrollment
  $dashboardStatus = Invoke-ProstarHttp -Method "GET" -Path "/"
  if ($dashboardStatus -ne 200) {
    throw "The Prostar dashboard is unavailable."
  }

  $PreviousReleaseId = Get-CurrentReleaseId
  $previousRelease = Get-ReleasePath -ReleaseId $PreviousReleaseId
  $previousEnv = if ($previousRelease) { Join-Path $previousRelease ".env" } else { $null }

  $ViewerPassword = New-Secret -ByteCount 24
  $reuseIdentity = $false
  if ($previousEnv -and (Test-Path -LiteralPath $previousEnv -PathType Leaf)) {
    $existingControlPlane = Get-EnvValueFromFile -FilePath $previousEnv -Key "CONTROL_PLANE_URL"
    $existingClientId = Get-EnvValueFromFile -FilePath $previousEnv -Key "PROSTAR_CLIENT_ID"
    $existingSecret = Get-EnvValueFromFile -FilePath $previousEnv -Key "PROSTAR_AGENT_SECRET"
    $existingPassword = Get-EnvValueFromFile -FilePath $previousEnv -Key "PROSTAR_VIEWER_PASSWORD"
    if ($existingControlPlane.TrimEnd("/").Equals($ControlPlane, [StringComparison]::OrdinalIgnoreCase) -and
        $existingClientId -match "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" -and
        $existingSecret -match "^[A-Za-z0-9_-]{32,256}$") {
      $verifyBody = @{ clientId = $existingClientId } | ConvertTo-Json -Compress
      $verifyStatus = Invoke-ProstarHttp -Method "POST" -Path "/api/agent/verify" -Bearer $existingSecret -JsonBody $verifyBody
      if ($verifyStatus -eq 204) {
        $ClientId = $existingClientId
        $AgentSecret = $existingSecret
        $reuseIdentity = $true
        if ($existingPassword -match "^[A-Za-z0-9_-]{12,128}$") {
          $ViewerPassword = $existingPassword
        }
      } elseif ($verifyStatus -ne 401) {
        throw "Could not verify the existing Prostar identity."
      }
    }
  }

  if (-not $reuseIdentity) {
    $AgentSecret = New-Secret -ByteCount 32
    $credentialHash = Get-SecretHash -Secret $AgentSecret
    $enrollBody = @{
      token = $InstallToken
      credentialHash = $credentialHash
    } | ConvertTo-Json -Compress
    $enrollStatus = Invoke-WithRetry -TerminalStatuses @(204, 409) -Request {
      Invoke-ProstarHttp -Method "POST" -Path "/api/agent/enroll" -JsonBody $enrollBody
    }
    if ($enrollStatus -ne 204) {
      throw "Could not enroll this Windows PC with Prostar."
    }
    $EnrolledNewIdentity = $true
    Write-PendingIdentity
  }

  $releaseId = [DateTime]::UtcNow.ToString("yyyyMMddHHmmss") + "-" + [Guid]::NewGuid().ToString("N")
  $ReleasePath = Join-Path $ReleasesRoot $releaseId
  if (Test-Path -LiteralPath $ReleasePath) {
    throw "The new Prostar release path already exists."
  }
  [IO.Directory]::Move([IO.Path]::GetFullPath($SourceRoot), $ReleasePath)
  if (-not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\ensure-runtime.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\install-agent.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\cleanup-orphans.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "windows\uninstall-agent.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $ReleasePath "src\server.ts") -PathType Leaf)) {
    throw "The downloaded Prostar package is incomplete."
  }

  Write-InstallLog "Phase: installing private runtimes."
  $ensureRuntime = Join-Path $ReleasePath "windows\ensure-runtime.ps1"
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $previousAppRootOverride = [string]$env:PROSTAR_APP_ROOT
  try {
    # The production layout is fixed. Do not let an unrelated user or CI
    # environment override send the runtime to a different directory.
    $env:PROSTAR_APP_ROOT = $AppRoot
    Invoke-LoggedNative -FilePath $powerShell -Arguments @(
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", $ensureRuntime, "-WithCloudflared"
    ) -WorkingDirectory $ReleasePath -Description "Private runtime installation"
  } finally {
    if ([string]::IsNullOrEmpty($previousAppRootOverride)) {
      Remove-Item Env:PROSTAR_APP_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:PROSTAR_APP_ROOT = $previousAppRootOverride
    }
  }

  $nodeId = ([IO.File]::ReadAllText((Join-Path $RuntimeRoot "node-current.txt"))).Trim()
  $cloudflaredId = ([IO.File]::ReadAllText((Join-Path $RuntimeRoot "cloudflared-current.txt"))).Trim()
  if ($nodeId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" -or
      $cloudflaredId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "The private runtime pointers are invalid."
  }
  $nodeRuntimePath = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot $nodeId))
  $runtimePrefix = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd("\") + "\"
  if (-not $nodeRuntimePath.StartsWith(
      $runtimePrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
      -not (Test-Path -LiteralPath $nodeRuntimePath -PathType Container) -or
      (Test-ReparsePoint -LiteralPath $nodeRuntimePath)) {
    throw "The private Node.js runtime path is invalid."
  }
  $nodePath = Join-Path $nodeRuntimePath "node.exe"
  $npmPath = Join-Path $nodeRuntimePath "npm.cmd"
  $cloudflaredPath = Join-Path (Join-Path $RuntimeRoot $cloudflaredId) "cloudflared.exe"
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $npmPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
    throw "The private Prostar runtime is incomplete."
  }

  $envContents = @(
    "PROSTAR_VIEWER_PASSWORD=$ViewerPassword",
    "CONTROL_PLANE_URL=$ControlPlane",
    "PROSTAR_CLIENT_ID=$ClientId",
    "PROSTAR_AGENT_SECRET=$AgentSecret",
    "PROSTAR_CLOUDFLARED_BIN=$cloudflaredPath",
    "PORT=8787",
    "FPS=8",
    "JPEG_QUALITY=60",
    "SCALE=0.5",
    "MAX_WIDTH=1920"
  ) -join [Environment]::NewLine
  [IO.File]::WriteAllText((Join-Path $ReleasePath ".env"), $envContents + [Environment]::NewLine, $utf8)

  Write-InstallLog "Phase: installing and building the agent."
  $env:npm_config_cache = Join-Path $RuntimeRoot "npm-cache"
  $env:npm_config_update_notifier = "false"
  [void](New-Item -ItemType Directory -Path $env:npm_config_cache -Force)
  $previousProcessPath = [Environment]::GetEnvironmentVariable(
    "Path",
    [EnvironmentVariableTarget]::Process
  )
  try {
    # npm.cmd starts with its sibling node.exe, but dependency lifecycle scripts
    # invoke `node` by name. A clean PC has no machine Node.js installation, so
    # expose only Prostar's verified runtime to these child processes.
    $env:Path = if ([string]::IsNullOrEmpty($previousProcessPath)) {
      $nodeRuntimePath
    } else {
      $nodeRuntimePath + [IO.Path]::PathSeparator + $previousProcessPath
    }
    Invoke-LoggedNative -FilePath $npmPath -Arguments @(
      "ci", "--include=dev", "--include=optional", "--ignore-scripts=false",
      "--foreground-scripts", "--no-audit", "--no-fund"
    ) -WorkingDirectory $ReleasePath -Description "Dependency installation"
    Invoke-LoggedNative -FilePath $npmPath -Arguments @(
      "run", "build", "--silent"
    ) -WorkingDirectory $ReleasePath -Description "Agent build"
  } finally {
    [Environment]::SetEnvironmentVariable(
      "Path",
      $previousProcessPath,
      [EnvironmentVariableTarget]::Process
    )
  }

  Write-InstallLog "Phase: starting the background task."
  Invoke-AgentInstaller -Arguments @()
  $HandoffStarted = $true

  Write-InstallLog "Phase: verifying local health and dashboard pairing."
  if (-not (Wait-LocalStatus -Path "/api/health" -ExpectedStatus 200 -Attempts 20)) {
    throw "The local Prostar agent did not become healthy."
  }
  if (-not (Wait-LocalStatus -Path "/api/control-plane/health" -Bearer $AgentSecret -ExpectedStatus 204 -Attempts 100)) {
    $detail = if ([string]::IsNullOrWhiteSpace($LastLocalStatusError)) {
      ""
    } else {
      " ($LastLocalStatusError)"
    }
    throw "The Windows agent could not acquire its dashboard session$detail."
  }
  Write-InstallLog "Phase: verifying Windows screen capture."
  if (-not (Wait-LocalStatus -Path "/api/capture/preflight" -Method "POST" -Bearer $AgentSecret -ExpectedStatus 204 -Attempts 3)) {
    $detail = if ([string]::IsNullOrWhiteSpace($LastLocalStatusError)) {
      ""
    } else {
      " ($LastLocalStatusError)"
    }
    throw "Windows screen capture is unavailable in the current user session$detail."
  }

  if ($EnrolledNewIdentity) {
    $activateBody = @{ clientId = $ClientId } | ConvertTo-Json -Compress
    $activateStatus = Invoke-WithRetry -TerminalStatuses @(204, 409) -Request {
      Invoke-ProstarHttp -Method "POST" -Path "/api/agent/activate" -Bearer $AgentSecret -JsonBody $activateBody
    }
    if ($activateStatus -ne 204) {
      throw "Could not finish pairing this Windows PC."
    }
  }

  Invoke-AgentInstaller -Arguments @("-FinalizeInstall")
  Remove-Item -LiteralPath $PendingIdentity -Force -ErrorAction SilentlyContinue
  $InstallSucceeded = $true
  Write-InstallLog "Prostar Windows installation completed successfully."
} catch {
  Write-InstallLog ("Installation failed: " + $_.Exception.ToString())
  Invoke-FailureCleanup
  throw
} finally {
  $InstallToken = ""
  $AgentSecret = ""
  $ViewerPassword = ""
}
