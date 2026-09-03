/**
 * Model catalog discovery via real `cmd --list-models`.
 * IDs are preserved exactly. No hard-coded list: when discovery fails
 * the catalog is empty and callers must surface that (Paseo/T3 fall back
 * to their config-file `models` override).
 */
import { execFile } from "node:child_process";
const LIST_TIMEOUT_MS = 20000;
const HEADER_LINES = new Set([
    "open source",
    "anthropic",
    "openai",
    "google",
    "meta",
    "sakana",
    "xai",
]);
function runCmd(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            resolve(stdout);
        });
        child.stdin?.end();
    });
}
/**
 * Parse `cmd --list-models` human output.
 * Observed shape: section headers (blank-line separated groups) and rows
 * `<id><2+ spaces><description>`. Lines without 2-space separation,
 * headers, and hint lines are skipped. IDs keep exact `a/b` form.
 */
export function parseListModels(output) {
    const models = [];
    const seen = new Set();
    for (const rawLine of output.split("\n")) {
        const line = rawLine.replace(/\s+$/, "");
        const t = line.trim();
        if (!t)
            continue;
        // Section headers / hints are whole lines; model ids always contain
        // "/" or "-" plus a description column, so exact-match headers only.
        if (HEADER_LINES.has(t.toLowerCase()))
            continue;
        if (/^available models\b/i.test(t))
            continue;
        if (/^pass the full id/i.test(t) || /^docs:/i.test(t) || /^cmd --model/i.test(t))
            continue;
        const m = line.match(/^(\S+)\s{2,}(.+)$/);
        if (!m)
            continue;
        const id = m[1].trim();
        if (seen.has(id))
            continue;
        seen.add(id);
        models.push({ id, label: id, description: m[2].trim() });
    }
    return models;
}
export async function discoverCatalog(cmdBin) {
    const statusOut = await runCmd(cmdBin, ["status", "--json"], 5000).catch(() => "");
    let defaultModel;
    let cmdVersion;
    try {
        const s = JSON.parse(statusOut);
        if (typeof s.model === "string" && s.model)
            defaultModel = s.model;
        if (typeof s.version === "string" && s.version)
            cmdVersion = s.version;
    }
    catch { }
    const listOut = await runCmd(cmdBin, ["--list-models", "--no-auto-update"], 10000).catch(() => "");
    const models = parseListModels(listOut);
    return { models, defaultModel, cmdVersion };
}
