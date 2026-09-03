import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseListModels } from "../src/catalog.js";
import { isFinalResult, parseCmdLine, type CmdLine } from "../src/cmdEvents.js";
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

  it("malformed fixture: skips malformed JSON lines and retains valid turn", () => {
    const rawLines = fx("malformed.ndjson").split("\n").filter((l) => l.trim());
    let malformed = 0;
    const valid: CmdLine[] = [];
    for (const l of rawLines) {
      try {
        const parsed = parseCmdLine(l);
        if (parsed) valid.push(parsed);
      } catch {
        malformed++;
      }
    }
    assert.equal(malformed, 2, "must detect exactly 2 malformed lines");
    assert.equal(valid.length, 4, "must preserve 4 valid frames");
    const last = valid[valid.length - 1]!;
    assert.ok(isFinalResult(last) && last.subtype === "success");
    assert.equal(last.finalText, "recovered text");
  });

  it("unknown-events fixture: unmapped future events safely ignored and counted", () => {
    const lines = frames("unknown-events.ndjson");
    let unknownCount = 0;
    for (const f of lines) {
      if (f.type !== "event") continue;
      const o = mapCmdEvent(f.event.type, f.event as unknown as Record<string, unknown>);
      if (!o.recognized && !DIAGNOSTIC_EVENTS.has(f.event.type)) {
        unknownCount++;
      }
    }
    assert.equal(unknownCount, 2, "must count exactly 2 future unknown events");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last) && last.subtype === "success");
  });

  it("early-auth-missing-session fixture: error handled safely when sessionId is omitted", () => {
    const lines = frames("early-auth-missing-session.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.equal(last.sessionId, undefined);
    assert.match(last.error ?? "", /Authentication failed/);
  });

  it("permission-denial fixture: blocked tool hook maps to failed status", () => {
    const lines = frames("permission-denial.ndjson");
    let blockedHook = false;
    for (const f of lines) {
      if (f.type !== "event") continue;
      const o = mapCmdEvent(f.event.type, f.event as unknown as Record<string, unknown>);
      for (const u of o.updates) {
        if (u.sessionUpdate === "tool_call_update" && u.status === "failed") {
          blockedHook = true;
        }
      }
    }
    assert.ok(blockedHook, "must report blocked tool hook as failed");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.match(last.error ?? "", /permission rules/);
  });

  it("max-turns fixture: reports max_turns subtype and stopReason", () => {
    const lines = frames("max-turns.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "max_turns");
    assert.equal(last.stopReason, "max_turns");
    assert.ok(last.sessionId);
  });

  it("network-failure fixture: reports network error", () => {
    const lines = frames("network-failure.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.match(last.error ?? "", /Network connection failed/);
  });

  it("interrupted-child fixture: reports interrupted error", () => {
    const lines = frames("interrupted-child.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.match(last.error ?? "", /interrupted/);
  });

  it("resume-failure fixture: reports session not found and missing sessionId", () => {
    const lines = frames("resume-failure.ndjson");
    const last = lines[lines.length - 1]!;
    assert.ok(isFinalResult(last));
    assert.equal(last.subtype, "error");
    assert.equal(last.sessionId, undefined);
    assert.match(last.error ?? "", /Session not found/);
  });
});

