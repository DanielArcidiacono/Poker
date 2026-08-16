# Prostar

Prostar is a view-only Mac screen stream for Safari on an iPad or any modern
browser. The Mac agent stays idle until a viewer connects, serves bounded JPEG
frames over WebSocket, and uses a temporary Cloudflare Tunnel for remote
viewing. The protected dashboard lists every active Mac and provides independent
**Go live**, **Watch**, and **Stop** controls for each session.

## Requirements

- macOS 15 or later
- An internet connection during setup
- Screen Recording permission for the current capture helper

The setup command installs pinned, checksum-verified private copies of Node.js
and (for remote viewing) `cloudflared` inside Prostar's own Application Support
folder. A new user does not need Homebrew, Node.js, administrator access,
Command Line Tools, or a compiler.

## Production install

Deploy the dashboard, sign in, choose **Set up Mac**, and copy its generated
command. Run that command once in Terminal on the Mac being connected. It is an
expiring, per-client command; anyone given the unexpired command can run it, but
there is intentionally no anonymous universal backend-enrollment URL.

The command downloads the complete installer to a temporary file before
executing it. The installer then downloads `prostar-agent.tgz` and its SHA-256
file from the same dashboard, verifies it before extraction, and installs all
application dependencies. The only interactive step is Apple's required Screen
Recording approval on first use.

Successful production setup writes exactly one line to Terminal:

```text
Prostar installed successfully.
```

All setup detail goes to `~/Library/Logs/Prostar/install.log`. A failure prints
only a concise error pointing to that log and never prints success. macOS may
open Screen Recording settings during the first install; approve the displayed
helper and leave the command running until the success line appears. A
successful setup then closes that Terminal shell automatically; a failed setup
keeps it open so the error remains visible.

The installer creates a stable release link at
`~/Library/Application Support/Prostar/current` and installs the
`prostar-admin` command. It does not need to stay open after setup.

## Public local-only install

For a Mac that should be reachable only from itself, download the public
bootstrap script completely and then execute it:

```bash
(
  installer="$(/usr/bin/mktemp -t prostar-bootstrap.XXXXXX)" &&
  trap 'rm -f "$installer"' EXIT &&
  /usr/bin/curl -q --proto '=https' --tlsv1.2 -fsSL \
    'https://raw.githubusercontent.com/DanielArcidiacono/Poker/v1.1.0/scripts/bootstrap.sh' \
    -o "$installer" &&
  /bin/bash "$installer"
)
```

On success it prints only `Prostar installed successfully.` and installs the
same persistent background service and admin command. It sets `AUTO_TUNNEL=0`,
does not install or start Cloudflare, does not pair with a dashboard, and never
creates a public watch URL. It installs a private Node.js runtime and Prostar's
npm dependencies; afterward the agent listens only on loopback.

Retrieve the generated viewer password and open the local viewer with:

```bash
"$HOME/Library/Application Support/Prostar/prostar-admin" password
"$HOME/Library/Application Support/Prostar/prostar-admin" open
```

This public bootstrap is intentionally separate from production dashboard
pairing. It does not create a backend session; use the expiring command from
**Set up Mac** when the Mac must appear in the dashboard or be watched remotely.

## Admin controls

The production installer is deliberately quiet. Use the local admin command
when status, diagnostics, or service controls are needed:

```bash
PROSTAR_ADMIN="$HOME/Library/Application Support/Prostar/prostar-admin"
"$PROSTAR_ADMIN" help
"$PROSTAR_ADMIN" status
"$PROSTAR_ADMIN" start
"$PROSTAR_ADMIN" stop
"$PROSTAR_ADMIN" restart
"$PROSTAR_ADMIN" logs
"$PROSTAR_ADMIN" logs -f
"$PROSTAR_ADMIN" preflight
"$PROSTAR_ADMIN" open
"$PROSTAR_ADMIN" password
"$PROSTAR_ADMIN" uninstall
```

`status` shows the release, service health, local URL, dashboard pairing, and
log location. `preflight` takes one local test screenshot. `stop` disables the
background service; it is different from dashboard **Stop**, which only revokes
the public watch link and closes the tunnel. `password` prints the local viewer
password, so use it only in a private Terminal.

The Application Support path above works on a clean Mac without any shell
configuration. The command is also linked at `~/.local/bin/prostar-admin`; if
that directory is on `PATH`, the shorter `prostar-admin` form works too.

```bash
"$HOME/Library/Application Support/Prostar/prostar-admin" status
```

From a source checkout, the equivalent npm alias is:

```bash
npm run admin -- status
```

`prostar-admin uninstall` fully removes the background agent, Prostar's private
runtime, releases, credentials, and logs. For a dashboard-paired Mac, it first
revokes and removes the session from the dashboard. If the dashboard cannot be
reached or rejects the saved credential, it keeps the local data so the
revocation can be diagnosed or retried safely.
It also removes the known LaunchAgent and log files left by the former
ScreenViewer name without touching unrelated folders.

## Persistence and resource use

Prostar installs a per-user LaunchAgent named `prostar.agent` with `RunAtLoad`
and `KeepAlive`:

- Closing Terminal, the browser, or the dashboard does not stop the agent.
- If the worker exits unexpectedly, launchd restarts it.
- After a Mac restart, Prostar starts when the installing user logs in; it does
  not run at the FileVault or macOS login screen.
- Closing the last viewer stops screenshot work and releases frame buffers.
- Dashboard **Stop** closes the public tunnel but leaves the lightweight agent
  available for the next session.
- Only `prostar-admin stop` or `prostar-admin uninstall` disables background
  access.

While streaming, obsolete frames are dropped instead of queued, the browser
retains at most one pending frame, image processing is single-concurrency with
a small cache, and output is capped to 1920 pixels wide by default. The agent
binds only to `127.0.0.1`.

## Screen Recording permission

macOS requires Screen Recording approval even when Prostar takes individual
screenshots rather than recording a video. A normal application cannot silently
grant or suppress that permission. Production setup verifies one still image
and reports success only after capture works.

The current implementation calls the system `screencapture` tool from Node, so
macOS may identify Node or its launching context in Privacy & Security. Prostar
does not request Accessibility, Input Monitoring, microphone, or remote-control
permission. macOS may display its own capture reminders independently of
Prostar.

## Local-only test

This developer test runs in the foreground on loopback, takes one screenshot,
and never starts Cloudflare or contacts the dashboard:

```bash
npm ci
PROSTAR_VIEWER_PASSWORD='prostar-local-test-only' \
PROSTAR_AGENT_SECRET='prostar-local-agent-secret-only' \
CONTROL_PLANE_URL='' \
AUTO_TUNNEL=0 \
PORT=18789 \
npm start
```

In a second Terminal:

```bash
curl -fsS -o /dev/null \
  -X POST \
  -H 'Authorization: Bearer prostar-local-agent-secret-only' \
  http://127.0.0.1:18789/api/capture/preflight && \
echo 'Local screenshot succeeded.'
```

The endpoint returns no image data, and Prostar deletes its temporary JPEG.
Press Control-C in the first Terminal to stop the test. This flow does not
install a LaunchAgent. To exercise the viewer instead, open
<http://127.0.0.1:18789> and use `prostar-local-test-only`.

## Dashboard and distribution

The dashboard source and deployment instructions are in
[`dashboard/README.md`](dashboard/README.md). A production dashboard requires a
password, an enrollment secret, and persistent Redis storage. Its build creates
the agent archive and checksum once; the authenticated setup flow generates the
per-client command that retrieves them.

Each installed Mac receives a stable client ID and a scoped credential. A
reinstall from the same dashboard reuses that identity, so one Mac remains one
session even if its DNS hostname changes. The dashboard displays the macOS
Computer Name rather than a network-derived `.lan` or `.localdomain` name. The
root enrollment secret is never copied to a client. The dashboard shows only
currently active sessions; a client ages out of the list after its heartbeat
expires and returns automatically when it reconnects.

## Manual configuration

Source-tree and local installations use these variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROSTAR_VIEWER_PASSWORD` | required | Direct viewer password; 12+ characters |
| `PORT` | `8787` | Local agent port |
| `FPS` | `8` | Target capture rate while viewed |
| `JPEG_QUALITY` | `60` | JPEG quality from 1–100 |
| `SCALE` | `0.5` | Scale before the width cap |
| `MAX_WIDTH` | `1920` | Maximum encoded frame width |
| `DISPLAY_ID` | primary | Zero-based display index |
| `CONTROL_PLANE_URL` | none | Dashboard origin |
| `PROSTAR_CLIENT_ID` | generated | Stable dashboard session identity |
| `PROSTAR_AGENT_SECRET` | generated | Credential scoped to that session |
| `AGENT_TOKEN` | legacy only | Shared credential for older installations |
| `PROSTAR_CLOUDFLARED_BIN` | managed | Absolute private cloudflared executable |
| `AUTO_TUNNEL` | `0` | Start a quick tunnel without the dashboard |

## Security model

- Dashboard sign-in protects session management, Watch, and installer
  generation.
- Generated installer URLs expire after ten minutes.
- Scoped credentials prevent one client from claiming another client's
  session.
- Stream destinations are restricted to exact HTTPS Cloudflare quick-tunnel
  origins. Watch readiness is probed from the viewer's browser against the
  tunnel's existing stylesheet, so Vercel DNS cannot block a ready link.
- WebSocket access requires either a viewer session cookie or the current
  random watch token.
- The generated LaunchAgent currently contains its environment values, so its
  plist and `.env` are written with user-only permissions.

## Verification

```bash
npm ci
npm --prefix dashboard ci
npm test
npm run check
npm run build
npm --prefix dashboard run check
npm --prefix dashboard run build
```
