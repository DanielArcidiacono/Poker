"use client";

import { useRef, useState } from "react";

type SetupPlatform = "macos" | "windows";

export function InstallClient({
  macCommand,
  windowsCommand,
  initialPlatform,
  origin,
}: {
  macCommand: string;
  windowsCommand: string;
  initialPlatform: SetupPlatform;
  origin: string;
}) {
  const [platform, setPlatform] = useState<SetupPlatform>(initialPlatform);
  const [hint, setHint] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const copyAttemptRef = useRef(0);
  const dashboardUrl = origin.replace(/\/$/, "");
  const isWindows = platform === "windows";
  const command = isWindows ? windowsCommand : macCommand;
  const copyShortcut = isWindows ? "Ctrl+C" : "Cmd+C";
  const pasteShortcut = isWindows ? "Ctrl+V" : "Cmd+V";
  const terminalName = isWindows ? "Windows PowerShell" : "Terminal";

  function selectCommand() {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
  }

  function copyOrSelect() {
    selectCommand();
    const copyAttempt = ++copyAttemptRef.current;
    const secure = window.isSecureContext;
    if (secure && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(command).then(
        () => {
          if (copyAttempt === copyAttemptRef.current) {
            setHint(`Copied. Paste in ${terminalName} with ${pasteShortcut}.`);
          }
        },
        () => {
          if (copyAttempt === copyAttemptRef.current) {
            setHint(
              `Selected — press ${copyShortcut} to copy, then paste in ${terminalName} (${pasteShortcut}).`,
            );
          }
        },
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
        ? `Copied. Paste in ${terminalName} with ${pasteShortcut}.`
        : `Selected — press ${copyShortcut} to copy, then paste in ${terminalName} (${pasteShortcut}).`,
    );
  }

  function choosePlatform(nextPlatform: SetupPlatform) {
    copyAttemptRef.current += 1;
    setHint("");
    setPlatform(nextPlatform);
  }

  return (
    <main className="shell">
      <div className="card prompt" style={{ width: "min(100%, 520px)" }}>
        <h1>Set up Prostar</h1>
        <p className="muted">
          Install Prostar on the computer you want to view, then manage its
          session from:
        </p>
        <p className="ok-line" style={{ marginTop: 8 }}>
          <a href={dashboardUrl}>{dashboardUrl}</a>
        </p>
        <fieldset className="platform-picker">
          <legend className="visually-hidden">Operating system</legend>
          <label className={!isWindows ? "active" : ""}>
            <input
              type="radio"
              name="setup-platform"
              value="macos"
              checked={!isWindows}
              onChange={() => choosePlatform("macos")}
            />
            <span>macOS</span>
          </label>
          <label className={isWindows ? "active" : ""}>
            <input
              type="radio"
              name="setup-platform"
              value="windows"
              checked={isWindows}
              onChange={() => choosePlatform("windows")}
            />
            <span>Windows</span>
          </label>
        </fieldset>

        <section
          id="setup-instructions"
          className="setup-instructions"
          aria-label={`${isWindows ? "Windows" : "macOS"} setup`}
        >
          <p className="muted setup-requirements">
            {isWindows ? (
              <>
                Supports <strong>Windows 10 or 11 on 64-bit Intel/AMD</strong>,
                or Windows 11 on Arm64. No administrator access is required.
              </>
            ) : (
              <>
                Requires <strong>macOS 15 or later</strong>.
              </>
            )}{" "}
            Prostar installs its own private runtime—no Node.js, package
            manager, or developer tools are needed.
          </p>

          <textarea
            ref={textRef}
            className="install-cmd"
            readOnly
            value={command}
            onFocus={selectCommand}
            onClick={selectCommand}
            rows={3}
            spellCheck={false}
            aria-label={`Prostar setup command for ${isWindows ? "Windows" : "macOS"}`}
          />

          <div className="actions">
            <button type="button" onClick={copyOrSelect}>
              Copy {isWindows ? "PowerShell" : "Terminal"} command
            </button>
            <a className="button-link secondary-button" href={origin || "/"}>
              Back
            </a>
          </div>

          <p
            className={hint ? "ok-line setup-hint" : "muted setup-hint"}
            aria-live="polite"
          >
            {hint || (
              <>
                Select the command, press <strong>{copyShortcut}</strong>, then
                paste it into {terminalName}.
              </>
            )}
          </p>

          <ol className="steps setup-steps">
            <li>
              Open <strong>{terminalName}</strong> on the {isWindows ? "PC" : "Mac"}{" "}
              you want to share, paste the command, and press Enter.
            </li>
            <li>
              {isWindows ? (
                <>
                  Wait for <strong>Prostar installed successfully.</strong> Windows
                  does not require a screen-capture permission prompt.
                </>
              ) : (
                <>
                  Approve the Screen Recording request when macOS shows it, then
                  wait for <strong>Prostar installed successfully.</strong>
                </>
              )}
            </li>
            <li>
              Return to this dashboard and press <strong>Go live</strong> for the
              new session.
            </li>
            <li>
              The setup shell closes after success. Use <strong>Stop</strong> on
              the dashboard whenever you are done sharing.
            </li>
          </ol>
          <p className="muted setup-footnote">
            This command expires in 10 minutes. Setup stays quiet and prints
            only its final result. Prostar starts automatically after sign-in
            and survives restarts. Dashboard Stop closes the public link but
            leaves Prostar installed.
          </p>
        </section>
      </div>
    </main>
  );
}
