# Mac Screen Viewer

View-only live stream of your Mac screen in Safari on an iPad (or any browser), reachable from anywhere via Cloudflare Tunnel. Runs in the background and resumes after the Mac wakes from sleep.

## Features

- Password-protected web viewer (session cookie)
- JPEG WebSocket stream (~5–10 FPS, configurable)
- Localhost-only server + Cloudflare Tunnel for remote HTTPS
- LaunchAgent install so it starts at login with no visible window
- Wake recovery: re-inits capture and restarts `cloudflared` after sleep
- Optional **Vercel dashboard** that prompts you to start the Mac agent, then **Start recording** remotely

## Requirements

- macOS with Screen Recording permission for your Node binary
- Node.js 18+
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) for remote access

## Vercel dashboard (prompt + remote Start recording)

See [dashboard/README.md](dashboard/README.md).

- `/` — no password — one **Go live** button (prompts you to start the Mac agent if needed)
- `/watch` — password — stream only

1. Deploy `dashboard/` to Vercel (`DASHBOARD_PASSWORD`, `AGENT_TOKEN`, Upstash Redis)
2. On the Mac `.env`, set `CONTROL_PLANE_URL` and the same `AGENT_TOKEN`
3. Run `npm start` (or the background agent)
4. Open the site → **Go live** → then **/watch** to view

## Quick start (local)

```bash
cp .env.example .env
# edit .env — set VIEWER_PASSWORD

npm install
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787), enter the password.

On first capture, macOS will ask for **Screen Recording**. Allow it for the Node binary (e.g. `/usr/local/bin/node` or Homebrew’s node), then restart the server.

## Remote access (iPad anywhere)

### Option A — one-click from the local page (easiest)

1. `npm start` and open [http://127.0.0.1:8787](http://127.0.0.1:8787)
2. Click **Start recording**
3. Wait a few seconds for the public `https://….trycloudflare.com` link
4. Copy it (or open it) on your iPad / other Mac and log in

Click **Stop recording** when you’re done. Requires `cloudflared` on PATH (`brew install cloudflared`).

### Option B — quick tunnel in a second terminal

Terminal 1:

```bash
npm start
```

Terminal 2 (requires `cloudflared` on PATH):

```bash
npm run tunnel
```

Copy the printed `https://….trycloudflare.com` URL to your iPad.

### Option C — named tunnel (stable URL, recommended for background)

1. Create a tunnel in the Cloudflare Zero Trust dashboard and get a **tunnel token**.
2. Put it in `.env`:

```bash
CLOUDFLARED_TOKEN=eyJ...
```

3. Point the tunnel’s public hostname to `http://127.0.0.1:8787`.
4. Start the server (`npm start` or LaunchAgent). It will spawn `cloudflared` as a child and restart it after wake.

Alternatively set `CLOUDFLARED_CONFIG=/path/to/config.yml` instead of a token.

## Background at login

### From the browser (easiest)

1. On **this Mac**, start once: `npm start`
2. Open [http://127.0.0.1:8787](http://127.0.0.1:8787) and log in
3. Click **Install background service** and confirm

The page only shows that button when you open it locally (not through the public tunnel). After install, Terminal can close; the service keeps running.

### From the terminal

```bash
npm run install-agent
```

This writes `~/Library/LaunchAgents/com.local.screenviewer.plist` with `KeepAlive`, loads it, and starts the server. Logs:

`~/Library/Logs/screenviewer/`

After a restart, the service starts automatically when that macOS user logs
in. With `SHARE_ON_START=1`, it waits for the network, creates a new Cloudflare
quick tunnel, and publishes the replacement URL to the dashboard. If
`cloudflared` crashes later, it is restarted automatically.

Screen capture cannot run at the FileVault/login screen. Sharing resumes after
the user logs in and macOS restores that user's Screen Recording permission.

Remove with:

```bash
npm run uninstall-agent
```

Or use **Remove background service** in the local viewer UI.

For a stable remote URL while the agent runs, set `CLOUDFLARED_TOKEN` (or `CLOUDFLARED_CONFIG`) in `.env` before installing. Quick tunnels are a poor fit for LaunchAgent because the URL changes on every restart.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `VIEWER_PASSWORD` | _(required)_ | Login password |
| `PORT` | `8787` | Local listen port |
| `FPS` | `8` | Target frames per second |
| `JPEG_QUALITY` | `60` | JPEG quality 1–100 |
| `SCALE` | `0.5` | Downscale factor (bandwidth) |
| `DISPLAY_ID` | _(primary)_ | Display index from `screenshot-desktop` |
| `CLOUDFLARED_TOKEN` | | Named tunnel token |
| `CLOUDFLARED_CONFIG` | | Path to cloudflared config |
| `AUTO_TUNNEL` | `0` | If `1`, spawn a quick tunnel as a child |
| `SHARE_ON_START` | `0` | If `1`, go live after login/reboot and keep the tunnel alive |

## Wake behavior

While the Mac sleeps, streaming pauses. After wake, the capture loop detects a time gap, waits for network, restarts `cloudflared` if managed by the server, and continues sending frames. The iPad page reconnects with exponential backoff.

This does **not** wake a sleeping Mac from the iPad.

## Security notes

- The HTTP server binds to `127.0.0.1` only. Expose it through Cloudflare Tunnel (HTTPS), not raw port forwarding.
- Use a strong `VIEWER_PASSWORD`. Anyone with the URL and password can see your screen.
- View-only: there is no remote mouse/keyboard control.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Run the server |
| `npm run dev` | Run with reload |
| `npm run tunnel` | Quick Cloudflare tunnel to local port |
| `npm run install-agent` | Install/start LaunchAgent |
| `npm run uninstall-agent` | Remove LaunchAgent |
