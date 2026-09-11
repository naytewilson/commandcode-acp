/**
 * Model catalog discovery via real `cmd --list-models`.
 * IDs are preserved exactly. No hard-coded list: when discovery fails
 * the catalog is empty and callers must surface that (Paseo/T3 fall back
 * to their config-file `models` override).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  capabilities?: CatalogModelCapabilities;
}

export interface CatalogModelCapabilities {
  reasoningEfforts?: string[];
  contextWindow?: number;
  supportsVision?: boolean;
}

const LIST_TIMEOUT_MS = 20000;

export interface Catalog {
  models: CatalogModel[];
  defaultModel?: string;
  cmdVersion?: string;
  capabilitySource?: string;
}

const HEADER_LINES = new Set([
  "open source",
  "anthropic",
  "openai",
  "google",
  "meta",
  "sakana",
  "xai",
]);

function runCmd(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        (err as any).stderr = stderr;
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
export function parseListModels(output: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) continue;
    // Section headers / hints are whole lines; model ids always contain
    // "/" or "-" plus a description column, so exact-match headers only.
    if (HEADER_LINES.has(t.toLowerCase())) continue;
    if (/^available models\b/i.test(t)) continue;
    if (/^pass the full id/i.test(t) || /^docs:/i.test(t) || /^cmd --model/i.test(t)) continue;
    const m = line.match(/^(\S+)\s{2,}(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, description: m[2].trim() });
  }
  return models;
}

interface ParsedMapEntry {
  key: string;
  value: string[] | number | undefined;
}

function balancedBlock(source: string, openIndex: number): string | undefined {
  const open = source[openIndex];
  const close = open === "[" ? "]" : open === "(" ? ")" : open === "{" ? "}" : undefined;
  if (!close) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return undefined;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let square = 0;
  let round = 0;
  let curly = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && square === 0 && round === 0 && curly === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseStringArrayLiteral(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return undefined;
  const body = balancedBlock(trimmed, 0);
  if (body === undefined || trimmed.slice(body.length + 2).trim()) return undefined;
  const strings: string[] = [];
  for (const item of splitTopLevel(body)) {
    if (!/^"(?:\\.|[^"\\])*"$/.test(item)) return undefined;
    try {
      const parsed: unknown = JSON.parse(item);
      if (typeof parsed !== "string") return undefined;
      strings.push(parsed);
    } catch {
      return undefined;
    }
  }
  return strings;
}

function parseSimpleMapBody(body: string, aliases: ReadonlyMap<string, string[]>): ParsedMapEntry[] {
  const entries: ParsedMapEntry[] = [];
  for (const rawEntry of splitTopLevel(body)) {
    const entry = rawEntry.trim();
    if (!entry.startsWith("[")) continue;
    const entryBody = balancedBlock(entry, 0);
    if (entryBody === undefined || entry.slice(entryBody.length + 2).trim()) continue;
    const fields = splitTopLevel(entryBody);
    if (fields.length !== 2 || !/^"(?:\\.|[^"\\])*"$/.test(fields[0]!)) continue;
    let key: unknown;
    try {
      key = JSON.parse(fields[0]!);
    } catch {
      continue;
    }
    if (typeof key !== "string") continue;
    const rawValue = fields[1]!.trim();
    const inlineArray = parseStringArrayLiteral(rawValue);
    if (inlineArray) {
      entries.push({ key, value: inlineArray });
      continue;
    }
    const alias = aliases.get(rawValue);
    if (alias) {
      entries.push({ key, value: [...alias] });
      continue;
    }
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawValue)) {
      const number = Number(rawValue);
      if (Number.isFinite(number)) entries.push({ key, value: number });
    }
  }
  return entries;
}

function findStringAliases(source: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const assignment = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\[/g;
  for (const match of source.matchAll(assignment)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("[");
    const block = balancedBlock(source, openIndex);
    if (block === undefined) continue;
    const parsed = parseStringArrayLiteral(`[${block}]`);
    if (parsed) aliases.set(match[1]!, parsed);
  }
  return aliases;
}

function findMapBodies(source: string): string[] {
  const maps: string[] = [];
  const marker = /new\s+Map\s*\(\s*\[/g;
  for (const match of source.matchAll(marker)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("[");
    const block = balancedBlock(source, openIndex);
    if (block !== undefined) maps.push(block);
  }
  return maps;
}

function findStringSets(source: string): string[][] {
  const sets: string[][] = [];
  const marker = /new\s+Set\s*\(\s*\[/g;
  for (const match of source.matchAll(marker)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("[");
    const block = balancedBlock(source, openIndex);
    if (block === undefined) continue;
    const parsed = parseStringArrayLiteral(`[${block}]`);
    if (parsed) sets.push(parsed);
  }
  return sets;
}

function modelMapScore(entries: ReadonlyArray<ParsedMapEntry>): number {
  return entries.filter(
    (entry) => entry.key.includes("meta/muse-spark-1.3") && Array.isArray(entry.value),
  ).length;
}

function numericModelMapScore(entries: ReadonlyArray<ParsedMapEntry>): number {
  return entries.filter(
    (entry) => entry.key.includes("meta/muse-spark-1.3") && typeof entry.value === "number",
  ).length;
}

/**
 * Extract the current CLI's own built-in model registry without evaluating the
 * bundle. This intentionally accepts only the simple Map/Set literals used by
 * Command Code's registry and returns an empty object when that shape changes.
 */
export function parseBundledCapabilityRegistry(
  source: string,
): Record<string, CatalogModelCapabilities> {
  const aliases = findStringAliases(source);
  const maps = findMapBodies(source).map((body) => parseSimpleMapBody(body, aliases));
  const effortEntries = maps.reduce<ParsedMapEntry[]>(
    (best, entries) => (modelMapScore(entries) > modelMapScore(best) ? entries : best),
    [],
  );
  const contextEntries = maps.reduce<ParsedMapEntry[]>(
    (best, entries) =>
      numericModelMapScore(entries) > numericModelMapScore(best) ? entries : best,
    [],
  );
  const effortByModel = new Map(
    effortEntries.flatMap((entry) =>
      Array.isArray(entry.value) ? [[entry.key, entry.value] as const] : [],
    ),
  );
  const contextByModel = new Map(
    contextEntries.flatMap((entry) =>
      typeof entry.value === "number" ? [[entry.key, entry.value] as const] : [],
    ),
  );
  const sets = findStringSets(source);
  const knownModels = sets.reduce<string[]>(
    (best, values) =>
      values.includes("meta/muse-spark-1.3") && values.length > best.length ? values : best,
    [],
  );
  const textOnlyModels = sets.reduce<string[]>(
    (best, values) =>
      values.includes("deepseek/deepseek-v4-pro") &&
      !values.includes("meta/muse-spark-1.3") &&
      values.length > best.length
        ? values
        : best,
    [],
  );
  const modelIds = new Set([...knownModels, ...effortByModel.keys(), ...contextByModel.keys()]);
  const result: Record<string, CatalogModelCapabilities> = {};
  for (const model of modelIds) {
    const reasoningEfforts = effortByModel.get(model);
    const contextWindow = contextByModel.get(model);
    const supportsVision = knownModels.includes(model) ? !textOnlyModels.includes(model) : undefined;
    if (!reasoningEfforts && contextWindow === undefined && supportsVision === undefined) continue;
    result[model] = {
      ...(reasoningEfforts ? { reasoningEfforts: [...reasoningEfforts] } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(supportsVision !== undefined ? { supportsVision } : {}),
    };
  }
  return result;
}

function resolveCommandExecutable(command: string): string | undefined {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Continue searching other PATH entries.
    }
  }
  return undefined;
}

function readBundledCapabilityRegistry(command: string): {
  source: string;
  capabilities: Record<string, CatalogModelCapabilities>;
} | undefined {
  const executable = resolveCommandExecutable(command);
  if (!executable) return undefined;
  const candidate = join(dirname(executable), "cli.mjs");
  try {
    const source = readFileSync(candidate, "utf8");
    const capabilities = parseBundledCapabilityRegistry(source);
    if (Object.keys(capabilities).length === 0) return undefined;
    return { source: candidate, capabilities };
  } catch {
    return undefined;
  }
}

export async function discoverCatalog(cmdBin: string): Promise<Catalog> {
  const statusOut = await runCmd(cmdBin, ["status", "--json"], 5000).catch(() => "");
  let defaultModel: string | undefined;
  let cmdVersion: string | undefined;
  try {
    const s = JSON.parse(statusOut) as { model?: unknown; version?: unknown };
    if (typeof s.model === "string" && s.model) defaultModel = s.model;
    if (typeof s.version === "string" && s.version) cmdVersion = s.version;
  } catch {}

  const listOut = await runCmd(cmdBin, ["--list-models", "--no-auto-update"], 10000).catch(() => "");
  const registry = readBundledCapabilityRegistry(cmdBin);
  const models = parseListModels(listOut).map((model) => ({
    ...model,
    ...(registry?.capabilities[model.id]
      ? { capabilities: registry.capabilities[model.id] }
      : {}),
  }));
  return {
    models,
    defaultModel,
    cmdVersion,
    ...(registry ? { capabilitySource: registry.source } : {}),
  };
}
