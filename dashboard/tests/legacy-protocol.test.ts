import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_INSTANCE_ID } from "../src/lib/client-id";
import {
  legacyCommandForState,
  resolveAgentProtocol,
} from "../src/lib/legacy-protocol";

test("old and transitional Prostar agents share a session without sharing a lease identity", () => {
  assert.deepEqual(resolveAgentProtocol(false, undefined), {
    legacySession: true,
    legacyProtocol: true,
    instanceId: LEGACY_INSTANCE_ID,
  });

  const transitionalInstance = "99999999-9999-4999-8999-999999999999";
  assert.deepEqual(resolveAgentProtocol(false, transitionalInstance), {
    legacySession: true,
    legacyProtocol: false,
    instanceId: transitionalInstance,
  });

  assert.equal(
    legacyCommandForState(true, {
      recording: false,
      message: "Starting Cloudflare tunnel…",
    })?.type,
    "start_recording",
  );
  assert.equal(
    legacyCommandForState(false, {
      recording: false,
      message: "Recording stopped.",
    })?.type,
    "stop_recording",
  );
});
