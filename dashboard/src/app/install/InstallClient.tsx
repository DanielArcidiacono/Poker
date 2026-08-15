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
  const watchUrl = `${origin.replace(/\/$/, "")}/watch`;

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
        <h1>Share this Mac</h1>
        <p className="muted">
          Installs a background agent on this Mac, publishes the stream to the
          dashboard, then you can quit Terminal. On computer 1 always open:
        </p>
        <p className="ok-line" style={{ marginTop: 8 }}>
          <a href={watchUrl}>{watchUrl}</a>
        </p>
        <p className="muted" style={{ marginTop: 12 }}>
          Needs <strong>Node.js</strong> (
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
          aria-label="Share command"
        />

        <div className="actions">
          <button type="button" onClick={copyOrSelect}>
            Select command
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
            Wait until it prints the stable watch URL (same as above).
          </li>
          <li>
            On computer 1 open that <strong>/watch</strong> page (password{" "}
            <code>change-me</code>).
          </li>
          <li>
            You can quit Terminal on computer 2 — sharing keeps running until you
            uninstall the agent.
          </li>
        </ol>
      </div>
    </main>
  );
}
