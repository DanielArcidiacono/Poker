import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlatformCommand } from "../scripts/run-platform-script.mjs";

test("npm lifecycle aliases dispatch to Bash on macOS", () => {
  const command = resolvePlatformCommand("admin", "darwin", ["status"]);
  assert.equal(command.command, "/bin/bash");
  assert.match(command.arguments[0], /scripts[\\/]prostar-admin\.sh$/);
  assert.deepEqual(command.arguments.slice(1), ["status"]);
});

test("npm lifecycle aliases dispatch to Windows PowerShell", () => {
  const command = resolvePlatformCommand("uninstall", "win32", ["-Purge"]);
  assert.equal(command.command, "powershell.exe");
  assert.deepEqual(command.arguments.slice(0, 5), [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.match(command.arguments[5], /windows[\\/]uninstall-agent\.ps1$/);
  assert.deepEqual(command.arguments.slice(6), ["-Purge"]);
});

test("npm lifecycle aliases reject unsupported systems and commands", () => {
  assert.throws(
    () => resolvePlatformCommand("admin", "linux"),
    /supports macOS and Windows/,
  );
  assert.throws(
    () => resolvePlatformCommand("unknown", "darwin"),
    /Unknown Prostar command/,
  );
});
