/**
 * Spawns one `cmd -p` headless turn, parses NDJSON incrementally
 * line-by-line (never buffers the whole stream), forwards mapped ACP
 * updates, and resolves with the terminal outcome.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CANCEL_SHUTDOWN_MS, classifyExitCode, describeClassification, stopReasonForClassification } from "./exitCodes.js";
import { isFinalResult, parseCmdLine } from "./cmdEvents.js";
import { DIAGNOSTIC_EVENTS, mapCmdEvent } from "./eventMap.js";
export class CmdRunError extends Error {
    classification;
    exitCode;
    cmdSessionId;
    constructor(classification, message, exitCode, cmdSessionId) {
        super(message);
        this.name = "CmdRunError";
        this.classification = classification;
        this.exitCode = exitCode;
        this.cmdSessionId = cmdSessionId;
    }
}
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export function buildCmdArgs(o) {
    const args = ["-p", o.promptText, "--output-format", "json", "--no-auto-update", "--trust"];
    if (o.resumeCmdSessionId)
        args.push("--resume", o.resumeCmdSessionId);
    if (o.model)
        args.push("--model", o.model);
    if (o.effort)
        args.push("--effort", o.effort);
    if (typeof o.maxTurns === "number" && Number.isFinite(o.maxTurns) && o.maxTurns > 0) {
        args.push("--max-turns", String(Math.floor(o.maxTurns)));
    }
    switch (o.mode) {
        case "plan":
            args.push("--plan");
            break;
        case "auto-accept":
            args.push("--auto-accept");
            break;
        case "default":
            break;
    }
    return args;
}
export function runCmdTurn(opts) {
    let child;
    let settled = false;
    const state = {
        cmdSessionId: undefined,
        unknownEventCount: 0,
        malformedLineCount: 0,
        totalBytes: 0,
        finalResult: null,
        runError: null,
    };
    const onUpdate = opts.onUpdate;
    const onLog = opts.onLog;
    const promise = new Promise((resolve, reject) => {
        const args = buildCmdArgs({
            promptText: opts.promptText,
            resumeCmdSessionId: opts.resumeCmdSessionId,
            model: opts.model,
            effort: opts.effort,
            mode: opts.mode,
            maxTurns: opts.maxTurns,
        });
        onLog("debug", `spawn cmd argc=${args.length} cwd_len=${opts.cwd.length} resume=${opts.resumeCmdSessionId ? "yes" : "no"} model=${opts.model ?? "(default)"} mode=${opts.mode}`);
        child = spawn(opts.cmdBin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
        const proc = child;
        const pid = proc.pid;
        onLog("info", `cmd child pid=${pid ?? "unknown"}`);
        let stderrTail = "";
        proc.stderr?.on("data", (chunk) => {
            const s = chunk.toString("utf8");
            stderrTail = (stderrTail + s).slice(-4000);
        });
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
            try {
                state.totalBytes += Buffer.byteLength(line, "utf8");
                if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
                    state.malformedLineCount += 1;
                    onLog("warn", "oversize NDJSON line skipped (fail-closed accounting)");
                    return;
                }
                if (state.totalBytes > MAX_TOTAL_BYTES) {
                    onLog("warn", "NDJSON byte cap exceeded; terminating child");
                    proc.kill("SIGTERM");
                    finish(new CmdRunError("commandcode:general-error", "cmd NDJSON stream exceeded byte cap", null, state.cmdSessionId));
                    return;
                }
                const parsed = parseCmdLine(line);
                if (parsed === null)
                    return;
                if (isFinalResult(parsed)) {
                    state.finalResult = parsed;
                    if (parsed.sessionId)
                        state.cmdSessionId = parsed.sessionId;
                    return;
                }
                const ev = parsed.event;
                const outcome = mapCmdEvent(ev.type, ev);
                if (outcome.runStartSessionId && !state.cmdSessionId) {
                    state.cmdSessionId = outcome.runStartSessionId;
                }
                if (!outcome.recognized && !DIAGNOSTIC_EVENTS.has(ev.type)) {
                    state.unknownEventCount += 1;
                    onLog("debug", `unknown cmd event ignored: ${ev.type}`);
                }
                for (const u of outcome.updates)
                    onUpdate(u);
            }
            catch (err) {
                state.malformedLineCount += 1;
                onLog("warn", `malformed NDJSON line skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        const finish = (err, outcome) => {
            if (settled)
                return;
            settled = true;
            try {
                rl.close();
            }
            catch {
                // ignore
            }
            if (err)
                reject(err);
            else
                resolve(outcome);
        };
        const onExit = (code, signal) => {
            void signal;
            const wasCancelled = opts.signal?.cancelled === true;
            onLog("info", `cmd child exited code=${code} cancelled=${wasCancelled} final=${state.finalResult?.subtype ?? "none"}`);
            if (wasCancelled || code === 130) {
                // Interruption is not failure. Keep cmdSessionId when known; the
                // transcript may or may not be resumable (live evidence: SIGTERM
                // mid-first-turn left no .jsonl -> resume fails closed at cmd).
                finish(undefined, {
                    stopReason: "cancelled",
                    cmdSessionId: state.cmdSessionId,
                    unknownEventCount: state.unknownEventCount,
                    malformedLineCount: state.malformedLineCount,
                });
                return;
            }
            const classification = classifyExitCode(code);
            if (state.finalResult) {
                const r = state.finalResult;
                if (r.subtype === "success") {
                    finish(undefined, {
                        stopReason: "end_turn",
                        cmdSessionId: r.sessionId ?? state.cmdSessionId,
                        unknownEventCount: state.unknownEventCount,
                        malformedLineCount: state.malformedLineCount,
                    });
                    return;
                }
                if (r.subtype === "max_turns") {
                    finish(undefined, {
                        stopReason: "max_turn_requests",
                        cmdSessionId: r.sessionId ?? state.cmdSessionId,
                        unknownEventCount: state.unknownEventCount,
                        malformedLineCount: state.malformedLineCount,
                    });
                    return;
                }
                const stop = stopReasonForClassification(classification);
                if (stop === "cancelled") {
                    finish(undefined, {
                        stopReason: "cancelled",
                        cmdSessionId: r.sessionId ?? state.cmdSessionId,
                        unknownEventCount: state.unknownEventCount,
                        malformedLineCount: state.malformedLineCount,
                    });
                    return;
                }
                const msg = (r.error || stderrTail || `cmd failed (exit ${code})`).slice(0, 2000);
                finish(new CmdRunError(describeClassification(classification), msg, code, r.sessionId ?? state.cmdSessionId));
                return;
            }
            // No final result line: fail closed (never claim success).
            const stop = stopReasonForClassification(classification);
            if (stop !== null && classification !== "success") {
                // e.g. exit 8 with no result line, or 130 handled above
                finish(undefined, {
                    stopReason: stop,
                    cmdSessionId: state.cmdSessionId,
                    unknownEventCount: state.unknownEventCount,
                    malformedLineCount: state.malformedLineCount,
                });
                return;
            }
            const msg = `${stderrTail || `cmd exited ${code}`} (no result line)`.slice(0, 2000);
            finish(new CmdRunError(describeClassification(classification), msg, code, state.cmdSessionId));
        };
        proc.on("error", (err) => {
            // Spawn failure: Command Code unavailable. Classify, never misreport.
            onLog("warn", `cmd spawn failed: ${err.message}`);
            finish(new CmdRunError("commandcode:unavailable", `Command Code CLI unavailable: ${err.message}`.slice(0, 1000), null));
        });
        proc.on("exit", (code, signal) => {
            const w = { code, signal };
            void w;
            // Wait a tick so trailing stdout lines flush through readline.
            setImmediate(() => onExit(code, signal));
        });
    });
    const cancel = async () => {
        const proc = child;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null)
            return;
        if (opts.signal)
            opts.signal.cancelled = true;
        onLog("info", `session/cancel -> SIGTERM pid=${proc.pid ?? "unknown"}`);
        proc.kill("SIGTERM");
        const exited = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), CANCEL_SHUTDOWN_MS);
            proc.once("exit", () => {
                clearTimeout(t);
                resolve(true);
            });
        });
        if (!exited && proc.exitCode === null) {
            onLog("warn", "child ignored SIGTERM; SIGKILL");
            try {
                proc.kill("SIGKILL");
            }
            catch {
                // already gone
            }
        }
    };
    return { promise, cancel };
}
