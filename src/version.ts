/** Bridge identity + advertised ACP modes (explicit, never silent). */
export const BRIDGE_VERSION = "0.1.0";

export interface BridgeMode {
  id: "default" | "plan" | "auto-accept";
  name: string;
  description: string;
}

/**
 * Permission contract (mirrors cmd headless flags):
 * - default: no extra flag. Headless default blocks file writes/edits and
 *   shell commands (fail-closed); project permission rules still apply.
 * - plan: --plan (read-only exploration).
 * - auto-accept: --auto-accept (accept edits automatically).
 * There is deliberately NO yolo mode: --yolo is only ever added when the
 * caller explicitly selects a high-authority mode, and v0.1.0 offers no
 * such mode. No interactive approval bridging exists because `cmd -p`
 * exposes no approval request/response channel (PROVEN: tool_hook_blocked
 * is terminal, no approval event exists in the NDJSON contract).
 */
export const MODES: BridgeMode[] = [
  {
    id: "default",
    name: "Standard",
    description: "Fail-closed headless defaults: reads allowed, writes/shell denied unless project rules allow.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read-only exploration via cmd --plan. No side effects.",
  },
  {
    id: "auto-accept",
    name: "Auto-accept edits",
    description: "Accept file edits automatically via cmd --auto-accept. Shell still gated by project rules.",
  },
];
