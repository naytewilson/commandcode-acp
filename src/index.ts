#!/usr/bin/env node
/** commandcode-acp entrypoint: stdio ACP agent, --version, --probe. */
import { BRIDGE_VERSION } from "./version.js";
import { serve } from "./agent.js";
import { discoverCatalog } from "./catalog.js";
import { execFile } from "node:child_process";

import * as fs from "node:fs";
try {
  fs.writeFileSync("/tmp/paseo-env.json", JSON.stringify(process.env, null, 2));
  fs.appendFileSync("/tmp/commandcode-acp-stdio.log", `[INDEX] pid=${process.pid} PATH=${process.env["PATH"]}\n`);
} catch {}

const CMD_BIN = process.env["COMMANDCODE_BIN"]?.trim() || "cmd";
const args = process.argv.slice(2);

function sh(bin: string, a: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, a, { timeout: 20000 }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({
        code: typeof code === "number" ? code : err ? 1 : 0,
        out: stdout ?? "",
        err: stderr ?? "",
      });
    });
  });
}

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`commandcode-acp ${BRIDGE_VERSION}\n`);
  process.exit(0);
}

if (args.includes("--probe")) {
  // Machine-readable readiness probe. Never prints credentials.
  const [ver, status, catalog] = await Promise.all([
    sh(CMD_BIN, ["--version"]),
    sh(CMD_BIN, ["status", "--json"]),
    discoverCatalog(CMD_BIN).catch(() => ({ models: [], defaultModel: undefined as string | undefined, cmdVersion: undefined as string | undefined })),
  ]);
  let authenticated: boolean | null = null;
  let model: string | null = null;
  try {
    const s = JSON.parse(status.out) as { authenticated?: unknown; model?: unknown };
    authenticated = typeof s.authenticated === "boolean" ? s.authenticated : null;
    model = typeof s.model === "string" ? s.model : null;
  } catch {
    authenticated = null;
  }
  process.stdout.write(
    JSON.stringify({
      bridge: BRIDGE_VERSION,
      cmdBin: CMD_BIN,
      cmdVersion: ver.out.trim().split("\n")[0] ?? null,
      cmdExit: ver.code,
      authenticated,
      model,
      catalogModels: catalog.models.length,
      defaultModel: catalog.defaultModel ?? null,
    }) + "\n",
  );
  process.exit(ver.code === 0 ? 0 : 1);
}

await serve();
