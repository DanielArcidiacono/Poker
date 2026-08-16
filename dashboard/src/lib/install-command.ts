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
