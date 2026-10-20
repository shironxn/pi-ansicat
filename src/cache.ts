import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CACHE_VERSION = 1;
const MAX_ENTRIES = 200;

interface CacheEntry {
  description: string;
  at: number;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export function descriptionCacheKey(
  imageHash: string,
  provider: string,
  model: string,
  prompt: string,
  maxTokens?: number,
): string {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  return createHash("sha256")
    .update(`${CACHE_VERSION}\0${provider}\0${model}\0${promptHash}\0${maxTokens ?? ""}\0${imageHash}`)
    .digest("hex");
}

export function descriptionCachePath(agentDir: string): string {
  return `${agentDir}/cache/ansicat-descriptions.json`;
}

function isEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.description === "string" && typeof entry.at === "number";
}

// Read on every access: another pi process may have added entries since this
// one started. A corrupt file is treated as empty instead of blocking writes.
function load(path: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
    if (raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)) {
      const entries: Record<string, CacheEntry> = {};
      for (const [key, value] of Object.entries(raw.entries)) {
        if (isEntry(value)) entries[key] = value;
      }
      return { version: CACHE_VERSION, entries };
    }
  } catch { /* missing or corrupt cache is not an error */ }
  return { version: CACHE_VERSION, entries: {} };
}

export function readCachedDescription(path: string, key: string): string | undefined {
  return load(path).entries[key]?.description;
}

export function writeCachedDescription(path: string, key: string, description: string): void {
  // Read-modify-write preserves entries another process wrote before this
  // call. Two simultaneous writes can still overwrite each other; the cache
  // is best effort.
  const cache = load(path);
  cache.entries[key] = { description, at: Date.now() };

  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => cache.entries[a].at - cache.entries[b].at);
    for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache.entries[old];
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw error;
  }
}
