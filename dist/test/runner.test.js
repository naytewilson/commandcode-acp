import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCmdArgs, CmdRunError, runCmdTurn } from "../src/runner.js";
const here = dirname(fileURLToPath(import.meta.url));
// fake-cmd.mjs is a plain node script (not compiled); resolve it from source.
const FAKE = join(here, "..", "..", "test", "helpers", "fake-cmd.mjs");
const SID = "11111111-2222-4333-8444-555555555555";
describe("runner", () => {
    before(() => {
        chmodSync(FAKE, 0o755);
    });
    afterEach(() => {
        delete process.env["SCENARIO"];
        delete process.env["CAPTURE_FILE"];
    });
    it("buildCmdArgs: default is fail-closed (no --yolo, no --plan)", () => {
        const a = buildCmdArgs({ promptText: "hi", mode: "default" });
        assert.ok(a.includes("-p") && a.includes("--output-format"));
        assert.ok(!a.includes("--yolo") && !a.includes("--dangerously-skip-permissions"));
        assert.ok(!a.includes("--plan") && !a.includes("--auto-accept"));
    });
    it("buildCmdArgs: resume/model/effort/mode flags", () => {
        const a = buildCmdArgs({
            promptText: "hi",
            mode: "plan",
            resumeCmdSessionId: "s1",
            model: "m1",
            effort: "low",
        });
        assert.ok(a.includes("--resume") && a.includes("s1"));
        assert.ok(a.includes("--model") && a.includes("m1"));
        assert.ok(a.includes("--effort") && a.includes("low"));
        assert.ok(a.includes("--plan"));
        const b = buildCmdArgs({ promptText: "hi", mode: "auto-accept" });
        assert.ok(b.includes("--auto-accept") && !b.includes("--yolo"));
    });
    it("success path streams updates, counts unknown+malformed, binds session", async () => {
        process.env["SCENARIO"] = "success";
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const texts = [];
        const { promise } = runCmdTurn({
            cmdBin: FAKE,
            cwd: dir,
            promptText: "hi",
            mode: "default",
            onUpdate: (u) => {
                if (u.sessionUpdate === "agent_message_chunk")
                    texts.push(u.content.text);
            },
            onLog: () => { },
            signal: { cancelled: false },
        });
        const out = await promise;
        assert.equal(out.stopReason, "end_turn");
        assert.equal(out.cmdSessionId, SID);
        assert.deepEqual(texts, ["hel", "lo"]);
        assert.equal(out.unknownEventCount, 1);
        assert.equal(out.malformedLineCount, 1);
    });
    it("resume id is passed through to the child argv", async () => {
        process.env["SCENARIO"] = "success";
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const cap = join(dir, "argv.json");
        process.env["CAPTURE_FILE"] = cap;
        const { promise } = runCmdTurn({
            cmdBin: FAKE,
            cwd: dir,
            promptText: "again",
            mode: "default",
            resumeCmdSessionId: "resume-me",
            onUpdate: () => { },
            onLog: () => { },
            signal: { cancelled: false },
        });
        await promise;
        const argv = JSON.parse(readFileSync(cap, "utf8"));
        assert.ok(argv.includes("--resume") && argv.includes("resume-me"));
    });
    it("exit 3 classifies as auth (not generic failure)", async () => {
        process.env["SCENARIO"] = "authfail";
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const { promise } = runCmdTurn({
            cmdBin: FAKE,
            cwd: dir,
            promptText: "hi",
            mode: "default",
            onUpdate: () => { },
            onLog: () => { },
            signal: { cancelled: false },
        });
        await assert.rejects(promise, (e) => {
            if (!(e instanceof CmdRunError))
                assert.fail("expected CmdRunError");
            assert.equal(e.classification, "commandcode:auth");
            assert.equal(e.exitCode, 3);
            assert.equal(e.cmdSessionId, SID);
            return true;
        });
    });
    it("missing result line fails closed (never claims success)", async () => {
        process.env["SCENARIO"] = "noresult";
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const { promise } = runCmdTurn({
            cmdBin: FAKE,
            cwd: dir,
            promptText: "hi",
            mode: "default",
            onUpdate: () => { },
            onLog: () => { },
            signal: { cancelled: false },
        });
        await assert.rejects(promise, (e) => {
            if (!(e instanceof CmdRunError))
                assert.fail("expected CmdRunError");
            assert.equal(e.classification, "commandcode:general-error");
            assert.match(e.message, /no result line/);
            return true;
        });
    });
    it("cancel terminates the child and reports cancelled (exit 130 path)", async () => {
        process.env["SCENARIO"] = "sleep";
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const signal = { cancelled: false };
        const { promise, cancel } = runCmdTurn({
            cmdBin: FAKE,
            cwd: dir,
            promptText: "hi",
            mode: "default",
            onUpdate: () => { },
            onLog: () => { },
            signal,
        });
        const started = Date.now();
        await new Promise((r) => setTimeout(r, 300));
        await cancel();
        const out = await promise;
        assert.equal(out.stopReason, "cancelled");
        assert.ok(Date.now() - started < 20000, "bounded shutdown");
    });
    it("unavailable binary classifies distinctly", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cc-acp-"));
        const { promise } = runCmdTurn({
            cmdBin: "/nonexistent/cmd-binary-xyz",
            cwd: dir,
            promptText: "hi",
            mode: "default",
            onUpdate: () => { },
            onLog: () => { },
            signal: { cancelled: false },
        });
        await assert.rejects(promise, (e) => {
            if (!(e instanceof CmdRunError))
                assert.fail("expected CmdRunError");
            assert.equal(e.classification, "commandcode:unavailable");
            return true;
        });
    });
});
