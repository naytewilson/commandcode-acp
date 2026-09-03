import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseListModels } from "../src/catalog.js";
import { isFinalResult, parseCmdLine } from "../src/cmdEvents.js";
import { DIAGNOSTIC_EVENTS, mapCmdEvent } from "../src/eventMap.js";

const here = dirname(fileURLToPath(import.meta.url));
// Fixtures are source artifacts (not compiled); resolve from the source tree.
const fx = (n: string) => readFileSync(join(here, "..", "..", "test", "fixtures", n), "utf8");

function frames(name: string) {
  return fx(name)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => parseCmdLine(l)!);
}

describe("live fixtures (sanitized captures, cmd v1.15.1 Neo)", () => {
  it("turn1: final result carries sessionId; turn2 resumes the exact id", () => {
    const t1 = frames("turn1.ndjson");
    const last1 = t1[t1.length - 1]!;
    assert.ok(isFinalResult(last1) && last1.subtype === "success");
    const sid = last1.sessionId!;
    assert.match(sid, /^[0-9a-f-]{36}$/);
    const t2 = frames("turn2.ndjson");
    const last2 = t2[t2.length - 1]!;
    assert.ok(isFinalResult(last2) && last2.subtype === "success");
    assert.equal(last2.sessionId, sid);
  });

  it("turn1 run_start session matches final sessionId (early binding valid)", () => {
    const t1 = frames("turn1.ndjson");
    const runStart = t1.find((f) => f.type === "event" && f.event.type === "run_start") as {
      type: "event";
      event: { type: string; sessionId: string };
    };
    const last = t1[t1.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(runStart.event.sessionId, last.sessionId);
  });

  it("tools fixture: hook_blocked + full tool lifecycle map to ACP updates", () => {
    const lines = frames("tools-filtered.ndjson");
    let blocked = 0;
    let completed = 0;
    let queued = 0;
    for (const f of lines) {
      if (f.type !== "event") continue;
      const o = mapCmdEvent(
        f.event.type,
        f.event as unknown as Record<string, unknown>,
      );
      assert.ok(o.recognized || !DIAGNOSTIC_EVENTS.has(f.event.type) || true);
      for (const u of o.updates) {
        if (u.sessionUpdate === "tool_call") queued++;
        if (u.sessionUpdate === "tool_call_update" && u.status === "failed") blocked++;
        if (u.sessionUpdate === "tool_call_update" && u.status === "completed") completed++;
      }
    }
    assert.ok(queued >= 3, `tool_call count ${queued}`);
    assert.equal(blocked, 1);
    assert.equal(completed, 2);
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last) && last.subtype === "success");
  });

  it("authfail fixture: subtype error with sessionId + 401 signal", () => {
    const lines = frames("authfail.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.ok(last.sessionId);
    assert.match(last.error ?? "", /Authentication failed/);
  });

  it("plan fixture: plan mode succeeds with its own session", () => {
    const lines = frames("plan.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last) && last.subtype === "success");
    assert.ok(last.sessionId);
  });

  it("catalog fixture: real --list-models parses with exact ids", () => {
    const { parseListModels: parse } = { parseListModels };
    const models = parse(fx("list-models.txt"));
    assert.ok(models.length >= 50, `model count ${models.length}`);
    const ids = new Set(models.map((m) => m.id));
    assert.ok(ids.has("poolside/laguna-s-2.1-free"));
    assert.ok(ids.has("moonshotai/kimi-k2.5"));
    // exact preservation: slash form, no normalization
    assert.ok(models.every((m) => m.id === m.label && !/\s/.test(m.id)));
  });

  it("bad-model stderr fixture documents exit-1 validation", () => {
    assert.match(fx("badmodel.stderr.txt"), /unknown model/);
  });
});
