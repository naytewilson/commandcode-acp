#!/usr/bin/env node
/** Fake `cmd` for deterministic runner tests. Scenario via SCENARIO env. */
import { writeFileSync } from "node:fs";

const scenario = process.env["SCENARIO"] ?? "success";
const capture = process.env["CAPTURE_FILE"];
if (capture) {
  writeFileSync(capture, JSON.stringify(process.argv.slice(2)));
}
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SID = "11111111-2222-4333-8444-555555555555";
// Deterministic catalog discovery for the fallback-model reasoning tests.
// Gated on SCENARIO so all other scenarios keep today's behavior (unknown
// args exit 2, catalog stays empty): status reports NO default model while
// --list-models succeeds with one reasoning-capable model (via the cli.mjs
// fixture next to this fake) and one model without capabilities.
const argv = process.argv.slice(2);
if (argv[0] === "status" && scenario === "list-reasoning") {
  emit({ version: "9.9.9-test" });
  process.exit(0);
}
if (argv[0] === "--list-models" && scenario === "list-reasoning") {
  process.stdout.write(
    "meta/muse-spark-1.3-test  Test reasoning model\nmeta/plain-test  Test model without capabilities\n",
  );
  process.exit(0);
}

if (scenario === "success") {
  emit({ type: "event", event: { type: "run_start", sessionId: SID } });
  emit({ type: "event", event: { type: "text_delta", delta: "hel" } });
  emit({ type: "event", event: { type: "widget_from_future", x: 1 } });
  process.stdout.write("{oops not json\n");
  emit({ type: "event", event: { type: "text_delta", delta: "lo" } });
  emit({ type: "result", subtype: "success", sessionId: SID, stopReason: "end_turn", usage: {}, durationMs: 1, finalText: "hello" });
  process.exit(0);
} else if (scenario === "authfail") {
  emit({ type: "event", event: { type: "run_start", sessionId: SID } });
  emit({ type: "result", subtype: "error", sessionId: SID, usage: {}, durationMs: 1, finalText: "", error: 'Error: Authentication failed. Please run "cmd login" first.' });
  process.exit(3);
} else if (scenario === "noresult") {
  process.stderr.write("Error: something broke\n");
  process.exit(1);
} else if (scenario === "sleep") {
  process.on("SIGTERM", () => process.exit(130));
  setInterval(() => {}, 60000);
  await new Promise(() => {});
} else {
  process.stderr.write(`unknown scenario ${scenario}\n`);
  process.exit(2);
}
