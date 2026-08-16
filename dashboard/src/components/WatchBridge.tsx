"use client";

import { useEffect, useMemo } from "react";
import { WatchWait } from "@/components/WatchWait";
import { buildWatchProbeUrl } from "@/lib/watch-probe";

const PROBE_INTERVAL_MS = 3_000;

export function WatchBridge({
  publicUrl,
  readyPath,
  sessionName,
  watchPath,
}: {
  publicUrl: string;
  readyPath: string;
  sessionName: string;
  watchPath: string;
}) {
  const expectedOrigin = useMemo(() => new URL(publicUrl).origin, [publicUrl]);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let probe: HTMLLinkElement | null = null;
    let timer: number | null = null;

    function connectWhenReady() {
      if (stopped) return;
      probe?.remove();
      probe = document.createElement("link");
      probe.rel = "stylesheet";
      probe.media = "print";
      probe.referrerPolicy = "no-referrer";
      probe.href = buildWatchProbeUrl(expectedOrigin, attempt++);
      probe.onload = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        // Return through the dashboard so it can re-read the session and
        // reject a probe that raced with Stop or a tunnel rotation.
        window.location.replace(readyPath);
      };
      document.head.appendChild(probe);
      timer = window.setTimeout(connectWhenReady, PROBE_INTERVAL_MS);
    }

    connectWhenReady();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      probe?.remove();
    };
  }, [expectedOrigin, readyPath]);

  return (
    <WatchWait
      detail="Connecting to Prostar through Cloudflare…"
      sessionName={sessionName}
      watchPath={watchPath}
    />
  );
}
