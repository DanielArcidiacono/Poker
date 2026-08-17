function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Build a command that behaves consistently in zsh, Bash, and Fish.
 *
 * The installer runs in its own Bash process. The final `exit` closes only the
 * shell where the user pasted the command, and only after a successful setup;
 * failures deliberately leave that shell open so the error and log path stay
 * visible.
 */
export function buildInstallCommand(installerUrl: string): string {
  const script = [
    "set -euo pipefail",
    'installer="$(/usr/bin/mktemp -t prostar-install.XXXXXX)"',
    "trap 'rm -f \"$installer\"' EXIT",
    // `-q` must be the first option so a user's ~/.curlrc cannot add verbose
    // output or otherwise change the production install request.
    '/usr/bin/curl -qfsSL "$1" -o "$installer"',
    '/bin/bash "$installer"',
  ].join("; ");

  return `/bin/bash -c ${shellQuote(script)} -- ${shellQuote(installerUrl)} && exit`;
}

/**
 * Build a pasteable Windows PowerShell command without interpolating the URL
 * into PowerShell source. EncodedCommand is UTF-16LE by PowerShell contract,
 * and keeps signed query strings safe from both Windows PowerShell 5.1 and
 * PowerShell 7 parsing differences.
 */
export function buildWindowsInstallCommand(installerUrl: string): string {
  const installerUrlBase64 = Buffer.from(installerUrl, "utf8").toString(
    "base64",
  );
  const script = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$installer = Join-Path ([IO.Path]::GetTempPath()) ("prostar-install-" + [Guid]::NewGuid().ToString("N") + ".ps1")
try {
  $url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${installerUrlBase64}"))
  $uri = $null
  if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) { throw "Invalid setup address." }
  $loopbackHttp = $uri.Scheme -eq "http" -and ($uri.Host -eq "127.0.0.1" -or $uri.Host -eq "localhost")
  if ($uri.Scheme -ne "https" -and -not $loopbackHttp) { throw "Setup requires HTTPS." }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $client = New-Object Net.WebClient
  if ($client.Proxy) { $client.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
  try { $client.DownloadFile($uri, $installer) } finally { $client.Dispose() }
  $windowsPowerShell = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer
  $status = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("Prostar installation failed before setup could start.")
  $status = 1
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
exit $status`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  // On success this closes the shell where the user pasted the command. A
  // failure leaves it open so the error and install-log path remain visible.
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}; if ($LASTEXITCODE -eq 0) { exit }`;
}

export function buildPlatformInstallCommands(opts: {
  macosInstallerUrl: string;
  windowsInstallerUrl: string;
}): { macCommand: string; windowsCommand: string } {
  return {
    macCommand: buildInstallCommand(opts.macosInstallerUrl),
    windowsCommand: buildWindowsInstallCommand(opts.windowsInstallerUrl),
  };
}
