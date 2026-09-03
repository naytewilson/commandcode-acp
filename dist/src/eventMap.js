/**
 * Pure mapping: Command Code AgentEvent -> ACP session/update payloads.
 * No I/O. Unit-tested against sanitized live fixtures in test/fixtures/.
 *
 * Supported inputs (observed live on cmd v1.15.1, Neo 2026-09-03):
 *   text_delta, thinking_delta,
 *   tool_queued, tool_running, tool_completed, tool_hook_blocked,
 *   message_update{content:[tool_use,...]},
 *   run_start (early cmd session id), run_error (remembered, terminal
 *   result line still decides the outcome).
 * Everything else (notice, turn_*, message_start/end, model_request_*,
 * model_trace, api_retry, run_end, message_update text/thinking bodies)
 * is diagnostic-only. Unknown future types are counted and ignored.
 */
const READ_TOOLS = new Set([
    "read_file",
    "read_directory",
    "glob",
    "grep",
    "search",
    "read",
    "list",
]);
const EDIT_TOOLS = new Set(["edit_file", "write_file", "apply_patch", "edit", "write"]);
const EXEC_TOOLS = new Set(["shell_command", "shell", "bash", "run_command", "execute"]);
export function mapToolKind(toolName) {
    const n = toolName.toLowerCase();
    if (READ_TOOLS.has(n))
        return "read";
    if (EDIT_TOOLS.has(n))
        return "edit";
    if (EXEC_TOOLS.has(n))
        return "execute";
    if (n.includes("delete") || n.includes("remove"))
        return "delete";
    if (n.includes("search") || n.includes("grep") || n.includes("glob") || n.includes("find"))
        return "search";
    if (n.includes("fetch") || n.includes("web"))
        return "fetch";
    return "other";
}
function str(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
/** Map one parsed event frame. Never throws on unknown shapes. */
export function mapCmdEvent(eventType, event) {
    switch (eventType) {
        case "text_delta": {
            const delta = str(event["delta"]);
            if (delta === undefined)
                return { updates: [], recognized: true };
            return {
                updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }],
                recognized: true,
            };
        }
        case "thinking_delta": {
            const delta = str(event["delta"]);
            if (delta === undefined)
                return { updates: [], recognized: true };
            return {
                updates: [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } }],
                recognized: true,
            };
        }
        case "tool_queued":
        case "tool_running": {
            const toolCallId = str(event["toolCallId"]);
            const toolName = str(event["toolName"]) ?? "tool";
            if (!toolCallId)
                return { updates: [], recognized: true };
            const updates = [
                {
                    sessionUpdate: "tool_call",
                    toolCallId,
                    title: str(event["description"]) ?? toolName,
                    kind: mapToolKind(toolName),
                    status: eventType === "tool_running" ? "in_progress" : "pending",
                    rawInput: event["input"] ?? undefined,
                },
            ];
            return { updates, recognized: true };
        }
        case "tool_completed": {
            const toolCallId = str(event["toolCallId"]);
            if (!toolCallId)
                return { updates: [], recognized: true };
            return {
                updates: [
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status: "completed",
                        title: str(event["toolName"]),
                        rawOutput: event["result"] ?? undefined,
                    },
                ],
                recognized: true,
            };
        }
        case "tool_hook_blocked": {
            // Permission engine denied the tool (fail-closed headless default).
            const toolCallId = str(event["toolCallId"]);
            if (!toolCallId)
                return { updates: [], recognized: true };
            return {
                updates: [
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status: "failed",
                        title: `${str(event["toolName"]) ?? "tool"} blocked by permission rules`,
                        rawOutput: event["hookOutput"] ?? undefined,
                    },
                ],
                recognized: true,
            };
        }
        case "message_update": {
            const content = event["content"];
            if (!Array.isArray(content))
                return { updates: [], recognized: true };
            const updates = [];
            for (const block of content) {
                if (typeof block === "object" &&
                    block !== null &&
                    block["type"] === "tool_use") {
                    const b = block;
                    const id = str(b["id"]);
                    const name = str(b["name"]) ?? "tool";
                    if (!id)
                        continue;
                    updates.push({
                        sessionUpdate: "tool_call",
                        toolCallId: id,
                        title: name,
                        kind: mapToolKind(name),
                        status: "pending",
                        rawInput: b["input"] ?? undefined,
                    });
                }
            }
            return { updates, recognized: true };
        }
        case "run_start": {
            const sid = str(event["sessionId"]);
            return { updates: [], recognized: true, runStartSessionId: sid };
        }
        default:
            return { updates: [], recognized: false };
    }
}
/** Event types that are known diagnostics (recognized, never forwarded). */
export const DIAGNOSTIC_EVENTS = new Set([
    "notice",
    "run_start",
    "turn_start",
    "turn_end",
    "message_start",
    "message_end",
    "message_update",
    "model_request_start",
    "model_request_end",
    "model_trace",
    "api_retry",
    "thinking_start",
    "thinking_end",
    "run_end",
    "run_error",
]);
