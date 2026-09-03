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
