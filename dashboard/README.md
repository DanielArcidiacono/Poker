# Screen Viewer Dashboard (Vercel / LAN)

Two pages:

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | None | **Go live** — starts stream, or downloads a one-click Mac installer if no agent is paired |
| `/watch` | Password | Stream only |

## Go live behavior

1. If an agent is already online → start recording  
2. If an agent is running on this Mac (`127.0.0.1:8787`) → install/start background service, then go live  
3. Otherwise → download **Install Screen Viewer.command** (open it once; Right-click → Open if macOS blocks it). The page waits until the agent connects, then finishes Go live automatically  

The installer clones the repo if needed, writes `.env` pairing values, runs `npm install`, and `npm run install-agent`.

## Local development

```bash
cd dashboard
cp .env.example .env.local
# set DASHBOARD_PASSWORD and AGENT_TOKEN
npm install
npm run dev
```

LAN access from another computer:

```bash
npm run dev
# open http://YOUR_LAN_IP:3000 on the other device
```

## Deploy to Vercel

1. Root Directory: `dashboard`
2. Env: `DASHBOARD_PASSWORD`, `AGENT_TOKEN`, Upstash Redis, optional `NEXT_PUBLIC_GIT_REPO`
