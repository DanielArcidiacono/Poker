# Prostar dashboard

The dashboard is Prostar's authenticated control plane:

- `/` lists every currently active macOS or Windows Prostar client and its
  viewer count.
- `/install` creates an expiring, per-client, platform-specific production
  setup command.
- `/watch/[clientId]` lets the viewer's browser validate that client's current
  tunnel and opens its authenticated stream once Cloudflare is reachable.

Each device has independent **Go live**, **Watch**, and **Stop** controls.
**Stop** revokes the watch link and closes that client's tunnel; it does not
uninstall or disable the background agent.

## Local development

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. Development uses process memory when Redis is not
configured, so enrollments and control state disappear when the process
restarts.

## Production configuration

Deploy with `dashboard` as the project root and configure:

- `DASHBOARD_PASSWORD`: at least 12 characters; protects management,
  installer generation, and Watch.
- `PROSTAR_ENROLLMENT_SECRET`: 32–256 URL-safe characters; signs short-lived
  enrollment claims. Each device generates its own credential locally.
- Redis credentials are required in production so enrollment, desired state,
  and session data survive process or serverless restarts. Direct Upstash
  configuration uses `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN`. A Vercel Marketplace connection is detected
  automatically through its generated `UPSTASH_REDIS_REST_KV_REST_API_URL`
  and `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` variables.
- `NEXT_PUBLIC_APP_URL`: optional canonical dashboard origin.

The root enrollment secret is never copied to a client. Do not expose these
values through `NEXT_PUBLIC_*` variables.

## Build and publish

```bash
npm ci
npm run check
npm run build
```

The build creates these static files before Next.js compiles:

- `/prostar-agent.tgz`
- `/prostar-agent.tgz.sha256`

The generated macOS or Windows installer downloads both from the deployed
dashboard and verifies SHA-256 before extracting the archive. The setup command
first downloads its complete script to a temporary file and only then executes
it; the file is removed when the command exits. The archive contains both the
macOS `scripts/` and `launchd/` integration and the Windows `windows/`
integration.

For Vercel, use the included `vercel.json`, set the project root to `dashboard`,
enable **Include source files outside of the Root Directory in the Build Step**,
select Node.js 24.x, add the production variables above, and deploy normally.
The outside-root setting is required because the dashboard build packages the
cross-platform agent from root-level repository files.

## Production setup flow

1. Sign in to the deployed dashboard.
2. Choose **Set up device**, then select macOS or Windows.
3. Copy the generated command to Terminal on the target Mac or Windows
   PowerShell on the target PC. Use a normal, non-administrator shell.
4. Let Prostar install its checksum-verified private Node.js and cloudflared
   runtimes; no system Node.js, package manager, developer tools, or
   administrator access is required.
5. On macOS 15 or later, approve Screen Recording access if requested. Windows
   has no equivalent consent dialog, but its desktop must be unlocked.
6. Wait for the sole success line: `Prostar installed successfully.`
7. Return to the dashboard; the device appears under **Sessions** with its
   platform label.

Cloudflare Tunnel connects outbound. On Windows it uses HTTP/2/TCP, so Prostar
never needs a Windows Firewall exception or inbound access; if an older
installation causes Windows to ask about `cloudflared`, choose **Cancel** or
**Don't allow**.

Detailed setup output is stored at `~/Library/Logs/Prostar/install.log` on
macOS or `%LOCALAPPDATA%\Prostar\logs\install.log` on Windows. On failure, the
shell prints a concise message pointing there.

The setup command expires after ten minutes and identifies one new client. A
reinstall on a device already paired with this dashboard securely reuses that
device's existing scoped identity, so it does not create a duplicate session.
Anyone given an unexpired command can run it, so treat it as a short-lived
secret. There is intentionally no permanent anonymous backend-enrollment
command. Windows setup requires Windows PowerShell 5.1 and an unlocked Windows
10 version 1809 or later or Windows 11 interactive session. Organization-level
PowerShell policy can still block an otherwise supported install.

## Session persistence

Production Redis stores enrolled client credentials and control state. The
dashboard list itself contains active sessions only: clients disappear after
their heartbeat expires and reappear automatically when they reconnect. The
macOS LaunchAgent or Windows per-user Scheduled Task—not the dashboard page—
keeps each installed agent running through shell/browser closure and starts it
again after that user logs in following a restart. The Windows task runs in the
background without a Terminal or Command Prompt window. Neither platform
captures its sign-in screen; Windows capture also pauses while the interactive
desktop is locked.

## Verification

From the repository root:

```bash
npm ci
npm --prefix dashboard ci
npm test
npm run check
npm run build
npm --prefix dashboard run check
npm --prefix dashboard run build
```

The repository CI runs the same checks on macOS 15 and Windows Server 2022. It
also validates the platform-native service scripts, initializes the Windows C#
capture worker under Windows PowerShell 5.1, and downloads and verifies each
platform's private runtimes in an isolated temporary directory.
