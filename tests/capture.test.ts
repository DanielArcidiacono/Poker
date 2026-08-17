import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCapture, type CaptureOptions } from "../src/capture";
import {
  createWindowsCaptureBackend,
  type WindowsCaptureProcess,
} from "../src/windows-capture";

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

class FakeWindowsCaptureProcess
  extends EventEmitter
  implements WindowsCaptureProcess
{
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killCount = 0;

  kill(): boolean {
    this.killCount += 1;
    return true;
  }
}

type WorkerRequest = {
  v: number;
  id: number;
  op: "capture" | "probe";
  jpegQuality: number;
  scale: number;
  maxWidth: number;
  displayId?: number;
};

function handleWorkerRequests(
  process: FakeWindowsCaptureProcess,
  handler: (request: WorkerRequest) => void,
): void {
  let buffered = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) return;
      const request = JSON.parse(
        buffered.subarray(4, 4 + length).toString("utf8"),
      ) as WorkerRequest;
      buffered = buffered.subarray(4 + length);
      handler(request);
    }
  });
}

function workerResponse(
  header: Record<string, unknown>,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(encoded.length, 0);
  return Buffer.concat([prefix, encoded, payload]);
}

const windowsOptions = {
  jpegQuality: 60,
  scale: 0.5,
  maxWidth: 1920,
  displayId: 1,
};

test("Windows capture reuses one worker and parses split binary JPEG frames", async () => {
  const process = new FakeWindowsCaptureProcess();
  const requests: WorkerRequest[] = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
  handleWorkerRequests(process, (request) => {
    requests.push(request);
    const response = workerResponse(
      {
        v: 1,
        id: request.id,
        ok: true,
        length: jpeg.length,
        mime: "image/jpeg",
      },
      jpeg,
    );
    // Pipes may split both the length prefix and the JPEG at any byte.
    for (const byte of response) process.stdout.write(Buffer.from([byte]));
  });
  let spawns = 0;
  const backend = createWindowsCaptureBackend({
    spawnWorker: () => {
      spawns += 1;
      return process;
    },
  });

  assert.deepEqual(await backend.capture(windowsOptions), jpeg);
  assert.deepEqual(await backend.capture(windowsOptions), jpeg);
  assert.equal(spawns, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ id: _id, ...request }) => request),
    [
      { v: 1, op: "capture", ...windowsOptions },
      { v: 1, op: "capture", ...windowsOptions },
    ],
  );

  backend.close();
  assert.equal(process.killCount, 1);
});

test("Windows preflight captures through the worker without returning pixels", async () => {
  const process = new FakeWindowsCaptureProcess();
  let operation = "";
  handleWorkerRequests(process, (request) => {
    operation = request.op;
    process.stdout.write(
      workerResponse({ v: 1, id: request.id, ok: true, length: 0 }),
    );
  });
  const backend = createWindowsCaptureBackend({
    spawnWorker: () => process,
  });

  await backend.preflight(windowsOptions);
  assert.equal(operation, "probe");
  backend.close();
});

test("Windows capture rejects oversized worker frames and terminates the worker", async () => {
  const process = new FakeWindowsCaptureProcess();
  handleWorkerRequests(process, () => {
    const invalidPrefix = Buffer.alloc(4);
    invalidPrefix.writeUInt32LE(65_537, 0);
    process.stdout.write(invalidPrefix);
  });
  const backend = createWindowsCaptureBackend({
    spawnWorker: () => process,
  });

  await assert.rejects(
    backend.capture(windowsOptions),
    /invalid header length/,
  );
  assert.equal(process.killCount, 1);
});

test("Windows worker errors retain their typed capture code", async () => {
  const process = new FakeWindowsCaptureProcess();
  handleWorkerRequests(process, (request) => {
    process.stdout.write(
      workerResponse({
        v: 1,
        id: request.id,
        ok: false,
        length: 0,
        code: "invalid_display",
        error: "The selected display is unavailable",
      }),
    );
  });
  const backend = createWindowsCaptureBackend({
    spawnWorker: () => process,
  });

  await assert.rejects(
    backend.capture(windowsOptions),
    /invalid_display: The selected display is unavailable/,
  );
  backend.close();
});

test("Windows capture controller closes its lazy worker when viewing stops", async () => {
  let closes = 0;
  let captures = 0;
  let frameDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    frameDelivered = resolve;
  });
  const capture = createCapture(options(frameDelivered), {
    platform: "win32",
    windowsCapture: {
      async capture() {
        captures += 1;
        return Buffer.from("jpeg");
      },
      async preflight() {},
      close() {
        closes += 1;
      },
    },
  });

  capture.start();
  await delivered;
  capture.stop();
  assert.equal(captures, 1);
  assert.equal(closes, 1);
});

test("idle Windows preflight releases the worker immediately", async () => {
  let preflights = 0;
  let closes = 0;
  const capture = createCapture(options(), {
    platform: "win32",
    windowsCapture: {
      async capture() {
        return Buffer.from("jpeg");
      },
      async preflight() {
        preflights += 1;
      },
      close() {
        closes += 1;
      },
    },
  });

  await capture.preflight();
  assert.equal(preflights, 1);
  assert.equal(closes, 1);
});

test("a stopped Windows generation cannot deliver a stale frame after restart", async () => {
  let resolveFirst!: (frame: Buffer) => void;
  const firstFrame = new Promise<Buffer>((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const delivered: Buffer[] = [];
  let resolveDelivered!: () => void;
  const nextFrame = new Promise<void>((resolve) => {
    resolveDelivered = resolve;
  });
  const capture = createCapture(
    options((frame) => {
      delivered.push(frame);
      resolveDelivered();
    }),
    {
      platform: "win32",
      grabFrame: async () => {
        calls += 1;
        if (calls === 1) return firstFrame;
        return Buffer.from("new-generation");
      },
      grabRawFrame: async () => Buffer.alloc(0),
    },
  );

  capture.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  capture.stop();
  capture.start();
  resolveFirst(Buffer.from("stale-generation"));
  await nextFrame;
  capture.stop();

  assert.equal(calls, 2);
  assert.deepEqual(delivered, [Buffer.from("new-generation")]);
});

test("Windows worker scales during StretchBlt and never serializes frame base64", () => {
  const worker = readFileSync("windows/capture-worker.ps1", "utf8");
  assert.match(worker, /StretchBlt/);
  assert.match(worker, /GetBuffer\(\)/);
  assert.doesNotMatch(worker, /ToBase64String|FromBase64String|GetTempPath/);
});
