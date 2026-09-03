import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyExitCode, stopReasonForClassification } from "../src/exitCodes.js";
describe("exit codes", () => {
    it("maps documented codes faithfully", () => {
        assert.equal(classifyExitCode(0), "success");
        assert.equal(classifyExitCode(1), "general-error");
        assert.equal(classifyExitCode(3), "auth");
        assert.equal(classifyExitCode(4), "permission");
        assert.equal(classifyExitCode(5), "rate-limit");
        assert.equal(classifyExitCode(6), "network");
        assert.equal(classifyExitCode(7), "server");
        assert.equal(classifyExitCode(8), "max-turns");
        assert.equal(classifyExitCode(9), "no-response");
        assert.equal(classifyExitCode(10), "insufficient-credits");
        assert.equal(classifyExitCode(130), "interrupted");
    });
    it("classifies unknown/null as unknown", () => {
        assert.equal(classifyExitCode(2), "unknown");
        assert.equal(classifyExitCode(143), "unknown");
        assert.equal(classifyExitCode(null), "unknown");
    });
    it("stop reasons: interruption is cancelled, never failure", () => {
        assert.equal(stopReasonForClassification("success"), "end_turn");
        assert.equal(stopReasonForClassification("max-turns"), "max_turn_requests");
        assert.equal(stopReasonForClassification("interrupted"), "cancelled");
        assert.equal(stopReasonForClassification("auth"), null);
        assert.equal(stopReasonForClassification("rate-limit"), null);
        assert.equal(stopReasonForClassification("unknown"), null);
    });
});
