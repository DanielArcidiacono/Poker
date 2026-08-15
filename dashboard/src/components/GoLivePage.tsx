"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LiveInfo = {
  online: boolean;
  recording: boolean;
  message: string | null;
  hostname: string | null;
  lastSeen: number | null;
  publicUrl: string | null;
  setupRepoPath: string;
  agentLocalUrl: string;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function installPageUrl(controlPlaneUrl: string) {
  return `/install?controlPlaneUrl=${encodeURIComponent(controlPlaneUrl)}`;
}

export function GoLivePage() {
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [showOpenHelp, setShowOpenHelp] = useState(false);
  const [localAgentHere, setLocalAgentHere] = useState(false);
  const [origin, setOrigin] = useState("");
  const waitingForAgent = useRef(false);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-8), line]);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/go-live", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as LiveInfo;
      setInfo(data);
      return data;
    }
    return null;
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const localUrl = info?.agentLocalUrl ?? "http://127.0.0.1:8787";
    let cancelled = false;
    async function probe() {
      try {
        const res = await fetch(`${localUrl}/api/health`, {
          mode: "cors",
          cache: "no-store",
        });
        if (!cancelled) setLocalAgentHere(res.ok);
      } catch {
        if (!cancelled) setLocalAgentHere(false);
      }
    }
    void probe();
    const id = setInterval(() => void probe(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [info?.agentLocalUrl]);

  async function startRecordingViaControlPlane(): Promise<"ok" | "offline" | "error"> {
    const res = await fetch("/api/go-live", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 || data.agentOffline) return "offline";
    if (!res.ok) {
      pushLog(data.message || data.error || `Go live failed (${res.status})`);
      return "error";
    }
    return "ok";
  }

  async function installLocalAgent(localUrl: string): Promise<void> {
    const res = await fetch(`${localUrl}/api/agent/install-bootstrap`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      throw new Error(
        "Agent on this Mac is outdated. In ~/Poker run npm start again, then retry.",
      );
    }
    if (!res.ok) {
      throw new Error(data.error || `Install failed (${res.status})`);
    }
  }

  async function waitUntilOnline(timeoutMs = 180_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await refresh();
      if (data?.online) return true;
      await sleep(2000);
    }
    return false;
  }

  async function waitUntilRecording(timeoutMs = 60_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await refresh();
      if (data?.recording) return true;
      await sleep(1500);
    }
    return false;
  }

  async function finishGoLive() {
    pushLog("Agent online — starting stream…");
    const result = await startRecordingViaControlPlane();
    if (result !== "ok") {
      pushLog("Agent online but Go live failed. Press Go live again.");
      return;
    }
    pushLog("Starting tunnel…");
    const live = await waitUntilRecording();
    pushLog(
      live
        ? "Live. Open /watch to view the stream."
        : "Go live sent. Open /watch in a few seconds.",
    );
    setShowOpenHelp(false);
    waitingForAgent.current = false;
  }

  async function continueAfterInstallOpened() {
    setBusy(true);
    setShowOpenHelp(true);
    waitingForAgent.current = true;
    setLog([
      "Opened install page in a new tab.",
      "Paste the command in Terminal and press Enter.",
      "Waiting for agent…",
    ]);

    try {
      const quick = await startRecordingViaControlPlane();
      if (quick === "ok") {
        pushLog("Starting tunnel…");
        const live = await waitUntilRecording();
        pushLog(
          live
            ? "Live. Open /watch to view the stream."
            : "Go live sent. Open /watch in a few seconds.",
        );
        setShowOpenHelp(false);
        waitingForAgent.current = false;
        return;
      }

      const online = await waitUntilOnline(180_000);
      if (!online) {
        pushLog(
          "Timed out. Finish the Terminal install, then press Go live again.",
        );
        return;
      }
      await finishGoLive();
    } catch (err) {
      pushLog(err instanceof Error ? err.message : "Go live failed");
    } finally {
      setBusy(false);
    }
  }

  async function goLiveExistingAgent() {
    setBusy(true);
    setLog(["Go live pressed…"]);
    setShowOpenHelp(false);

    try {
      pushLog("Contacting dashboard…");
      const result = await startRecordingViaControlPlane();

      if (result === "ok") {
        pushLog("Starting tunnel…");
        const live = await waitUntilRecording();
        pushLog(
          live
            ? "Live. Open /watch to view the stream."
            : "Go live sent. Open /watch in a few seconds.",
        );
        return;
      }

      if (result === "error") return;

      if (localAgentHere) {
        const localUrl = info?.agentLocalUrl ?? "http://127.0.0.1:8787";
        pushLog("Installing/starting agent on this Mac…");
        await installLocalAgent(localUrl);
        pushLog("Waiting for agent to come online…");
        const online = await waitUntilOnline(60_000);
        if (!online) {
          pushLog(
            "Still offline. Check CONTROL_PLANE_URL, then press Go live again.",
          );
          return;
        }
        await finishGoLive();
        return;
      }

      pushLog("No agent found — press Go live again to open the installer.");
    } catch (err) {
      pushLog(err instanceof Error ? err.message : "Go live failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!waitingForAgent.current || !info?.online || busy) return;
    waitingForAgent.current = false;
    void (async () => {
      setBusy(true);
      try {
        await finishGoLive();
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.online]);

  const needsInstaller = !info?.online && !localAgentHere;
  const installHref = origin ? installPageUrl(origin) : "/install";

  return (
    <main className="shell">
      <div className="go-live-wrap">
        <p className="muted" style={{ marginBottom: 16, maxWidth: 420 }}>
          To share the other Mac: open{" "}
          <a href={installHref} target="_blank" rel="noopener noreferrer">
            Share this Mac
          </a>{" "}
          there, run the Terminal command once, then on this computer open{" "}
          <a href="/watch">/watch</a> (stable URL). You can quit Terminal on the
          other Mac afterward.
        </p>
        <p className="muted" style={{ marginBottom: 16 }}>
          Agent:{" "}
          <span className={info?.online ? "ok" : "err"}>
            {info?.online ? "online" : "offline"}
          </span>
          {info?.hostname ? ` · ${info.hostname}` : ""}
          {info?.recording ? " · recording" : ""}
          {localAgentHere ? " · agent on this computer" : ""}
        </p>
        {info?.message ? (
          <p className="muted" style={{ marginBottom: 16, maxWidth: 420 }}>
            {info.message}
          </p>
        ) : null}

        {needsInstaller ? (
          <a
            className={`go-live-btn${busy ? " disabled" : ""}`}
            href={installHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (busy) {
                e.preventDefault();
                return;
              }
              void continueAfterInstallOpened();
            }}
            aria-disabled={busy}
          >
            {busy ? "Working…" : "Go live"}
          </a>
        ) : (
          <button
            type="button"
            className="go-live-btn"
            disabled={busy}
            onClick={() => void goLiveExistingAgent()}
          >
            {busy ? "Working…" : "Go live"}
          </button>
        )}

        {log.length > 0 ? (
          <div className="banner ok" style={{ marginTop: 16, textAlign: "left" }}>
            {log.map((line, i) => (
              <div key={`${i}-${line}`}>{line}</div>
            ))}
          </div>
        ) : null}

        {showOpenHelp ? (
          <p className="muted" style={{ marginTop: 16, maxWidth: 420 }}>
            In the install tab, select the command and press{" "}
            <strong>Cmd+C</strong>, then paste in Terminal (
            <strong>Cmd+V</strong>) and Enter. Come back here and press Go live
            again when install finishes.
          </p>
        ) : null}

        {info?.recording ? (
          <p className="ok-line">
            Live.{" "}
            <a href="/watch">Watch the stream</a>
            {info.publicUrl ? (
              <span className="muted"> · via {info.publicUrl}</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </main>
  );
}
