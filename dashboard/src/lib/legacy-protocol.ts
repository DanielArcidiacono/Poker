import { LEGACY_INSTANCE_ID } from "./client-id";

const INSTANCE_ID = /^[0-9a-f-]{36}$/i;

export function validAgentInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID.test(value);
}

export function resolveAgentProtocol(
  hasClientId: boolean,
  providedInstanceId: unknown,
) {
  const legacySession = !hasClientId;
  const legacyProtocol =
    legacySession && !validAgentInstanceId(providedInstanceId);
  return {
    legacySession,
    legacyProtocol,
    instanceId: legacyProtocol ? LEGACY_INSTANCE_ID : providedInstanceId,
  };
}

export function legacyCommandForState(
  desiredSharing: boolean,
  report: { recording: boolean; message: string | null },
): { type: "start_recording" | "stop_recording" } | null {
  if (desiredSharing && !report.recording) {
    return { type: "start_recording" };
  }
  if (!desiredSharing) {
    // Old installations keep SHARE_ON_START armed after handling Stop. Keeping
    // a command on every idle poll prevents their commandless auto-start path.
    return { type: "stop_recording" };
  }
  return null;
}
