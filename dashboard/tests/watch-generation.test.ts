import assert from "node:assert/strict";
import test from "node:test";
import { watchGenerationKey } from "../src/lib/watch-generation";

test("watch generation changes when either the tunnel or token rotates", () => {
  const first = watchGenerationKey(
    "https://quiet-river.trycloudflare.com",
    "token-one",
  );
  assert.equal(
    first,
    watchGenerationKey(
      "https://quiet-river.trycloudflare.com",
      "token-one",
    ),
  );
  assert.notEqual(
    first,
    watchGenerationKey(
      "https://quiet-river.trycloudflare.com",
      "token-two",
    ),
  );
  assert.notEqual(
    first,
    watchGenerationKey(
      "https://new-river.trycloudflare.com",
      "token-one",
    ),
  );
});
