"use client";

import { useEffect, useMemo, useState } from "react";
import { WatchWait } from "@/components/WatchWait";
import {
  buildWatchProbeUrl,
  monitorWatchProbe,
  WATCH_PROBE_TIMEOUT_MS,
} from "@/lib/watch-probe";

const PROBE_RETRY_MS = 1_000;

export function WatchBridge({
  publicUrl,
  readyPath,
  sessionName,
}: {
  publicUrl: string;
  readyPath: string;
  sessionName: string;
}) {
  const expectedOrigin = useMemo(() => new URL(publicUrl).origin, [publicUrl]);
  const [probeUnavailable, setProbeUnavailable] = useState(false);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retry: number | null = null;
    let stopProbe: (() => void) | null = null;
    const deadline = performance.now() + WATCH_PROBE_TIMEOUT_MS;

    setProbeUnavailable(false);

    function markUnavailableOrRetry() {
      if (stopped) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        setProbeUnavailable(true);
        return;
      }
      retry = window.setTimeout(
        startProbe,
        Math.min(PROBE_RETRY_MS, remaining),
      );
    }

    function startProbe() {
      if (stopped) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        setProbeUnavailable(true);
        return;
      }

      const probe = document.createElement("link");
      probe.rel = "stylesheet";
      probe.media = "print";
      probe.referrerPolicy = "no-referrer";
      probe.href = buildWatchProbeUrl(expectedOrigin, attempt++);
      stopProbe = monitorWatchProbe(probe, {
        onReady: () => {
          // Return through the dashboard so it can re-read the session and
          // reject a probe that raced with Stop or a tunnel rotation.
          window.location.replace(readyPath);
        },
        onUnavailable: markUnavailableOrRetry,
        timeoutMs: remaining,
      });
      document.head.appendChild(probe);
    }

    startProbe();
    return () => {
      stopped = true;
      if (retry !== null) window.clearTimeout(retry);
      stopProbe?.();
    };
  }, [expectedOrigin, readyPath]);

  return (
    <WatchWait
      actionLabel="Open secure link"
      actionPath={readyPath}
      detail={
        probeUnavailable
          ? "The automatic check could not verify this Cloudflare link. Open the secure link directly."
          : "Connecting to Prostar through Cloudflare…"
      }
      sessionName={sessionName}
    />
  );
}
