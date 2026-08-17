import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

const platformScripts = {
  admin: {
    darwin: "scripts/prostar-admin.sh",
    win32: "windows/prostar-admin.ps1",
  },
  install: {
    darwin: "scripts/install-agent.sh",
    win32: "windows/install-agent.ps1",
  },
  uninstall: {
    darwin: "scripts/uninstall-agent.sh",
    win32: "windows/uninstall-agent.ps1",
  },
};

export function resolvePlatformCommand(
  action,
  platform = process.platform,
  extraArguments = [],
) {
  const scripts = platformScripts[action];
  if (!scripts) {
    throw new Error(`Unknown Prostar command: ${action}`);
  }

  const script = scripts[platform];
  if (!script) {
    throw new Error(
      `Prostar ${action} supports macOS and Windows, not ${platform}.`,
    );
  }

  const scriptPath = resolve(repositoryRoot, script);
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...extraArguments,
      ],
    };
  }

  return {
    command: "/bin/bash",
    arguments: [scriptPath, ...extraArguments],
  };
}

function main() {
  const [action, ...extraArguments] = process.argv.slice(2);
  try {
    const invocation = resolvePlatformCommand(
      action,
      process.platform,
      extraArguments,
    );
    const result = spawnSync(invocation.command, invocation.arguments, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
