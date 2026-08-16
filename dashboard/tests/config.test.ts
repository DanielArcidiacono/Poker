import assert from "node:assert/strict";
import test from "node:test";
import { getAgentToken, getDashboardPassword } from "../src/lib/config";

test("dashboard secrets reject documented placeholders", () => {
  const previousPassword = process.env.DASHBOARD_PASSWORD;
  const previousToken = process.env.PROSTAR_ENROLLMENT_SECRET;
  try {
    process.env.DASHBOARD_PASSWORD = "replace-with-a-strong-password";
    process.env.PROSTAR_ENROLLMENT_SECRET =
      "generate-at-least-32-random-characters";
    assert.throws(() => getDashboardPassword(), /at least 12 characters/);
    assert.throws(() => getAgentToken(), /32–256 URL-safe characters/);

    process.env.DASHBOARD_PASSWORD = "a-real-dashboard-password";
    process.env.PROSTAR_ENROLLMENT_SECRET = "b".repeat(32);
    assert.equal(getDashboardPassword(), "a-real-dashboard-password");
    assert.equal(getAgentToken(), "b".repeat(32));
  } finally {
    if (previousPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = previousPassword;
    if (previousToken === undefined) {
      delete process.env.PROSTAR_ENROLLMENT_SECRET;
    } else {
      process.env.PROSTAR_ENROLLMENT_SECRET = previousToken;
    }
  }
});
