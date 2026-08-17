import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildInstallCommand,
  buildPlatformInstallCommands,
  buildWindowsInstallCommand,
} from "../src/lib/install-command";

test("setup command uses Bash and closes its shell only after success", () => {
  const command = buildInstallCommand(
    "https://dashboard.example/api/install-agent/raw?token=test-token",
  );

  const parsed = spawnSync("bash", ["-n"], {
    input: command,
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(command, /^\/bin\/bash -c /);
  assert.match(command, /\/usr\/bin\/curl -qfsSL/);
  assert.match(command, /&& exit$/);
  assert.doesNotMatch(command, /curl[^;]*\|[^;]*bash/);
});

test("setup command safely quotes an installer URL", () => {
  const command = buildInstallCommand("https://example.test/a'b?token=ok");
  const parsed = spawnSync("bash", ["-n"], {
    input: command,
    encoding: "utf8",
  });

  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(command, /a'"'"'b/);
});

test("setup command exits its shell on success and leaves it open on failure", (t) => {
  if (!existsSync("/usr/bin/curl")) {
    t.skip("requires the macOS curl path used by the production command");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "prostar-command-test-"));
  try {
    const successInstaller = join(directory, "success.sh");
    const failureInstaller = join(directory, "failure.sh");
    writeFileSync(successInstaller, "#!/bin/bash\nprintf 'installed\\n'\n");
    writeFileSync(failureInstaller, "#!/bin/bash\nexit 17\n");

    const success = spawnSync(
      "bash",
      [
        "-c",
        `${buildInstallCommand(pathToFileURL(successInstaller).href)}; printf 'shell-remained-open\\n'`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, "installed\n");

    const failure = spawnSync(
      "bash",
      [
        "-c",
        `${buildInstallCommand(pathToFileURL(failureInstaller).href)}; printf 'shell-remained-open\\n'`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(failure.status, 0, failure.stderr);
    assert.equal(failure.stdout, "shell-remained-open\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows setup command is EncodedCommand-safe and closes only on success", () => {
  const installerUrl =
    "https://dashboard.example/api/install-agent/raw?token=one%26two&platform=windows";
  const command = buildWindowsInstallCommand(installerUrl);
  const match = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+);/);
  assert.ok(match);
  const script = Buffer.from(match[1], "base64").toString("utf16le");

  assert.match(command, /^powershell\.exe /);
  assert.match(command, /; if \(\$LASTEXITCODE -eq 0\) \{ exit \}$/);
  assert.match(script, /Net\.WebClient/);
  assert.match(script, /ExecutionPolicy Bypass -File \$installer/);
  assert.match(script, /Remove-Item -LiteralPath \$installer/);
  assert.equal(script.includes(installerUrl), false);
  assert.equal(
    script.includes(Buffer.from(installerUrl).toString("base64")),
    true,
  );
  assert.doesNotMatch(command, /Invoke-Expression|\biex\b/i);
});

test("platform setup helper exposes stable client prop names", () => {
  const commands = buildPlatformInstallCommands({
    macosInstallerUrl: "https://dashboard.example/mac",
    windowsInstallerUrl: "https://dashboard.example/windows",
  });
  assert.deepEqual(Object.keys(commands), ["macCommand", "windowsCommand"]);
  assert.equal(commands.macCommand, buildInstallCommand("https://dashboard.example/mac"));
  assert.equal(
    commands.windowsCommand,
    buildWindowsInstallCommand("https://dashboard.example/windows"),
  );
});
