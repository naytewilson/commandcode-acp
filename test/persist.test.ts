import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropBinding, loadBinding, saveBinding } from "../src/persist.js";

describe("persist", () => {
  beforeEach(() => {
    process.env["BRIDGE_STATE_DIR"] = mkdtempSync(join(tmpdir(), "cc-state-"));
  });

  it("round-trips a binding without secrets", () => {
    saveBinding("acp-1", {
      cmdSessionId: "cmd-1",
      cwd: "/tmp/x",
      model: "m",
      effort: null,
      mode: "plan",
      updatedAt: Date.now(),
    });
    const b = loadBinding("acp-1");
    assert.equal(b?.cmdSessionId, "cmd-1");
    assert.equal(b?.mode, "plan");
    const raw = readFileSync(join(process.env["BRIDGE_STATE_DIR"]!, "sessions.json"), "utf8");
    assert.ok(!/api_?key|token|secret|password/i.test(raw.replace(/cmdSessionId/g, "")));
  });

  it("unknown id loads null; drop removes", () => {
    assert.equal(loadBinding("missing"), null);
    saveBinding("acp-2", { cmdSessionId: "c", cwd: "/", model: null, effort: null, mode: "default", updatedAt: Date.now() });
    dropBinding("acp-2");
    assert.equal(loadBinding("acp-2"), null);
  });

  it("expired bindings are ignored", () => {
    saveBinding("acp-3", { cmdSessionId: "c", cwd: "/", model: null, effort: null, mode: "default", updatedAt: Date.now() - 8 * 24 * 3600 * 1000 });
    assert.equal(loadBinding("acp-3"), null);
  });
});
