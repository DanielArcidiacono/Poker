# Prostar dashboard

The dashboard is Prostar's authenticated control plane:

- `/` lists every currently active Prostar client and its viewer count.
- `/install` creates an expiring, per-client production setup command.
- `/watch/[clientId]` validates that client's current tunnel and opens its
  authenticated stream.

Each Mac has independent **Go live**, **Watch**, and **Stop** controls. **Stop**
revokes the watch link and closes that client's tunnel; it does not uninstall
or disable the background agent.

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
- `PROSTAR_ENROLLMENT_SECRET`: 32–256 URL-safe characters; signs enrollment
  claims and derives a separate scoped credential for each client.
- Redis credentials are required in production so enrollment, desired state,
  and session data survive process or serverless restarts. Direct Upstash
  configuration uses `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN`. A Vercel Marketplace connection is detected
  automatically through its generated `UPSTASH_REDIS_REST_KV_REST_API_URL`
  and `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` variables.
- `NEXT_PUBLIC_APP_URL`: optional canonical dashboard origin.
- `PROSTAR_BOOTSTRAP_VIEWER_PASSWORD`: optional 12–128 character URL-safe
  viewer password; otherwise each install receives a random password.

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

The generated Mac installer downloads both from the deployed dashboard and
verifies SHA-256 before extracting the archive. The setup command first
downloads its complete shell script to a temporary file and only then executes
it; the file is removed when the command exits.

For Vercel, use the included `vercel.json`, set the project root to `dashboard`,
enable **Include source files outside of the Root Directory in the Build Step**,
select Node.js 22.x, add the production variables above, and deploy normally.
The outside-root setting is required because the dashboard build packages the
Mac agent from root-level repository files.

## Production setup flow

1. Sign in to the deployed dashboard.
2. Choose **Set up Mac**.
3. Copy the generated command to Terminal on the target Mac.
4. Approve macOS Screen Recording access if requested.
5. Wait for the sole success line: `Prostar installed successfully.`
6. Return to the dashboard; the Mac appears under **Sessions**.

Detailed setup output is stored on the Mac at
`~/Library/Logs/Prostar/install.log`. On failure, Terminal prints a concise
message pointing there.

The setup command expires after ten minutes and identifies one client. Anyone
given an unexpired command can run it, so treat it as a short-lived secret.
There is intentionally no permanent anonymous backend-enrollment command.

## Session persistence

Production Redis stores enrolled client credentials and control state. The
dashboard list itself contains active sessions only: clients disappear after
their heartbeat expires and reappear automatically when they reconnect. The Mac
LaunchAgent, not the dashboard page, keeps each installed agent running through
Terminal/browser closure and starts it again after that user logs in following
a restart.

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
