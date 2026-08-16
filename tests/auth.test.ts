import assert from "node:assert/strict";
import test from "node:test";
import {
  createSession,
  destroySession,
  getPassword,
  isValidSession,
  passwordsMatch,
} from "../src/auth.js";

test("viewer password rejects unsafe defaults", () => {
  const previous = process.env.VIEWER_PASSWORD;
  try {
    process.env.VIEWER_PASSWORD = "change-me";
    assert.throws(() => getPassword(), /at least 12 characters/);
    process.env.VIEWER_PASSWORD = "a-secure-viewer-password";
    assert.equal(getPassword(), "a-secure-viewer-password");
  } finally {
    if (previous === undefined) delete process.env.VIEWER_PASSWORD;
    else process.env.VIEWER_PASSWORD = previous;
  }
});

test("password comparison and session lifecycle", () => {
  assert.equal(passwordsMatch("same password", "same password"), true);
  assert.equal(passwordsMatch("short", "a different password"), false);

  const { token } = createSession();
  assert.equal(isValidSession(token), true);
  destroySession(token);
  assert.equal(isValidSession(token), false);
});
