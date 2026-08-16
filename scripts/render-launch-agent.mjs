#!/usr/bin/env node

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [
  root,
  nodeBin,
  serverEntry,
  plistSource,
  plistDestination,
  logDir,
] = process.argv.slice(2);

if (
  !root ||
  !nodeBin ||
  !serverEntry ||
  !plistSource ||
  !plistDestination ||
  !logDir
) {
  throw new Error("render-launch-agent: missing required path argument");
}

function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const env = readEnv(`${root}/.env`);
const viewerPassword =
  env.PROSTAR_VIEWER_PASSWORD?.trim() || env.VIEWER_PASSWORD?.trim();
if (!viewerPassword || viewerPassword.length < 12) {
  throw new Error(
    "PROSTAR_VIEWER_PASSWORD in .env must contain at least 12 characters",
  );
}

const values = {
  NODE_BIN: nodeBin,
  SERVER_ENTRY: serverEntry,
  PROJECT_ROOT: root,
  LOG_DIR: logDir,
  PATH: `${dirname(nodeBin)}:${root}/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  PROSTAR_VIEWER_PASSWORD: viewerPassword,
  PORT: env.PORT || "8787",
  FPS: env.FPS || "8",
  JPEG_QUALITY: env.JPEG_QUALITY || "60",
  SCALE: env.SCALE || "0.5",
  MAX_WIDTH: env.MAX_WIDTH || "1920",
  AUTO_TUNNEL: env.AUTO_TUNNEL || "0",
  CONTROL_PLANE_URL: env.CONTROL_PLANE_URL || "",
  PROSTAR_CLIENT_ID: env.PROSTAR_CLIENT_ID || "",
  PROSTAR_AGENT_SECRET: env.PROSTAR_AGENT_SECRET || env.AGENT_TOKEN || "",
  PROSTAR_CLOUDFLARED_BIN:
    env.PROSTAR_CLOUDFLARED_BIN || `${dirname(nodeBin)}/cloudflared`,
};

let output = readFileSync(plistSource, "utf8");
for (const [key, value] of Object.entries(values)) {
  const placeholder = `__${key}__`;
  if (!output.includes(placeholder)) {
    throw new Error(`LaunchAgent template is missing ${placeholder}`);
  }
  output = output.replaceAll(placeholder, xml(value));
}
if (/__[A-Z0-9_]+__/.test(output)) {
  throw new Error("LaunchAgent template contains an unresolved placeholder");
}

writeFileSync(plistDestination, output, { mode: 0o600 });
chmodSync(plistDestination, 0o600);
