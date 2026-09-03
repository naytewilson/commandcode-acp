import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFinalResult, parseCmdLine } from "../src/cmdEvents.js";
describe("cmd NDJSON parsing", () => {
    it("parses event and result frames", () => {
        const ev = parseCmdLine('{"type":"event","event":{"type":"text_delta","delta":"hi"}}');
        assert.ok(ev && ev.type === "event");
        const res = parseCmdLine('{"type":"result","subtype":"success","sessionId":"abc"}');
        assert.ok(isFinalResult(res));
        assert.equal(res.sessionId, "abc");
    });
    it("blank lines are null", () => {
        assert.equal(parseCmdLine(""), null);
        assert.equal(parseCmdLine("   \n"), null);
    });
    it("malformed JSON throws (fail-closed accounting upstream)", () => {
        assert.throws(() => parseCmdLine("{not json"), SyntaxError);
    });
    it("unknown frame type throws (never silently accepted)", () => {
        assert.throws(() => parseCmdLine('{"type":"mystery"}'), /unknown cmd NDJSON frame type/);
    });
});
