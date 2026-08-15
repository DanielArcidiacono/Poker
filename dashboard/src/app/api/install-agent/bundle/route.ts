import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".env.example",
  ".npmrc",
  "src",
  "public",
  "scripts",
  "launchd",
];

function findAgentRoot(): string | null {
  const candidates = [
    process.env.AGENT_SOURCE_PATH?.trim(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd()),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, "package.json")) &&
      existsSync(path.join(candidate, "src", "server.ts")) &&
      existsSync(path.join(candidate, "scripts", "install-agent.sh"))
    ) {
      return candidate;
    }
  }
  return null;
}

export async function GET() {
  const root = findAgentRoot();
  if (!root) {
    return NextResponse.json(
      {
        error:
          "Agent source is not available on this host. Run the dashboard from the Poker monorepo, or push the full project to GitHub.",
      },
      { status: 503 },
    );
  }

  const present = AGENT_FILES.filter((name) =>
    existsSync(path.join(root, name)),
  );
  if (!present.includes("package.json") || !present.includes("src")) {
    return NextResponse.json(
      { error: "Agent package is incomplete on this host." },
      { status: 503 },
    );
  }

  const child = spawn("tar", ["-czf", "-", ...present], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

  const code: number | null = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  if (code !== 0) {
    return NextResponse.json(
      {
        error: "Failed to package agent.",
        detail: Buffer.concat(errors).toString("utf8"),
      },
      { status: 500 },
    );
  }

  const body = Buffer.concat(chunks);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="screen-viewer-agent.tgz"',
      "Cache-Control": "no-store",
      "Content-Length": String(body.length),
    },
  });
}
