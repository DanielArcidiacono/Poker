import { redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ error?: string }>;
};

async function streamIsReachable(publicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${publicUrl.replace(/\/$/, "")}/api/health`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export default async function WatchRoute({ searchParams }: Props) {
  const [{ error }, authed] = await Promise.all([
    searchParams,
    hasDashboardSession(),
  ]);

  if (!authed) {
    return (
      <main className="shell">
        <form className="card" method="post" action="/api/login">
          <h1>Watch</h1>
          <p className="muted">
            Enter the password to open the live stream.
          </p>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
          />
          <button type="submit">Watch</button>
          {error ? <p className="err">Incorrect password</p> : null}
        </form>
      </main>
    );
  }

  const store = getStore();
  const status = await store.getReport();
  const tunnelAgeMs = status.publicUrlUpdatedAt
    ? Date.now() - status.publicUrlUpdatedAt
    : Number.POSITIVE_INFINITY;
  const tunnelIsSettling = tunnelAgeMs < 20_000;

  if (status.recording && status.publicUrl && status.watchToken) {
    if (
      !tunnelIsSettling &&
      (await streamIsReachable(status.publicUrl))
    ) {
      const streamUrl = `${status.publicUrl.replace(/\/$/, "")}/embed?token=${encodeURIComponent(status.watchToken)}`;
      redirect(streamUrl);
    }

    // Quick-tunnel hostnames expire. Ask the live agent to replace the stale
    // URL; enqueue() de-duplicates repeated requests from the meta refresh.
    if (status.online && !tunnelIsSettling) {
      await store.enqueue({ type: "start_recording" });
    }
  }

  const hasStaleStream = Boolean(
    status.recording && status.publicUrl && status.watchToken,
  );
  const detail = !status.online
    ? "Mac agent is offline. Start sharing on the other Mac, then this page will open the stream."
    : tunnelIsSettling
      ? "Fresh Cloudflare link created. Waiting briefly for its DNS to become available…"
    : hasStaleStream
      ? "The previous Cloudflare link expired. Requesting a fresh link from the sharing Mac…"
      : status.message || "Waiting for the sharing Mac to publish its stream…";

  return (
    <main className="shell">
      <meta httpEquiv="refresh" content="2" />
      <div className="card">
        <h1>Watch</h1>
        <p className="muted">{detail}</p>
        <p className="muted" style={{ marginTop: 8 }}>
          Agent:{" "}
          <span className={status.online ? "ok" : "err"}>
            {status.online ? "online" : "offline"}
          </span>
          {status.hostname ? ` · ${status.hostname}` : ""}
          {status.recording ? " · recording" : " · not recording"}
        </p>
        <a className="button-link" href="/watch">
          Refresh now
        </a>
      </div>
    </main>
  );
}
