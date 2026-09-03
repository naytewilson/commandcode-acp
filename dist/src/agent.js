/**
 * commandcode-acp: ACP v1 stdio agent fronting `cmd -p --output-format json`.
 *
 * Lifecycle:
 *   initialize      -> truthful capabilities (loadSession:true, no images)
 *   session/new     -> allocate bridge session (no cmd process yet)
 *   session/prompt  -> spawn one cmd turn; stream session/update; completion
 *   session/cancel  -> SIGTERM owned child, bounded shutdown, cancelled
 *   session/load    -> rebind known ACP id, or bind explicit cmd session id
 *   session/set_mode / session/set_config_option -> per-session run options
 *
 * Stdout is the ACP transport. All logs go to stderr. Auth material,
 * environment values, and prompt contents are never logged.
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { BRIDGE_VERSION, MODES } from "./version.js";
import { discoverCatalog } from "./catalog.js";
import { loadAcpForCmd, loadBinding, saveBinding } from "./persist.js";
import { SessionStore } from "./sessions.js";
import { CmdRunError, runCmdTurn } from "./runner.js";
const CMD_BIN = process.env["COMMANDCODE_BIN"]?.trim() || "cmd";
const LOG_LEVEL = (process.env["BRIDGE_LOG"] ?? "info").toLowerCase();
const LEVELS = ["debug", "info", "warn"];
function log(level, msg) {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(LEVELS.includes(LOG_LEVEL) ? LOG_LEVEL : "info"))
        return;
    process.stderr.write(`[commandcode-acp:${level}] ${msg}\n`);
}
function cmdVersion() {
    return new Promise((resolve) => {
        const child = execFile(CMD_BIN, ["--version"], { timeout: 15000 }, (err, stdout) => {
            if (err) {
                resolve("unknown");
                return;
            }
            const first = stdout.trim().split("\n")[0]?.trim() ?? "";
            resolve(/^\d+\.\d+\.\d+/.test(first) ? first : "unknown");
        });
        child.stdin?.end();
    });
}
let catalog = { models: [] };
let catalogReady = false;
async function ensureCatalog() {
    if (catalogReady)
        return;
    try {
        catalog = await discoverCatalog(CMD_BIN);
    }
    catch (err) {
        log("warn", `model catalog discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        catalog = { models: [] };
    }
    catalogReady = true;
    log("info", `catalog models=${catalog.models.length} default=${catalog.defaultModel ?? "none"}`);
}
function modelOptions() {
    return catalog.models.slice(0, 200).map((m) => ({
        value: m.id,
        name: m.label,
        ...(m.description ? { description: m.description } : {}),
    }));
}
function sessionConfigOptions(session) {
    const opts = [];
    if (catalog.models.length > 0) {
        opts.push({
            id: "model",
            type: "select",
            name: "Model",
            description: "Command Code model for subsequent turns (exact cmd model id).",
            category: "model",
            currentValue: session.model ?? catalog.defaultModel ?? catalog.models[0].id,
            options: modelOptions(),
        });
    }
    return opts;
}
function modeState(session) {
    return {
        currentModeId: session.mode,
        availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })),
    };
}
const sessions = new SessionStore();
let activeCancel = null;
function requireSession(id) {
    const s = sessions.get(id);
    if (!s)
        throw new acp.RequestError(-32602, `unknown ACP session: ${id}`);
    return s;
}
function promptTextOf(prompt) {
    const parts = [];
    for (const b of prompt) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim())
            parts.push(b.text);
        else if (b.type !== "text")
            log("warn", `unsupported prompt block ignored: ${b.type}`);
    }
    const text = parts.join("\n").trim();
    if (!text)
        throw new acp.RequestError(-32602, "prompt requires non-empty text");
    return text;
}
async function handlePrompt(params, cx) {
    try {
        fs.appendFileSync("/tmp/commandcode-acp-stdio.log", `[HANDLE_PROMPT] sessionId=${params.sessionId}\n`);
    }
    catch { }
    const session = requireSession(params.sessionId);
    if (session.active)
        throw new acp.RequestError(-32600, "a turn is already running on this session");
    const text = promptTextOf(params.prompt);
    const cancelled = { cancelled: false };
    const { promise, cancel } = runCmdTurn({
        cmdBin: CMD_BIN,
        cwd: session.cwd,
        promptText: text,
        resumeCmdSessionId: session.cmdSessionId ?? undefined,
        model: session.model ?? undefined,
        effort: session.effort ?? undefined,
        mode: session.mode,
        onUpdate: (u) => {
            void cx.notify(acp.methods.client.session.update, { sessionId: session.acpSessionId, update: u }).catch((err) => {
                log("warn", `session/update notify failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        },
        onLog: (level, msg) => log(level, msg),
        signal: cancelled,
    });
    session.active = { cancel, cancelled: false };
    activeCancel = cancel;
    try {
        const outcome = await promise;
        if (outcome.cmdSessionId) {
            session.cmdSessionId = outcome.cmdSessionId;
            saveBinding(session.acpSessionId, {
                cmdSessionId: outcome.cmdSessionId,
                cwd: session.cwd,
                model: session.model,
                effort: session.effort,
                mode: session.mode,
                updatedAt: Date.now(),
            });
        }
        log("info", `turn done stop=${outcome.stopReason} unknown_events=${outcome.unknownEventCount} malformed=${outcome.malformedLineCount}`);
        return { stopReason: outcome.stopReason };
    }
    catch (err) {
        if (err instanceof CmdRunError) {
            // Adopt the cmd id only when the turn succeeded earlier or a binding
            // already existed. A failed turn's run_start id is NOT resumable
            // (live PROVEN: 500-error and SIGTERM transcripts have no .jsonl, and
            // `cmd --resume` rejects them). Adopting it would poison the next
            // turn, so a binding-less session stays null and restarts fresh.
            if (err.cmdSessionId && session.cmdSessionId) {
                session.cmdSessionId = err.cmdSessionId;
            }
            throw new acp.RequestError(err.classification === "commandcode:auth" ? -32000 : -32603, `${err.classification}: ${err.message}`, { classification: err.classification, exitCode: err.exitCode });
        }
        throw err;
    }
    finally {
        session.active = null;
        activeCancel = null;
    }
}
export function buildAgent() {
    return (acp
        .agent({ name: "commandcode-acp" })
        .onRequest("initialize", async (ctx) => {
        await ensureCatalog();
        const version = catalog.cmdVersion ?? "unknown";
        log("info", `initialize protocol=${ctx.params.protocolVersion} cmd=${version}`);
        return {
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            // Lets capability probes (e.g. T3's initialize-only health check)
            // read models + modes without opening a session.
            _meta: {
                ...(catalog.models.length > 0
                    ? {
                        modelState: {
                            currentModelId: catalog.defaultModel ?? catalog.models[0].id,
                            availableModels: catalog.models.slice(0, 200).map((m) => ({
                                modelId: m.id,
                                name: m.label,
                                ...(m.description ? { description: m.description } : {}),
                            })),
                        },
                    }
                    : {}),
                modeState: {
                    currentModeId: "default",
                    availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })),
                },
            },
        };
    })
        // biome-ignore lint: authenticate is a passthrough; cmd owns credentials.
        .onRequest("authenticate", async () => {
        await ensureCatalog();
        return {};
    })
        .onRequest("session/new", async (ctx) => {
        try {
            fs.appendFileSync("/tmp/commandcode-acp-stdio.log", `[SESSION_NEW] params=${JSON.stringify(ctx.params)}\n`);
        }
        catch { }
        await ensureCatalog();
        const p = ctx.params;
        const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : process.cwd();
        const s = sessions.create(cwd, catalog.defaultModel ?? null);
        log("info", `session/new acp=${s.acpSessionId} cwd_len=${cwd.length}`);
        try {
            fs.appendFileSync("/tmp/commandcode-acp-stdio.log", `[SESSION_NEW_DONE] acp=${s.acpSessionId}\n`);
        }
        catch { }
        return { sessionId: s.acpSessionId, modes: modeState(s), configOptions: sessionConfigOptions(s) };
    })
        .onRequest("session/load", async (ctx) => {
        await ensureCatalog();
        const p = ctx.params;
        const id = typeof p.sessionId === "string" ? p.sessionId : "";
        const existing = sessions.get(id);
        if (existing) {
            if (typeof p.cwd === "string" && p.cwd.trim())
                existing.cwd = p.cwd;
            log("info", `session/load rebound acp=${id}`);
            return { modes: modeState(existing), configOptions: sessionConfigOptions(existing) };
        }
        // Restart/reconnect: rebind a persisted ACP id from disk.
        const persisted = loadBinding(id);
        if (persisted) {
            const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : persisted.cwd;
            const mode = persisted.mode === "plan" || persisted.mode === "auto-accept" ? persisted.mode : "default";
            const s = sessions.makeRestored(id, persisted.cmdSessionId, cwd, persisted.model ?? catalog.defaultModel ?? null, persisted.effort, mode);
            log("info", `session/load restored persisted acp=${id}`);
            return { modes: modeState(s), configOptions: sessionConfigOptions(s) };
        }
        // Otherwise the id may be an explicit Command Code transcript id
        // (this is how T3 resumes: resumeCursor carries the cmd session id).
        // Only honor it when this host has actually seen that transcript;
        // otherwise start fresh (self-healing after failed first turns)
        // instead of spawning a doomed `cmd --resume` (exit 1, PROVEN live).
        if (!id.trim())
            throw new acp.RequestError(-32602, "session/load requires a session id");
        const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : process.cwd();
        if (loadAcpForCmd(id.trim())) {
            const s = sessions.makeRestored(id.trim(), id.trim(), cwd, catalog.defaultModel ?? null, null, "default");
            log("info", `session/load adopted known transcript id=${id.trim().slice(0, 8)}...`);
            return { modes: modeState(s), configOptions: sessionConfigOptions(s) };
        }
        const fresh = sessions.makeRestored(id.trim(), null, cwd, catalog.defaultModel ?? null, null, "default");
        log("warn", `session/load unknown id; keyed fresh session id=${id.trim().slice(0, 8)}...`);
        return { modes: modeState(fresh), configOptions: sessionConfigOptions(fresh) };
    })
        .onRequest("session/set_mode", async (ctx) => {
        const p = ctx.params;
        const s = requireSession(String(p.sessionId ?? ""));
        const modeId = String(p.modeId ?? "");
        if (modeId !== "default" && modeId !== "plan" && modeId !== "auto-accept") {
            throw new acp.RequestError(-32602, `unknown mode: ${modeId} (expected default|plan|auto-accept)`);
        }
        s.mode = modeId;
        log("info", `session/set_mode acp=${s.acpSessionId} mode=${modeId}`);
        return {};
    })
        .onRequest("session/set_config_option", async (ctx) => {
        const p = ctx.params;
        const s = requireSession(String(p.sessionId ?? ""));
        const configId = String(p.configId ?? "");
        if (configId === "model") {
            if (typeof p.value !== "string" || !p.value.trim()) {
                throw new acp.RequestError(-32602, "model value must be a non-empty string");
            }
            s.model = p.value.trim();
            log("info", `model set len=${s.model.length}`);
            return { configOptions: sessionConfigOptions(s) };
        }
        if (configId === "effort") {
            if (typeof p.value !== "string" || !p.value.trim()) {
                throw new acp.RequestError(-32602, "effort value must be a non-empty string");
            }
            s.effort = p.value.trim();
            return { configOptions: sessionConfigOptions(s) };
        }
        throw new acp.RequestError(-32602, `unknown config option: ${configId}`);
    })
        .onRequest("session/prompt", (ctx) => handlePrompt(ctx.params, ctx.client))
        .onNotification("session/cancel", async (ctx) => {
        const p = ctx.params;
        const s = sessions.get(String(p.sessionId ?? ""));
        if (s?.active) {
            await s.active.cancel();
        }
        else if (activeCancel) {
            await activeCancel();
        }
    }));
}
import * as fs from "node:fs";
export async function serve() {
    const logFile = "/tmp/commandcode-acp-stdio.log";
    const debug = (msg) => {
        try {
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
        }
        catch { }
    };
    debug(`serve() started pid=${process.pid} cmd=${CMD_BIN}`);
    const input = Writable.toWeb(process.stdout);
    const output = Readable.toWeb(process.stdin);
    const stream = acp.ndJsonStream(input, output);
    const conn = buildAgent().connect(stream);
    log("info", `commandcode-acp v${BRIDGE_VERSION} serving on stdio (cmd=${CMD_BIN})`);
    debug("agent connected to stream, awaiting closed");
    try {
        await conn.closed;
        debug("connection closed cleanly");
    }
    catch (err) {
        debug(`connection closed with error: ${err}`);
    }
}
