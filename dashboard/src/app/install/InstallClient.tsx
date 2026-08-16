"use client";

import { useEffect, useRef, useState } from "react";

export function InstallClient({
  cmd,
  origin,
}: {
  cmd: string;
  origin: string;
}) {
  const [hint, setHint] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dashboardUrl = origin.replace(/\/$/, "");

  function selectCommand() {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
  }

  useEffect(() => {
    const t = window.setTimeout(() => selectCommand(), 50);
    return () => window.clearTimeout(t);
  }, [cmd]);

  function copyOrSelect() {
    selectCommand();
    const secure = window.isSecureContext;
    if (secure && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(cmd).then(
        () => setHint("Copied. Paste in Terminal with Cmd+V."),
        () =>
          setHint(
            "Selected — press Cmd+C to copy, then paste in Terminal (Cmd+V).",
          ),
      );
      return;
    }

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    setHint(
      copied
        ? "Copied. Paste in Terminal with Cmd+V."
        : "Selected — press Cmd+C to copy, then paste in Terminal (Cmd+V).",
    );
  }

  return (
    <main className="shell">
      <div className="card prompt" style={{ width: "min(100%, 520px)" }}>
        <h1>Set up Prostar</h1>
        <p className="muted">
          Installs Prostar on this Mac. After setup, manage its session from:
        </p>
        <p className="ok-line" style={{ marginTop: 8 }}>
          <a href={dashboardUrl}>{dashboardUrl}</a>
        </p>
        <p className="muted" style={{ marginTop: 12 }}>
          Needs <strong>Node.js 20.9+</strong> (
          <a href="https://nodejs.org" target="_blank" rel="noreferrer">
            nodejs.org
          </a>
          ). Select the command, <strong>Cmd+C</strong>, paste in Terminal.
        </p>

        <textarea
          ref={textRef}
          className="install-cmd"
          readOnly
          value={cmd}
          onFocus={selectCommand}
          onClick={selectCommand}
          rows={2}
          aria-label="Prostar setup command"
        />

        <div className="actions">
          <button type="button" onClick={copyOrSelect}>
            Copy command
          </button>
          <a className="button-link" href={origin || "/"}>
            Back
          </a>
        </div>

        {hint ? (
          <p className="ok-line" style={{ marginTop: 12 }}>
            {hint}
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            On Wi‑Fi links, use <strong>Cmd+C</strong> after selecting.
          </p>
        )}

        <ol className="steps" style={{ marginTop: 18 }}>
          <li>
            Paste the command in <strong>Terminal</strong> on the Mac you want to
            share.
          </li>
          <li>
            Approve the Screen Recording request when macOS shows it, then wait
            for <strong>Prostar installed successfully.</strong>
          </li>
          <li>
            On the viewing device, return to the <strong>dashboard</strong> and
            press Go live.
          </li>
          <li>
            You can quit Terminal on the Mac. Use <strong>Stop</strong> on the
            Prostar dashboard whenever you are done.
          </li>
        </ol>
        <p className="muted" style={{ marginTop: 14 }}>
          Production setup stays quiet and prints only its final result. Run
          <code> prostar-admin </code> on the Mac for status, controls, or logs.
        </p>
      </div>
    </main>
  );
}
