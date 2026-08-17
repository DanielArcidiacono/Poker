import { notFound, redirect } from "next/navigation";
import { hasDashboardSession } from "@/lib/auth";
import { normalizeClientId } from "@/lib/client-id";
import { getStore } from "@/lib/store";
import { normalizeStreamUrl } from "@/lib/stream-url";
import { watchGenerationKey } from "@/lib/watch-generation";
import { WatchBridge } from "@/components/WatchBridge";
import { WatchWait } from "@/components/WatchWait";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ error?: string; ready?: string }>;
};

export default async function WatchRoute({ params, searchParams }: Props) {
  const clientId = normalizeClientId((await params).clientId);
  if (!clientId) notFound();
  const [{ error, ready }, authed] = await Promise.all([
    searchParams,
    hasDashboardSession(),
  ]);
  const watchPath = `/watch/${clientId}`;

  if (!authed) {
    return (
      <main className="shell">
        <form className="card" method="post" action="/api/login">
          <h1>Prostar</h1>
          <p className="muted">Enter the password to open this session.</p>
          <input type="hidden" name="next" value={watchPath} />
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
  const session = await store.getSession(clientId);
  const publicUrl = normalizeStreamUrl(session.publicUrl);
  if (
    session.online &&
    session.desiredSharing &&
    session.recording &&
    publicUrl &&
    session.watchToken
  ) {
    const generation = watchGenerationKey(publicUrl, session.watchToken);
    if (ready === generation) {
      redirect(
        `${publicUrl}/embed?token=${encodeURIComponent(session.watchToken)}`,
      );
    }
    return (
      <main className="shell">
        <WatchBridge
          publicUrl={publicUrl}
          readyPath={`${watchPath}?ready=${encodeURIComponent(generation)}`}
          sessionName={session.hostname || "Prostar"}
        />
      </main>
    );
  }

  const hasStaleStream = Boolean(
    session.recording && publicUrl && session.watchToken,
  );
  const detail = !session.online
    ? "This Prostar session is offline."
    : hasStaleStream
      ? "The previous private link expired. Restart it from the dashboard."
      : session.message || "Waiting for Prostar to publish the stream…";

  return (
    <main className="shell">
      <WatchWait
        actionPath={watchPath}
        detail={detail}
        sessionName={session.hostname || "Prostar"}
      />
    </main>
  );
}
