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
          Same method as computer 1: this Mac creates a public link in Terminal.
          You open that link on the other computer — ignore Go live / offline for
          now.
        </p>
        <p className="muted">
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
            Wait for a block that says{" "}
            <strong>OPEN THIS ON THE OTHER COMPUTER</strong> with a{" "}
            <code>trycloudflare.com</code> link.
          </li>
          <li>
            On computer 1, open that link and enter password{" "}
            <code>change-me</code>.
          </li>
          <li>Leave Terminal open on computer 2 while sharing.</li>
        </ol>
      </div>
    </main>
  );
}
