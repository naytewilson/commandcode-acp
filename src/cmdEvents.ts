/**
 * Narrow types for the `cmd -p --output-format json` NDJSON stream.
 * Only fields the bridge consumes are modeled; everything else passes
 * through as unknown. Unknown future `event.type` values are ignored
 * safely by the mapper (forward-compatibility requirement).
 */

export interface CmdUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CmdFinalResult {
  type: "result";
  subtype: "success" | "error" | "max_turns" | string;
  sessionId?: string;
  stopReason?: string;
  usage?: CmdUsage;
  durationMs?: number;
  finalText?: string;
  error?: string;
}

export interface CmdEventFrame {
  type: "event";
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export type CmdLine = CmdFinalResult | CmdEventFrame;

/** Parse one NDJSON line. Returns null for blank lines. Throws on malformed JSON. */
export function parseCmdLine(line: string): CmdLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const obj = JSON.parse(trimmed) as Record<string, unknown>;
  if (obj["type"] === "result" || obj["type"] === "event") {
    return obj as unknown as CmdLine;
  }
  throw new Error(`unknown cmd NDJSON frame type: ${String(obj["type"])}`);
}

export function isFinalResult(line: CmdLine | null): line is CmdFinalResult {
  return line !== null && line.type === "result";
}
