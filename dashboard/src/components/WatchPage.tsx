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

function streamUrl(status: Status | null): string | null {
  if (!status?.recording || !status.publicUrl || !status.watchToken) return null;
  return `${status.publicUrl.replace(/\/$/, "")}/embed?token=${encodeURIComponent(status.watchToken)}`;
}

export function WatchPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/status", {
      credentials: "same-origin",
      cache: "no-store",
    });
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

  // Cloudflare quick tunnels often block being framed. Open the stream as a
  // top-level page (same URL the Terminal prints) instead of an iframe.
  useEffect(() => {
    if (!authed) return;
    const url = streamUrl(status);
    if (!url) return;
    window.location.replace(url);
  }, [authed, status]);

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
          <p className="muted">
            Enter the password to open the live stream. You will be redirected
            to the public stream link automatically.
          </p>
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

  const url = streamUrl(status);
  if (url) {
    return (
      <main className="shell">
        <div className="card">
          <h1>Opening stream…</h1>
          <p className="muted">
            Redirecting to the live link. If nothing happens,{" "}
            <a href={url}>open it here</a>.
          </p>
        </div>
      </main>
    );
  }

  let detail =
    "Nothing is live yet. On the sharing Mac, run the install/share command, then refresh.";
  if (!status?.online) {
    detail =
      "Mac agent is offline. Finish the Terminal install on the sharing Mac, then refresh.";
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
