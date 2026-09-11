/**
 * Fallback-model reasoning regression (controller defect, 2026-09-11):
 * when `cmd status --json` yields no default model but `--list-models`
 * succeeds, session/new must advertise the first catalog model's reasoning
 * efforts, and set_config_option must ACCEPT those exact advertised values
 * (previously it validated against session.model == null and rejected them).
 * In-process ACP against a cache-busted agent instance with the fake cmd
 * serving discovery plus the cli.mjs capability fixture. No network, no LLM.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "..", "..", "test", "helpers", "fake-cmd.mjs");
const SPARK_TEST = "meta/muse-spark-1.3-test";
const PLAIN_TEST = "meta/plain-test";

describe("fallback-model reasoning effort contract", () => {
  before(() => {
    chmodSync(FAKE, 0o755);
    process.env["COMMANDCODE_BIN"] = FAKE;
    // Never touch the real state dir from tests.
    process.env["BRIDGE_STATE_DIR"] = mkdtempSync(join(tmpdir(), "cc-effort-test-"));
    process.env["SCENARIO"] = "list-reasoning";
  });

  function testClient() {
    return acp.client({ name: "effort-config-test" });
  }

  // Cache-busted agent import: an isolated module instance so discovery
  // runs against this file's SCENARIO regardless of other test files
  // sharing this process. Computed URL keeps tsc happy (no static query).
  function loadAgentFresh(tag: string): Promise<{ buildAgent: () => any }> {
    const url = new URL("../src/agent.js", import.meta.url);
    return import(`${url.href}?${tag}`);
  }

  function optionValues(options: unknown, id: string): string[] {
    const list = (options ?? []) as Array<{ id?: string; options?: Array<{ value?: string }> }>;
    const found = list.find((o) => o.id === id);
    return (found?.options ?? []).map((o) => String(o.value));
  }

  function optionCurrent(options: unknown, id: string): string | undefined {
    const list = (options ?? []) as Array<{ id?: string; currentValue?: unknown }>;
    const found = list.find((o) => o.id === id);
    return typeof found?.currentValue === "string" ? found.currentValue : undefined;
  }

  it("advertises the first model's efforts with no default and accepts them", async () => {
    // Cache-busted import: isolated agent module state so discovery runs
    // against this file's SCENARIO regardless of other test files.
    const agent = await loadAgentFresh("effort-config");
    const { discoverCatalog } = await import("../src/catalog.js");
    const dir = mkdtempSync(join(tmpdir(), "cc-eff-"));

    // Defect preconditions, proven through the real discovery path:
    // models exist, the first carries confirmed efforts, no default model.
    const cat = await discoverCatalog(FAKE);
    assert.equal(cat.defaultModel, undefined);
    assert.ok(cat.models.length >= 1);
    assert.equal(cat.models[0]!.id, SPARK_TEST);
    assert.deepEqual(cat.models[0]!.capabilities?.reasoningEfforts, ["low", "high"]);

    await testClient().connectWith(agent.buildAgent(), async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "t", version: "0" },
      });
      // Fresh session: session.model is implicitly null.
      const ns = await ctx.request("session/new", { cwd: dir, mcpServers: [] });
      assert.equal(optionCurrent(ns.configOptions, "model"), SPARK_TEST);
      assert.deepEqual(optionValues(ns.configOptions, "effort"), ["low", "high"]);

      // The exact defect: this advertised value used to be rejected.
      const set = await ctx.request("session/set_config_option", {
        sessionId: ns.sessionId,
        configId: "effort",
        value: "high",
      });
      assert.equal(optionCurrent(set.configOptions, "effort"), "high");

      // The selected effort reaches the command invocation.
      const cap = join(dir, "argv.json");
      process.env["CAPTURE_FILE"] = cap;
      process.env["SCENARIO"] = "success";
      const res = await ctx.request("session/prompt", {
        sessionId: ns.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
      assert.equal(res.stopReason, "end_turn");
      const argv = JSON.parse(readFileSync(cap, "utf8")) as string[];
      const flag = argv.indexOf("--effort");
      assert.ok(flag >= 0 && argv[flag + 1] === "high", JSON.stringify(argv));
      delete process.env["CAPTURE_FILE"];
      process.env["SCENARIO"] = "list-reasoning";

      // An effort not advertised for that model is still rejected.
      await assert.rejects(
        ctx.request("session/set_config_option", {
          sessionId: ns.sessionId,
          configId: "effort",
          value: "max",
        }),
      );
    });
  });

  it("preserves explicit selection, switch-clear, no-metadata, full-access", async () => {
    const agent = await loadAgentFresh("effort-config-preserved");
    const dir = mkdtempSync(join(tmpdir(), "cc-eff-"));
    await testClient().connectWith(agent.buildAgent(), async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "t", version: "0" },
      });
      const ns = await ctx.request("session/new", { cwd: dir, mcpServers: [] });

      // Explicit model selection works and keeps a compatible effort.
      const picked = await ctx.request("session/set_config_option", {
        sessionId: ns.sessionId,
        configId: "model",
        value: SPARK_TEST,
      });
      assert.equal(optionCurrent(picked.configOptions, "model"), SPARK_TEST);
      await ctx.request("session/set_config_option", {
        sessionId: ns.sessionId,
        configId: "effort",
        value: "low",
      });

      // Switching to a model without that effort clears it, and with no
      // capability metadata no reasoning option is offered at all.
      const switched = await ctx.request("session/set_config_option", {
        sessionId: ns.sessionId,
        configId: "model",
        value: PLAIN_TEST,
      });
      assert.equal(optionCurrent(switched.configOptions, "model"), PLAIN_TEST);
      assert.deepEqual(optionValues(switched.configOptions, "effort"), []);
      const cap = join(dir, "argv2.json");
      process.env["CAPTURE_FILE"] = cap;
      process.env["SCENARIO"] = "success";
      const res = await ctx.request("session/prompt", {
        sessionId: ns.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
      assert.equal(res.stopReason, "end_turn");
      const argv = JSON.parse(readFileSync(cap, "utf8")) as string[];
      assert.ok(!argv.includes("--effort"), JSON.stringify(argv));

      // Full-access semantics unchanged: accepted and passed through.
      await ctx.request("session/set_mode", { sessionId: ns.sessionId, modeId: "full-access" });
      const cap2 = join(dir, "argv3.json");
      process.env["CAPTURE_FILE"] = cap2;
      const res2 = await ctx.request("session/prompt", {
        sessionId: ns.sessionId,
        prompt: [{ type: "text", text: "hi again" }],
      });
      assert.equal(res2.stopReason, "end_turn");
      const argv2 = JSON.parse(readFileSync(cap2, "utf8")) as string[];
      assert.ok(argv2.includes("--yolo"), JSON.stringify(argv2));
      delete process.env["CAPTURE_FILE"];
      process.env["SCENARIO"] = "list-reasoning";
    });
  });
});
