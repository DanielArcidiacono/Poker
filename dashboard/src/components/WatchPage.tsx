"use client";

import { useCallback, useEffect, useState } from "react";

type Status = {
  online: boolean;
  recording: boolean;
  publicUrl: string | null;
  watchToken: string | null;
  message: string | null;
  hostname: string | null;
};

export function WatchPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/status", { credentials: "same-origin" });
    if (res.status === 401) {
      setAuthed(false);
      setStatus(null);
      return;
    }
    if (!res.ok) return;
    setAuthed(true);
    setStatus(await res.json());
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setLoginError(data.error || "Login failed");
      return;
    }
    setPassword("");
    setAuthed(true);
    await refresh();
  }

  if (authed === null) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="shell">
        <form className="card" onSubmit={login}>
          <h1>Watch</h1>
          <p className="muted">Enter the password to view the live stream.</p>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <button type="submit">Watch</button>
          {loginError ? <p className="err">{loginError}</p> : null}
        </form>
      </main>
    );
  }

  const embedSrc =
    status?.recording && status.publicUrl && status.watchToken
      ? `${status.publicUrl.replace(/\/$/, "")}/embed?token=${encodeURIComponent(status.watchToken)}`
      : null;

  if (!embedSrc) {
    let detail =
      "Nothing is live yet. Open Go live, wait until it says Live, then refresh.";
    if (!status?.online) {
      detail =
        "Mac agent is offline. On the sharing Mac, finish the Terminal install, then press Go live again.";
    } else if (status.message) {
      detail = status.message;
    }

    return (
      <main className="shell">
        <div className="card">
          <h1>Watch</h1>
          <p className="muted">{detail}</p>
          <p className="muted" style={{ marginTop: 8 }}>
            Agent:{" "}
            <span className={status?.online ? "ok" : "err"}>
              {status?.online ? "online" : "offline"}
            </span>
            {status?.hostname ? ` · ${status.hostname}` : ""}
            {status?.recording ? " · recording" : " · not recording"}
          </p>
          <a className="button-link" href="/">
            Go live
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="watch-frame">
      <iframe
        title="Live stream"
        src={embedSrc}
        allow="fullscreen"
        referrerPolicy="no-referrer"
      />
    </main>
  );
}
