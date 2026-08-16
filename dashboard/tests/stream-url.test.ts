import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStreamUrl } from "../src/lib/stream-url";

test("accepts only expected stream origins", () => {
  assert.equal(
    normalizeStreamUrl("https://quiet-river.trycloudflare.com"),
    "https://quiet-river.trycloudflare.com",
  );
});

test("rejects SSRF and redirect destinations", () => {
  for (const url of [
    "https://example.com",
    "http://127.0.0.1:8787",
    "http://10.2.3.4:8787",
    "http://192.168.1.20:8787",
    "http://169.254.169.254:8787",
    "http://192.168.1.20:3000",
    "https://quiet-river.trycloudflare.com.evil.test",
    "https://quiet-river.trycloudflare.com/path",
    "https://user:password@quiet-river.trycloudflare.com",
    "not a url",
  ]) {
    assert.equal(normalizeStreamUrl(url), null, url);
  }
});
