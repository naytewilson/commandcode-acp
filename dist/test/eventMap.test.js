import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DIAGNOSTIC_EVENTS, mapCmdEvent, mapToolKind } from "../src/eventMap.js";
describe("event mapping", () => {
    it("text_delta -> agent_message_chunk", () => {
        const o = mapCmdEvent("text_delta", { type: "text_delta", delta: "DIS" });
        assert.equal(o.recognized, true);
        assert.deepEqual(o.updates, [
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DIS" } },
        ]);
    });
    it("thinking_delta -> agent_thought_chunk", () => {
        const o = mapCmdEvent("thinking_delta", { type: "thinking_delta", delta: "hmm" });
        assert.equal(o.updates[0]?.sessionUpdate, "agent_thought_chunk");
    });
    it("tool lifecycle maps with stable ids", () => {
        const q = mapCmdEvent("tool_queued", { type: "tool_queued", toolCallId: "c1", toolName: "read_directory", input: { path: "." } });
        assert.equal(q.updates[0]?.sessionUpdate, "tool_call");
        assert.equal(q.updates[0].status, "pending");
        assert.equal(q.updates[0].kind, "read");
        const r = mapCmdEvent("tool_running", { type: "tool_running", toolCallId: "c1", toolName: "read_directory" });
        assert.equal(r.updates[0].status, "in_progress");
        const c = mapCmdEvent("tool_completed", { type: "tool_completed", toolCallId: "c1", toolName: "read_directory", result: [{ type: "text", text: "ok" }] });
        assert.equal(c.updates[0]?.sessionUpdate, "tool_call_update");
        assert.equal(c.updates[0].status, "completed");
    });
    it("tool_hook_blocked -> failed update (fail-closed evidence)", () => {
        const o = mapCmdEvent("tool_hook_blocked", {
            type: "tool_hook_blocked",
            toolCallId: "c9",
            toolName: "shell_command",
            hookOutput: 'Error: Tool "shell_command" requires permissions.',
        });
        assert.equal(o.updates[0]?.sessionUpdate, "tool_call_update");
        assert.equal(o.updates[0].status, "failed");
    });
    it("tool_use blocks in message_update open tool calls", () => {
        const o = mapCmdEvent("message_update", {
            type: "message_update",
            content: [{ type: "text", text: "I'll list" }, { type: "tool_use", id: "t1", name: "glob", input: { pattern: "**/*" } }],
        });
        assert.equal(o.updates.length, 1);
        assert.equal(o.updates[0]?.sessionUpdate, "tool_call");
        assert.equal(o.updates[0].toolCallId, "t1");
    });
    it("run_start binds the cmd session id early", () => {
        const o = mapCmdEvent("run_start", { type: "run_start", sessionId: "s-1" });
        assert.equal(o.runStartSessionId, "s-1");
        assert.deepEqual(o.updates, []);
    });
    it("unknown future events are unrecognized (ignored, counted)", () => {
        const o = mapCmdEvent("fancy_future_widget", { type: "fancy_future_widget" });
        assert.equal(o.recognized, false);
        assert.deepEqual(o.updates, []);
    });
    it("tool kind mapping", () => {
        assert.equal(mapToolKind("shell_command"), "execute");
        assert.equal(mapToolKind("read_directory"), "read");
        assert.equal(mapToolKind("glob"), "read");
        assert.equal(mapToolKind("edit_file"), "edit");
        assert.equal(mapToolKind("something_new"), "other");
    });
    it("diagnostic set covers the observed stream", () => {
        for (const t of ["notice", "turn_start", "turn_end", "message_start", "message_end", "model_request_start", "model_request_end", "model_trace", "api_retry", "thinking_start", "thinking_end", "run_end", "run_error"]) {
            assert.ok(DIAGNOSTIC_EVENTS.has(t), t);
        }
    });
});
