import screenshot from "screenshot-desktop";

export type CaptureOptions = {
  fps: number;
  jpegQuality: number;
  scale: number;
  displayId?: number;
  wakeGapMs?: number;
  onWake?: () => void | Promise<void>;
  onFrame: (jpeg: Buffer) => void;
};

export type CaptureController = {
  start: () => void;
  stop: () => void;
  reinit: () => Promise<void>;
};

async function grabFrame(options: CaptureOptions): Promise<Buffer> {
  const raw = await screenshot({
    format: "png",
    screen: options.displayId,
  });

  // Dynamic import so a broken sharp install does not crash the whole agent
  // (control-plane heartbeats can still keep the Mac "online").
  const sharp = (await import("sharp")).default;

  let pipeline = sharp(raw);
  const meta = await pipeline.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (options.scale > 0 && options.scale < 1 && width > 0 && height > 0) {
    pipeline = pipeline.resize(
      Math.max(1, Math.round(width * options.scale)),
      Math.max(1, Math.round(height * options.scale)),
      { fit: "inside" },
    );
  }

  return pipeline
    .jpeg({ quality: options.jpegQuality, mozjpeg: true })
    .toBuffer();
}

export function createCapture(options: CaptureOptions): CaptureController {
  const intervalMs = Math.max(50, Math.round(1000 / options.fps));
  const wakeGapMs = options.wakeGapMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let busy = false;
  let lastTick = Date.now();
  let recovering = false;
  let consecutiveErrors = 0;

  async function recoverFromWake(): Promise<void> {
    if (recovering) return;
    recovering = true;
    console.log("[capture] wake/suspend gap detected; recovering");
    try {
      if (options.onWake) await options.onWake();
      await grabFrame(options);
    } catch (err) {
      console.error("[capture] wake recovery failed:", err);
    } finally {
      recovering = false;
    }
  }

  async function tick(): Promise<void> {
    if (!running || busy) return;
    busy = true;
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;

    try {
      if (gap > wakeGapMs) {
        await recoverFromWake();
      }
      const jpeg = await grabFrame(options);
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
    start() {
      if (running) return;
      running = true;
      lastTick = Date.now();
      void tick();
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async reinit() {
      await recoverFromWake();
    },
  };
}

export function loadCaptureEnv(): Omit<CaptureOptions, "onFrame" | "onWake"> {
  const fps = Number(process.env.FPS ?? "8");
  const jpegQuality = Number(process.env.JPEG_QUALITY ?? "60");
  const scale = Number(process.env.SCALE ?? "0.5");
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
    displayId:
      displayId !== undefined && Number.isFinite(displayId)
        ? displayId
        : undefined,
    wakeGapMs: 5000,
  };
}
