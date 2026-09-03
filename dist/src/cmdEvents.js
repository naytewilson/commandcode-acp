/**
 * Narrow types for the `cmd -p --output-format json` NDJSON stream.
 * Only fields the bridge consumes are modeled; everything else passes
 * through as unknown. Unknown future `event.type` values are ignored
 * safely by the mapper (forward-compatibility requirement).
 */
/** Parse one NDJSON line. Returns null for blank lines. Throws on malformed JSON. */
export function parseCmdLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const obj = JSON.parse(trimmed);
    if (obj["type"] === "result" || obj["type"] === "event") {
        return obj;
    }
    throw new Error(`unknown cmd NDJSON frame type: ${String(obj["type"])}`);
}
export function isFinalResult(line) {
    return line !== null && line.type === "result";
}
