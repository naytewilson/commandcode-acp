/**
 * Explicit ACP session <-> Command Code session mapping.
 * No global "latest session": every bridge session is keyed by its own
 * ACP session id, owns at most one child process, and never resumes a
 * transcript it was not explicitly bound to.
 */
import { randomUUID } from "node:crypto";
import type { SessionMode } from "./runner.js";

export interface BridgeSession {
  acpSessionId: string;
  cmdSessionId: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  mode: SessionMode;
  active: { cancel: () => Promise<void>; cancelled: boolean } | null;
}

export class SessionStore {
  private readonly map = new Map<string, BridgeSession>();

  create(cwd: string, defaultModel: string | null): BridgeSession {
    const s: BridgeSession = {
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
  makeRestored(
    acpSessionId: string,
    cmdSessionId: string | null,
    cwd: string,
    model: string | null,
    effort: string | null,
    mode: SessionMode,
  ): BridgeSession {
    const s: BridgeSession = { acpSessionId, cmdSessionId, cwd, model, effort, mode, active: null };
    this.map.set(acpSessionId, s);
    return s;
  }

  get(acpSessionId: string): BridgeSession | undefined {
    return this.map.get(acpSessionId);
  }

  delete(acpSessionId: string): void {
    this.map.delete(acpSessionId);
  }

  size(): number {
    return this.map.size;
  }
}
