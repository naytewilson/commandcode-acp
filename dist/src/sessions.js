/**
 * Explicit ACP session <-> Command Code session mapping.
 * No global "latest session": every bridge session is keyed by its own
 * ACP session id, owns at most one child process, and never resumes a
 * transcript it was not explicitly bound to.
 */
import { randomUUID } from "node:crypto";
export class SessionStore {
    map = new Map();
    create(cwd, defaultModel) {
        const s = {
            acpSessionId: randomUUID(),
            cmdSessionId: null,
            cwd,
            model: defaultModel,
            effort: null,
            mode: "default",
            active: null,
        };
        this.map.set(s.acpSessionId, s);
        return s;
    }
    /** Bind a fresh ACP session to an existing cmd transcript id. */
    makeRestored(acpSessionId, cmdSessionId, cwd, model, effort, mode) {
        const s = { acpSessionId, cmdSessionId, cwd, model, effort, mode, active: null };
        this.map.set(acpSessionId, s);
        return s;
    }
    get(acpSessionId) {
        return this.map.get(acpSessionId);
    }
    delete(acpSessionId) {
        this.map.delete(acpSessionId);
    }
    size() {
        return this.map.size;
    }
}
