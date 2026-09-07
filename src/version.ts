/** Bridge identity + advertised ACP modes (explicit, never silent). */
export const BRIDGE_VERSION = "0.2.0";

export interface BridgeMode {
  id: "default" | "plan" | "auto-accept" | "full-access";
  name: string;
  description: string;
}

/**
 * Permission contract (mirrors cmd headless flags):
 * - default: no extra flag. Headless default blocks file writes/edits and
 *   shell commands (fail-closed); project permission rules still apply.
 * - plan: --plan (read-only exploration).
 * - auto-accept: --auto-accept (accept edits automatically).
 * - full-access: --yolo (the caller explicitly selected T3 full-access).
 * No interactive approval bridging exists because `cmd -p`
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
  {
    id: "full-access",
    name: "Full access",
    description: "Explicit high-authority mode via cmd --yolo; shell and edit tools are enabled.",
  },
];
