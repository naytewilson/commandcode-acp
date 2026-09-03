/**
 * In-process ACP lifecycle test: real SDK client <-> real bridge agent,
 * with `cmd` replaced by the deterministic fake. No network, no LLM.
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "..", "..", "test", "helpers", "fake-cmd.mjs");

describe("acp lifecycle (in-process)", () => {
  before(() => {
    chmodSync(FAKE, 0o755);
    process.env["COMMANDCODE_BIN"] = FAKE;
    // Never touch the real state dir from tests.
    process.env["BRIDGE_STATE_DIR"] = mkdtempSync(join(tmpdir(), "cc-state-test-"));
  });
  afterEach(() => {
    delete process.env["SCENARIO"];
  });

  async function loadAgent() {
    return await import("../src/agent.js");
  }

  function testClient(seen: Array<{ sessionUpdate: string }>) {
    return acp
      .client({ name: "lifecycle-test" })
      .onNotification("session/update", async (ctx) => {
        seen.push({ sessionUpdate: (ctx.params as { update: { sessionUpdate: string } }).update.sessionUpdate });
      });
  }

  it("initialize/new/prompt/complete streams chunks then end_turn", async () => {
    process.env["SCENARIO"] = "success";
    const agent = await loadAgent();
    const seen: Array<{ sessionUpdate: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), "cc-lc-"));
    await testClient(seen)
      .connectWith(agent.buildAgent(), async (ctx) => {
        const init = await ctx.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "t", version: "0" },
        });
        assert.equal(init.protocolVersion, 1);
        assert.equal(init.agentCapabilities?.loadSession, true);

        const ns = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        assert.match(ns.sessionId, /^[0-9a-f-]{36}$/);
        assert.equal(ns.modes?.currentModeId, "default");
        assert.ok((ns.modes?.availableModes ?? []).some((m) => m.id === "plan"));

        const res = await ctx.request("session/prompt", {
          sessionId: ns.sessionId,
          prompt: [{ type: "text", text: "hi" }],
        });
        assert.equal(res.stopReason, "end_turn");
        assert.ok(seen.some((s) => s.sessionUpdate === "agent_message_chunk"), JSON.stringify(seen));
      });
  });

  it("second prompt resumes the same cmd transcript (argv carries --resume)", async () => {
    process.env["SCENARIO"] = "success";
    const agent = await loadAgent();
    const dir = mkdtempSync(join(tmpdir(), "cc-lc-"));
    await testClient([])
      .connectWith(agent.buildAgent(), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "t", version: "0" } });
        const ns = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        const first = await ctx.request("session/prompt", { sessionId: ns.sessionId, prompt: [{ type: "text", text: "one" }] });
        assert.equal(first.stopReason, "end_turn");
        // Second turn on the same ACP session must succeed (fake always
        // succeeds; the resume wiring is asserted in runner tests via argv).
        const second = await ctx.request("session/prompt", { sessionId: ns.sessionId, prompt: [{ type: "text", text: "two" }] });
        assert.equal(second.stopReason, "end_turn");
      });
  });

  it("two sessions are isolated (no latest-session leakage)", async () => {
    process.env["SCENARIO"] = "success";
    const agent = await loadAgent();
    const dir = mkdtempSync(join(tmpdir(), "cc-lc-"));
    await testClient([])
      .connectWith(agent.buildAgent(), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "t", version: "0" } });
        const a = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        const b = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        assert.notEqual(a.sessionId, b.sessionId);
        const ra = await ctx.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "a" }] });
        const rb = await ctx.request("session/prompt", { sessionId: b.sessionId, prompt: [{ type: "text", text: "b" }] });
        assert.equal(ra.stopReason, "end_turn");
        assert.equal(rb.stopReason, "end_turn");
      });
  });

  it("set_mode plan + unknown mode rejected; unknown session rejected", async () => {
    process.env["SCENARIO"] = "success";
    const agent = await loadAgent();
    const dir = mkdtempSync(join(tmpdir(), "cc-lc-"));
    await testClient([])
      .connectWith(agent.buildAgent(), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "t", version: "0" } });
        const ns = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
        await ctx.request("session/set_mode", { sessionId: ns.sessionId, modeId: "plan" });
        await assert.rejects(ctx.request("session/set_mode", { sessionId: ns.sessionId, modeId: "yolo" }));
        await assert.rejects(ctx.request("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }));
        await assert.rejects(ctx.request("session/prompt", { sessionId: ns.sessionId, prompt: [{ type: "text", text: "   " }] }));
      });
  });

  it("session/load keys the session under the requested id", async () => {
    process.env["SCENARIO"] = "success";
    const agent = await loadAgent();
    const dir = mkdtempSync(join(tmpdir(), "cc-lc-"));
    // Unknown id -> fresh session keyed under the requested id; a prompt
    // with that id must work (self-healing after failed first turns).
    await testClient([])
      .connectWith(agent.buildAgent(), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "t", version: "0" } });
        const loaded = await ctx.request("session/load", {
          sessionId: "brand-new-acp-id",
          cwd: dir,
          mcpServers: [],
        });
        assert.equal(loaded.modes?.currentModeId, "default");
        const res = await ctx.request("session/prompt", {
          sessionId: "brand-new-acp-id",
          prompt: [{ type: "text", text: "hi" }],
        });
        assert.equal(res.stopReason, "end_turn");
      });
    // Known transcript id (seen via a prior success in another agent
    // instance sharing the state dir) -> adopted under the requested id.
    const agent2 = await loadAgent();
    await testClient([])
      .connectWith(agent2.buildAgent(), async (ctx) => {
        await ctx.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "t", version: "0" } });
        const loaded = await ctx.request("session/load", {
          sessionId: "11111111-2222-4333-8444-555555555555",
          cwd: dir,
          mcpServers: [],
        });
        assert.equal(loaded.modes?.currentModeId, "default");
        const res = await ctx.request("session/prompt", {
          sessionId: "11111111-2222-4333-8444-555555555555",
          prompt: [{ type: "text", text: "hi" }],
        });
        assert.equal(res.stopReason, "end_turn");
      });
  });
});
