import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

const PROTOCOL_VERSION = 1;
const MAX_HEADER_BYTES = 64 * 1024;
// MAX_WIDTH allows an explicitly requested 8K frame. A noisy quality-100 JPEG
// can exceed 32 MiB, so keep the protocol bound large enough for valid config
// while still refusing unbounded allocations from a malformed worker.
const MAX_JPEG_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type WindowsCaptureOptions = {
  jpegQuality: number;
  scale: number;
  maxWidth: number;
  displayId?: number;
};

export type WindowsCaptureBackend = {
  capture: (options: WindowsCaptureOptions) => Promise<Buffer>;
  preflight: (options: WindowsCaptureOptions) => Promise<void>;
  close: () => void;
};

export type WindowsCaptureProcess = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: () => boolean;
};

type WindowsCaptureDependencies = {
  spawnWorker?: () => WindowsCaptureProcess;
  timeoutMs?: number;
};

type WorkerRequest = WindowsCaptureOptions & {
  v: number;
  id: number;
  op: "capture" | "probe";
};

type WorkerResponse = {
  v: number;
  id: number;
  ok: boolean;
  length?: number;
  mime?: string;
  error?: string;
  code?: string;
};

type PendingRequest = {
  id: number;
  op: WorkerRequest["op"];
  resolve: (payload: Buffer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class ChunkReader {
  private chunks: Buffer[] = [];
  private firstOffset = 0;
  available = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.available += chunk.length;
  }

  read(length: number): Buffer | null {
    if (length < 0 || this.available < length) return null;
    if (length === 0) return Buffer.alloc(0);

    const first = this.chunks[0];
    const firstAvailable = first.length - this.firstOffset;
    if (firstAvailable >= length) {
      const result = first.subarray(this.firstOffset, this.firstOffset + length);
      this.firstOffset += length;
      this.available -= length;
      if (this.firstOffset === first.length) {
        this.chunks.shift();
        this.firstOffset = 0;
      }
      return result;
    }

    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[0];
      const count = Math.min(length - written, chunk.length - this.firstOffset);
      chunk.copy(result, written, this.firstOffset, this.firstOffset + count);
      written += count;
      this.firstOffset += count;
      this.available -= count;
      if (this.firstOffset === chunk.length) {
        this.chunks.shift();
        this.firstOffset = 0;
      }
    }
    return result;
  }
}

function workerScriptPath(): string {
  return fileURLToPath(new URL("../windows/capture-worker.ps1", import.meta.url));
}

function spawnDefaultWorker(): WindowsCaptureProcess {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot) {
    throw new Error("Windows system root is unavailable");
  }
  const powershell = join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      workerScriptPath(),
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function validateOptions(options: WindowsCaptureOptions): void {
  if (
    !Number.isFinite(options.jpegQuality) ||
    options.jpegQuality < 1 ||
    options.jpegQuality > 100 ||
    !Number.isFinite(options.scale) ||
    options.scale <= 0 ||
    options.scale > 1 ||
    !Number.isInteger(options.maxWidth) ||
    options.maxWidth < 1 ||
    (options.displayId !== undefined &&
      (!Number.isInteger(options.displayId) || options.displayId < 0))
  ) {
    throw new Error("Invalid Windows capture options");
  }
}

class WindowsCaptureWorker {
  private readonly reader = new ChunkReader();
  private readonly process: WindowsCaptureProcess;
  private readonly timeoutMs: number;
  private pending: PendingRequest | null = null;
  private nextId = 1;
  private expectedHeaderLength: number | null = null;
  private responseHeader: WorkerResponse | null = null;
  private stderrTail = "";
  closed = false;

  constructor(process: WindowsCaptureProcess, timeoutMs: number) {
    this.process = process;
    this.timeoutMs = timeoutMs;
    process.stdout.on("data", (chunk: Buffer | string) => {
      this.reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.parseResponses();
    });
    process.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_096);
    });
    process.once("error", (error: Error) => {
      this.fail(new Error(`Windows capture worker failed: ${error.message}`));
    });
    process.once(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.closed) return;
        const detail = this.stderrTail.trim();
        const suffix = detail ? `: ${detail}` : "";
        this.fail(
          new Error(
            `Windows capture worker exited (code=${code ?? "none"}, signal=${signal ?? "none"})${suffix}`,
          ),
        );
      },
    );
  }

  request(
    op: WorkerRequest["op"],
    options: WindowsCaptureOptions,
  ): Promise<Buffer> {
    validateOptions(options);
    if (this.closed) {
      return Promise.reject(new Error("Windows capture worker is closed"));
    }
    if (this.pending) {
      return Promise.reject(new Error("Windows capture is already in use"));
    }

    const id = this.nextId++;
    const request: WorkerRequest = {
      v: PROTOCOL_VERSION,
      id,
      op,
      jpegQuality: options.jpegQuality,
      scale: options.scale,
      maxWidth: options.maxWidth,
      ...(options.displayId === undefined
        ? {}
        : { displayId: options.displayId }),
    };
    const header = Buffer.from(JSON.stringify(request), "utf8");
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32LE(header.length, 0);
    const packet = Buffer.concat([prefix, header]);

    return new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.fail(new Error("Windows capture worker timed out"));
      }, this.timeoutMs);
      timeout.unref();
      this.pending = { id, op, resolve, reject, timeout };
      this.process.stdin.write(packet, (error) => {
        if (error && this.pending?.id === id) {
          this.fail(
            new Error(`Could not write to Windows capture worker: ${error.message}`),
          );
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Windows capture worker stopped"));
    }
    this.process.kill();
  }

  private parseResponses(): void {
    try {
      while (!this.closed) {
        if (!this.responseHeader) {
          if (this.expectedHeaderLength === null) {
            const prefix = this.reader.read(4);
            if (!prefix) return;
            const length = prefix.readUInt32LE(0);
            if (length === 0 || length > MAX_HEADER_BYTES) {
              throw new Error(
                "Windows capture worker sent an invalid header length",
              );
            }
            this.expectedHeaderLength = length;
          }

          const encoded = this.reader.read(this.expectedHeaderLength);
          if (!encoded) return;
          this.expectedHeaderLength = null;
          let value: unknown;
          try {
            value = JSON.parse(encoded.toString("utf8"));
          } catch {
            throw new Error("Windows capture worker sent invalid JSON");
          }
          if (!value || typeof value !== "object") {
            throw new Error("Windows capture worker sent an invalid response");
          }
          this.responseHeader = value as WorkerResponse;
        }

        const response = this.responseHeader;
        const length = response.length ?? 0;
        if (
          response.v !== PROTOCOL_VERSION ||
          !Number.isSafeInteger(response.id) ||
          typeof response.ok !== "boolean" ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_JPEG_BYTES
        ) {
          throw new Error("Windows capture worker sent an invalid response");
        }
        const payload = this.reader.read(length);
        if (!payload) return;
        this.responseHeader = null;

        const pending = this.pending;
        if (!pending || pending.id !== response.id) {
          throw new Error("Windows capture worker response was out of sequence");
        }

        if (!response.ok) {
          this.pending = null;
          clearTimeout(pending.timeout);
          const code = response.code ? `${response.code}: ` : "";
          pending.reject(
            new Error(`${code}${response.error ?? "Windows screen capture failed"}`),
          );
          continue;
        }
        if (pending.op === "probe" && payload.length !== 0) {
          throw new Error("Windows capture probe returned unexpected image data");
        }
        if (
          pending.op === "capture" &&
          (response.mime !== "image/jpeg" ||
            payload.length < 4 ||
            payload[0] !== 0xff ||
            payload[1] !== 0xd8 ||
            payload[payload.length - 2] !== 0xff ||
            payload[payload.length - 1] !== 0xd9)
        ) {
          throw new Error("Windows capture worker returned an invalid JPEG");
        }
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.resolve(payload);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.process.kill();
  }
}

export function createWindowsCaptureBackend(
  dependencies: WindowsCaptureDependencies = {},
): WindowsCaptureBackend {
  const spawnWorker = dependencies.spawnWorker ?? spawnDefaultWorker;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let worker: WindowsCaptureWorker | null = null;

  function getWorker(): WindowsCaptureWorker {
    if (!worker || worker.closed) {
      worker = new WindowsCaptureWorker(spawnWorker(), timeoutMs);
    }
    return worker;
  }

  return {
    capture(options) {
      return getWorker().request("capture", options);
    },
    async preflight(options) {
      await getWorker().request("probe", options);
    },
    close() {
      worker?.close();
      worker = null;
    },
  };
}
