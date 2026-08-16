"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  SessionState,
  SessionSummary,
} from "@/lib/session-summary";

const POLL_MS = 5_000;

const labels: Record<SessionState, string> = {
  ready: "Ready",
  starting: "Starting",
  error: "Couldn't start",
  link_ready: "Link ready",
  watching: "Watching",
  stopping: "Stopping",
};

function relativeLastSeen(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return "Seen now";
  if (seconds < 60) return `Seen ${seconds}s ago`;
  return `Seen ${Math.round(seconds / 60)}m ago`;
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const duplicateNames = new Set(
    (sessions ?? [])
      .map((session) => session.name)
      .filter(
        (name, index, names) =>
          names.indexOf(name) !== index || names.lastIndexOf(name) !== index,
      ),
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/");
        return;
      }
      if (!response.ok) throw new Error("Could not load sessions");
      const data = (await response.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
      setRefreshError(null);
    } catch {
      setRefreshError("Could not refresh sessions. Retrying…");
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function poll() {
      if (document.visibilityState === "visible") await refresh();
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void refresh();
    }

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  async function setSharing(session: SessionSummary, desired: boolean) {
    setPending((current) => new Set(current).add(session.id));
    setActionErrors((current) => {
      const next = new Map(current);
      next.delete(session.id);
      return next;
    });
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(session.id)}/sharing`,
        { method: desired ? "POST" : "DELETE" },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Action failed");
      await refresh();
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Could not update session";
      setActionErrors((current) =>
        new Map(current).set(session.id, `${session.name}: ${message}`),
      );
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Remote screen access</p>
          <h1>Prostar</h1>
        </div>
        <form method="post" action="/api/logout">
          <button className="text-button" type="submit">
            Sign out
          </button>
        </form>
      </header>

      <section className="sessions-panel" aria-labelledby="sessions-title">
        <div className="sessions-heading">
          <div>
            <h2 id="sessions-title">Sessions</h2>
            <p className="session-count" aria-live="polite">
              {sessions === null
                ? "Checking…"
                : `${sessions.length} connected`}
            </p>
          </div>
          <a className="button-link secondary-button" href="/install">
            Set up Mac
          </a>
        </div>

        {refreshError ? (
          <p className="sessions-error" role="alert">
            {refreshError}
          </p>
        ) : null}

        {sessions === null ? (
          <div className="sessions-empty">Looking for Prostar sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="sessions-empty">
            <h3>No active sessions</h3>
            <p>Install Prostar on a Mac to make it available here.</p>
            <a className="button-link" href="/install">
              Set up Prostar
            </a>
          </div>
        ) : (
          <div className="session-list">
            {sessions.map((session) => {
              const isPending = pending.has(session.id);
              const displayName = duplicateNames.has(session.name)
                ? `${session.name} · ${session.id.slice(0, 8)}`
                : session.name;
              const titleId = `session-${session.id}`;
              const isSharing =
                session.state === "starting" ||
                session.state === "error" ||
                session.state === "link_ready" ||
                session.state === "watching";
              return (
                <article
                  className="session-row"
                  key={session.id}
                  aria-labelledby={titleId}
                >
                  <div className="session-identity">
                    <div className="session-title" id={titleId}>
                      <strong>{session.name}</strong>
                      {duplicateNames.has(session.name) ? (
                        <span className="session-id-badge">
                          {session.id.slice(0, 8)}
                        </span>
                      ) : null}
                    </div>
                    <span>
                      Prostar
                      {session.version ? ` ${session.version}` : ""}
                      {` · ${relativeLastSeen(session.lastSeenAt)}`}
                    </span>
                  </div>

                  <div
                    className="session-state"
                    aria-live="polite"
                    aria-label={`${displayName}: ${labels[session.state]}${
                      session.viewerCount > 0
                        ? `, ${session.viewerCount} ${
                            session.viewerCount === 1 ? "viewer" : "viewers"
                          }`
                        : ""
                    }`}
                  >
                    <span
                      className={`session-dot ${session.state}`}
                      aria-hidden="true"
                    />
                    <span>
                      {labels[session.state]}
                      {session.viewerCount > 0
                        ? ` · ${session.viewerCount} ${
                            session.viewerCount === 1 ? "viewer" : "viewers"
                          }`
                        : ""}
                    </span>
                  </div>

                  <div className="session-actions">
                    {session.state === "link_ready" ||
                    session.state === "watching" ? (
                      <a
                        className="button-link compact-button"
                        href={`/watch/${encodeURIComponent(session.id)}`}
                        aria-label={`Watch ${displayName}`}
                      >
                        Watch
                      </a>
                    ) : null}
                    {isSharing ? (
                      <button
                        className="compact-button stop-button"
                        type="button"
                        disabled={isPending}
                        onClick={() => void setSharing(session, false)}
                        aria-label={`${
                          session.state === "starting" ? "Cancel" : "Stop"
                        } ${displayName}`}
                      >
                        {isPending
                          ? "Stopping…"
                          : session.state === "starting"
                            ? "Cancel"
                            : "Stop"}
                      </button>
                    ) : session.state === "stopping" ? (
                      <button className="compact-button" type="button" disabled>
                        Stopping…
                      </button>
                    ) : (
                      <button
                        className="compact-button"
                        type="button"
                        disabled={isPending}
                        onClick={() => void setSharing(session, true)}
                        aria-label={`Go live with ${displayName}`}
                      >
                        {isPending ? "Starting…" : "Go live"}
                      </button>
                    )}
                  </div>
                  {actionErrors.get(session.id) ? (
                    <p className="session-action-error" role="alert">
                      {actionErrors.get(session.id)}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
