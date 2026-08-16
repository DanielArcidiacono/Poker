import assert from "node:assert/strict";
import test from "node:test";
import { createCapture, type CaptureOptions } from "../src/capture";

function options(onFrame: (jpeg: Buffer) => void = () => undefined) {
  return {
    fps: 0.1,
    jpegQuality: 60,
    scale: 0.5,
    maxWidth: 1920,
    onFrame,
  } satisfies CaptureOptions;
}

test("preflight accepts a recent successful capture while a frame is busy", async () => {
  let now = 100;
  const pendingFrame = new Promise<Buffer>(() => undefined);
  const capture = createCapture(options(), {
    now: () => now,
    grabRawFrame: async () => Buffer.from("preflight"),
    grabFrame: () => pendingFrame,
  });

  await capture.preflight();
  capture.start();
  now = 101;
  await capture.preflight();
  capture.stop();
});

test("preflight rejects a busy capture without a recent success", async () => {
  let now = 10_000;
  const pendingFrame = new Promise<Buffer>(() => undefined);
  const capture = createCapture(options(), {
    now: () => now,
    grabRawFrame: async () => Buffer.from("preflight"),
    grabFrame: () => pendingFrame,
  });

  capture.start();
  await assert.rejects(capture.preflight(), /already in use/);
  now = -1;
  await assert.rejects(capture.preflight(), /already in use/);
  capture.stop();
});

test("preflight takes a fresh frame when a running capture is idle", async () => {
  let resolveFrame!: () => void;
  const frameDelivered = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });
  let rawCaptures = 0;
  const capture = createCapture(options(resolveFrame), {
    grabRawFrame: async () => {
      rawCaptures += 1;
      return Buffer.from("preflight");
    },
    grabFrame: async () => Buffer.from("live-frame"),
  });

  capture.start();
  await frameDelivered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await capture.preflight();
  assert.equal(rawCaptures, 1);
  capture.stop();
});
