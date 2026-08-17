import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("LaunchAgent renderer treats env values as XML data", async () => {
  const root = await mkdtemp(join(tmpdir(), "prostar-render-"));
  const destination = join(root, "agent.plist");
  const template = resolve("launchd/prostar.agent.plist");
  const renderer = resolve("scripts/render-launch-agent.mjs");

  try {
    await writeFile(
      join(root, ".env"),
      [
        `PROSTAR_VIEWER_PASSWORD=alpha&bravo|<charlie>\"'`,
        "PROSTAR_CLIENT_ID=11111111-1111-4111-8111-111111111111",
        "PROSTAR_AGENT_SECRET=token&with|xml<characters>",
        "CONTROL_PLANE_URL=https://dashboard.example/?a=1&b=2",
      ].join("\n"),
    );
    await execFileAsync(process.execPath, [
      renderer,
      root,
      "/path/with &/node",
      "/path/with |/server.js",
      template,
      destination,
      "/tmp/logs & diagnostics",
    ]);

    const output = await readFile(destination, "utf8");
    assert.match(output, /alpha&amp;bravo\|&lt;charlie&gt;&quot;&apos;/);
    assert.match(output, /token&amp;with\|xml&lt;characters&gt;/);
    assert.match(output, /PROSTAR_CLOUDFLARED_BIN/);
    assert.match(output, /\/path\/with &amp;\/cloudflared/);
    assert.doesNotMatch(output, /homebrew/);
    assert.equal(output.includes("__PROSTAR_VIEWER_PASSWORD__"), false);
    // POSIX mode bits are meaningful on macOS, where this plist and its
    // embedded credentials are installed. Windows reports synthetic mode
    // bits for every file, so keep exercising XML rendering there without
    // pretending that chmod semantics apply.
    if (process.platform !== "win32") {
      assert.equal((await stat(destination)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
