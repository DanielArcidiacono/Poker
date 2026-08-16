import assert from "node:assert/strict";
import test from "node:test";
import {
  createInstallToken,
  deriveAgentCredential,
  isValidInstallToken,
  parseInstallToken,
} from "../src/lib/install-token";

test("installer claims bind a unique scoped agent credential", () => {
  const previous = process.env.PROSTAR_ENROLLMENT_SECRET;
  process.env.PROSTAR_ENROLLMENT_SECRET = "a".repeat(32);
  try {
    const now = 1_000_000;
    const token = createInstallToken(now);
    const claim = parseInstallToken(token, now);
    assert.ok(claim);
    assert.equal(isValidInstallToken(token, now), true);
    assert.equal(isValidInstallToken(token, now + 10 * 60 * 1000 + 1), false);
    assert.equal(isValidInstallToken(`${token}x`, now), false);
    assert.equal(isValidInstallToken(null, now), false);
    assert.equal(
      deriveAgentCredential(claim.clientId),
      deriveAgentCredential(claim.clientId),
    );
    const otherClaim = parseInstallToken(createInstallToken(now), now);
    assert.ok(otherClaim);
    assert.notEqual(otherClaim.clientId, claim.clientId);
    assert.notEqual(
      deriveAgentCredential(otherClaim.clientId),
      deriveAgentCredential(claim.clientId),
    );
  } finally {
    if (previous === undefined) delete process.env.PROSTAR_ENROLLMENT_SECRET;
    else process.env.PROSTAR_ENROLLMENT_SECRET = previous;
  }
});
