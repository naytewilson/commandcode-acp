/**
 * Minimal crash-safe persistence for ACP->cmd session bindings.
 * Only what is necessary for reliable continuation across bridge-process
 * restarts (daemon reload, client reconnect). No credentials, no prompts,
 * no transcripts: just ids + run options. File mode 0600.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PersistedBinding {
  cmdSessionId: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  mode: string;
  updatedAt: number;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stateFile(): string {
  const dir =
    process.env["BRIDGE_STATE_DIR"]?.trim() ||
    join(homedir(), ".commandcode", "acp-bridge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "sessions.json");
}

type Table = Record<string, PersistedBinding>;
type Reverse = Record<string, { acp: string; updatedAt: number }>;

interface StateFile {
  bindings: Table;
  /** cmd transcript id -> ACP id (lets a new bridge process adopt a
   * transcript first seen by a different bridge process on this host). */
  byCmd: Reverse;
}

const MAX_REVERSE = 500;

function readState(): StateFile {
  try {
    const f = stateFile();
    if (!existsSync(f)) return { bindings: {}, byCmd: {} };
    const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<StateFile> & Table;
    // Back-compat: v1 file was a bare bindings table.
    const bindings = (raw["bindings"] ?? raw) as Table;
    const byCmd = (raw["byCmd"] ?? {}) as Reverse;
    if (typeof bindings !== "object" || bindings === null) return { bindings: {}, byCmd: {} };
    const now = Date.now();
    const out: Table = {};
    for (const [k, v] of Object.entries(bindings)) {
      if (
        v &&
        typeof v.cmdSessionId === "string" &&
        typeof v.updatedAt === "number" &&
        now - v.updatedAt < MAX_AGE_MS
      ) {
        out[k] = v;
      }
    }
    const rev: Reverse = {};
    if (typeof byCmd === "object" && byCmd !== null) {
      for (const [k, v] of Object.entries(byCmd)) {
        if (v && typeof v.acp === "string" && typeof v.updatedAt === "number" && now - v.updatedAt < MAX_AGE_MS) {
          rev[k] = v;
        }
      }
    }
    return { bindings: out, byCmd: rev };
  } catch {
    return { bindings: {}, byCmd: {} };
  }
}

function writeState(s: StateFile): void {
  const f = stateFile();
  writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {
    // best effort
  }
}

export function loadBinding(acpSessionId: string): PersistedBinding | null {
  return readState().bindings[acpSessionId] ?? null;
}

/** ACP id that first recorded this cmd transcript (cross-process adopt). */
export function loadAcpForCmd(cmdSessionId: string): string | null {
  return readState().byCmd[cmdSessionId]?.acp ?? null;
}

export function saveBinding(acpSessionId: string, b: PersistedBinding): void {
  try {
    const s = readState();
    s.bindings[acpSessionId] = b;
    s.byCmd[b.cmdSessionId] = { acp: acpSessionId, updatedAt: b.updatedAt };
    const keys = Object.keys(s.byCmd);
    if (keys.length > MAX_REVERSE) {
      const sorted = keys.sort((a, c) => s.byCmd[a]!.updatedAt - s.byCmd[c]!.updatedAt);
      for (const k of sorted.slice(0, keys.length - MAX_REVERSE)) delete s.byCmd[k];
    }
    writeState(s);
  } catch {
    // persistence is best-effort; in-memory map still works
  }
}

export function dropBinding(acpSessionId: string): void {
  try {
    const s = readState();
    const b = s.bindings[acpSessionId];
    delete s.bindings[acpSessionId];
    if (b) {
      for (const [k, v] of Object.entries(s.byCmd)) {
        if (v.acp === acpSessionId && k === b.cmdSessionId) delete s.byCmd[k];
      }
    }
    writeState(s);
  } catch {
    // ignore
  }
}
