/**
 * Faithful mapping of `cmd -p` process exit codes.
 * Source: https://commandcode.ai/docs/headless (Exit Codes) + live probes.
 * 0/1/3 observed live on Neo 2026-09-03. 130 observed live via SIGTERM.
 * 4/5/6/7/8/9/10 per official docs (8=max_turns, 7 seen live on transient 5xx).
 */
export const EXIT_INTERRUPTED = 130;
export const CANCEL_SHUTDOWN_MS = 5000;
export function classifyExitCode(code) {
    switch (code) {
        case 0:
            return "success";
        case 1:
            return "general-error";
        case 3:
            return "auth";
        case 4:
            return "permission";
        case 5:
            return "rate-limit";
        case 6:
            return "network";
        case 7:
            return "server";
        case 8:
            return "max-turns";
        case 9:
            return "no-response";
        case 10:
            return "insufficient-credits";
        case EXIT_INTERRUPTED:
            return "interrupted";
        default:
            return "unknown";
    }
}
/** ACP stopReason for terminal cmd outcomes. `null` means "raise as error". */
export function stopReasonForClassification(c) {
    switch (c) {
        case "success":
            return "end_turn";
        case "max-turns":
            return "max_turn_requests";
        case "interrupted":
            return "cancelled";
        default:
            return null;
    }
}
export function describeClassification(c) {
    return `commandcode:${c}`;
}
