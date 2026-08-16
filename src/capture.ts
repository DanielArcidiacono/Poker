import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type sharpModule from "sharp";

export type CaptureOptions = {
  fps: number;
  jpegQuality: number;
  scale: number;
  maxWidth: number;
  displayId?: number;
  onFrame: (jpeg: Buffer) => void;
};

export type CaptureController = {
  start: () => void;
  stop: () => void;
  preflight: () => Promise<void>;
};

type SharpModule = typeof sharpModule;

type CaptureDependencies = {
  grabRawFrame?: (options: CaptureOptions) => Promise<Buffer>;
  grabFrame?: (options: CaptureOptions) => Promise<Buffer>;
  now?: () => number;
};

const execFileAsync = promisify(execFile);
const capturePath = join(tmpdir(), `prostar-${process.pid}.jpg`);
let sharpPromise: Promise<SharpModule> | null = null;

function loadSharp(): Promise<SharpModule> {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((module) => {
      const sharp = module.default as SharpModule;
      // A live stream only ever processes one frame at a time. Keep libvips'
      // cache deliberately small instead of retaining tens of megabytes while
      // the viewer is idle.
      sharp.cache({ memory: 16, files: 0, items: 8 });
      sharp.concurrency(1);
      return sharp;
    });
  }
  return sharpPromise;
}

async function grabRawFrame(options: CaptureOptions): Promise<Buffer> {
  const args = ["-x", "-r", "-t", "jpg"];
  if (options.displayId === undefined) args.push("-m");
  else args.push(`-D${options.displayId + 1}`);
  args.push(capturePath);

  // macOS-only app: call the system capture tool directly. The previous
  // dependency also ran system_profiler and created one file per preceding
  // display on every frame.
  await rm(capturePath, { force: true });
  try {
    await execFileAsync("/usr/sbin/screencapture", args, { timeout: 10_000 });
    const raw = await readFile(capturePath);
    if (raw.length === 0) throw new Error("Screen capture returned no image");
    return raw;
  } finally {
    await rm(capturePath, { force: true }).catch(() => undefined);
  }
}

async function grabFrame(options: CaptureOptions): Promise<Buffer> {
  const raw = await grabRawFrame(options);

  // Load once, on the first viewer. A broken sharp install therefore does not
  // prevent the lightweight control plane from keeping the Mac online.
  const sharp = await loadSharp();

  let pipeline = sharp(raw);
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (width > 0 && height > 0) {
    const scaledWidth = Math.round(width * options.scale);
    const outputWidth = Math.max(
      1,
      Math.min(width, scaledWidth, options.maxWidth),
    );
    if (outputWidth < width) {
      pipeline = pipeline.resize({
        width: outputWidth,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
  }

  return pipeline
    // mozjpeg is designed for maximum offline compression and is needlessly
    // CPU-heavy for transient live frames. libjpeg-turbo is substantially
    // faster and the tunnel already transports compressed bytes.
    .jpeg({ quality: options.jpegQuality })
    .toBuffer();
}

export function createCapture(
  options: CaptureOptions,
  dependencies: CaptureDependencies = {},
): CaptureController {
  const intervalMs = Math.max(50, Math.round(1000 / options.fps));
  const captureRaw = dependencies.grabRawFrame ?? grabRawFrame;
  const captureFrame = dependencies.grabFrame ?? grabFrame;
  const now = dependencies.now ?? (() => performance.now());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let busy = false;
  let consecutiveErrors = 0;
  let lastSuccessfulCaptureAt = 0;

  async function tick(): Promise<void> {
    if (!running) return;
    if (busy) {
      timer = setTimeout(() => void tick(), 50);
      return;
    }
    busy = true;

    try {
      const jpeg = await captureFrame(options);
      lastSuccessfulCaptureAt = now();
      consecutiveErrors = 0;
      if (running) options.onFrame(jpeg);
    } catch (err) {
      consecutiveErrors += 1;
      if (consecutiveErrors <= 3 || consecutiveErrors % 20 === 0) {
        console.error(
          `[capture] frame error (${consecutiveErrors}x):`,
          err instanceof Error ? err.message : err,
        );
        if (consecutiveErrors === 1) {
          console.error(
            "[capture] If this persists, grant Screen Recording to your Node binary in System Settings → Privacy & Security → Screen Recording, then restart.",
          );
        }
      }
    } finally {
      busy = false;
      if (running) {
        const delay =
          consecutiveErrors > 0
            ? Math.min(10000, intervalMs * Math.min(consecutiveErrors, 10))
            : intervalMs;
        timer = setTimeout(() => {
          void tick();
        }, delay);
      }
    }
  }

  return {
    async preflight() {
      if (busy) {
        // A live viewer may already be using the single-frame capture slot.
        // A frame captured moments ago is stronger evidence than starting a
        // second capture and prevents setup from polling on a false 503.
        const age = now() - lastSuccessfulCaptureAt;
        if (age >= 0 && age < 5_000) return;
        throw new Error("Screen capture is already in use");
      }
      busy = true;
      try {
        await captureRaw(options);
        lastSuccessfulCaptureAt = now();
      } finally {
        busy = false;
      }
    },
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function loadCaptureEnv(): Omit<CaptureOptions, "onFrame"> {
  const fps = Number(process.env.FPS ?? "8");
  const jpegQuality = Number(process.env.JPEG_QUALITY ?? "60");
  const scale = Number(process.env.SCALE ?? "0.5");
  const maxWidth = Number(process.env.MAX_WIDTH ?? "1920");
  const displayRaw = process.env.DISPLAY_ID;
  const displayId =
    displayRaw === undefined || displayRaw === ""
      ? undefined
      : Number(displayRaw);

  return {
    fps: Number.isFinite(fps) && fps > 0 ? fps : 8,
    jpegQuality:
      Number.isFinite(jpegQuality) && jpegQuality >= 1 && jpegQuality <= 100
        ? jpegQuality
        : 60,
    scale: Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 0.5,
    maxWidth:
      Number.isFinite(maxWidth) && maxWidth >= 320 && maxWidth <= 7680
        ? Math.round(maxWidth)
        : 1920,
    displayId:
      displayId !== undefined &&
      Number.isInteger(displayId) &&
      displayId >= 0
        ? displayId
        : undefined,
  };
}
