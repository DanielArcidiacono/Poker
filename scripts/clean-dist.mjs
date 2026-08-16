#!/usr/bin/env node

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, "dist");
if (dirname(dist) !== projectRoot) {
  throw new Error("Refusing to clean an unexpected build directory");
}
rmSync(dist, { force: true, recursive: true });
