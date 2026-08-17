export function buildWatchProbeUrl(
  publicUrl: string,
  attempt: number,
): string {
  const url = new URL("/styles.css", publicUrl);
  url.searchParams.set("prostar-watch-probe", String(attempt));
  return url.toString();
}

export const WATCH_PROBE_TIMEOUT_MS = 15_000;

type WatchProbeElement = Pick<
  HTMLLinkElement,
  "onerror" | "onload" | "remove"
>;

export function monitorWatchProbe(
  probe: WatchProbeElement,
  {
    onReady,
    onUnavailable,
    timeoutMs = WATCH_PROBE_TIMEOUT_MS,
  }: {
    onReady: () => void;
    onUnavailable: () => void;
    timeoutMs?: number;
  },
): () => void {
  let stopped = false;

  const finish = (ready: boolean) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    probe.onload = null;
    probe.onerror = null;
    probe.remove();
    if (ready) onReady();
    else onUnavailable();
  };

  const timeout = setTimeout(() => finish(false), timeoutMs);
  probe.onload = () => finish(true);
  probe.onerror = () => finish(false);

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    probe.onload = null;
    probe.onerror = null;
    probe.remove();
  };
}
