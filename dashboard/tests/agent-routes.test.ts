import assert from "node:assert/strict";
import test from "node:test";
import {
  checkScopedAgentBearer,
  hashAgentCredential,
} from "../src/lib/auth";
import { getStore } from "../src/lib/store";

test("a scoped credential cannot claim another Prostar session", async () => {
  const firstClient = "33333333-3333-4333-8333-333333333333";
  const secondClient = "44444444-4444-4444-8444-444444444444";
  const firstSecret = "first-prostar-secret-000000000000";
  const secondSecret = "second-prostar-secret-00000000000";
  const store = getStore();
  await store.enrollSession(firstClient, hashAgentCredential(firstSecret));
  await store.enrollSession(secondClient, hashAgentCredential(secondSecret));

  assert.equal(
    await checkScopedAgentBearer(`Bearer ${secondSecret}`, firstClient),
    false,
  );
  assert.equal(
    await checkScopedAgentBearer(`Bearer ${firstSecret}`, firstClient),
    true,
  );
});
