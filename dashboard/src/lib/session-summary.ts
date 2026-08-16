import type { SessionReport } from "./store";

export type SessionState =
  | "ready"
  | "starting"
  | "error"
  | "link_ready"
  | "watching"
  | "stopping";

export type SessionSummary = {
  id: string;
  name: string;
  state: SessionState;
  lastSeenAt: number;
  viewerCount: number;
  version: string | null;
};

export function summarizeSession(report: SessionReport): SessionSummary {
  let state: SessionState = "ready";
  if (!report.desiredSharing && report.message === "Stopping sharing…") {
    state = "stopping";
  } else if (report.viewerCount > 0) {
    state = "watching";
  } else if (report.recording) {
    state = "link_ready";
  } else if (report.desiredSharing) {
    state =
      report.message === "Starting secure tunnel…" ||
      report.message === "Starting Cloudflare tunnel…"
        ? "starting"
        : "error";
  }

  return {
    id: report.id,
    name: report.hostname?.trim() || `Mac ${report.id.slice(0, 8)}`,
    state,
    lastSeenAt: report.lastSeen ?? Date.now(),
    viewerCount: report.viewerCount,
    version: report.version,
  };
}
