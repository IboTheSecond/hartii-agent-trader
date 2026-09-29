// src/agents/memory.mjs — the runner-owned memory journal: append-only lessons/outcomes from
// past cycles, summarized back into every prompt so the system doesn't repeat mistakes it has
// already seen. Contract: see INTERFACES.md#src-agents.
//
// File I/O is thin and always takes an injectable impl (real fs/promises default) — no network
// involved either way, but tests never need to touch the real disk.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const VALID_OUTCOMES = new Set(['good', 'bad', 'neutral']);

function isValidMemoryEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.atMs === 'number' &&
    Number.isFinite(entry.atMs) &&
    typeof entry.cycleId === 'string' &&
    entry.cycleId.length > 0 &&
    typeof entry.summary === 'string' &&
    entry.summary.length > 0 &&
    (entry.outcome === undefined || VALID_OUTCOMES.has(entry.outcome))
  );
}

/**
 * Loads the memory journal. Returns an empty array if the file does not exist yet, and also
 * (rather than throwing and taking a whole cycle down with it) if it exists but is unreadable
 * or malformed — a corrupt journal should never block trading, just start fresh.
 * @param {string} filePath
 * @param {(path: string, enc: string) => Promise<string>} [readImpl]
 * @returns {Promise<object[]>} MemoryEntry[]
 */
export async function loadMemoryJournal(filePath, readImpl = readFile) {
  let text;
  try {
    text = await readImpl(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMemoryEntry);
  } catch {
    return [];
  }
}

/**
 * Appends one entry to the journal (read-modify-write; this repo runs one cycle at a time so no
 * separate locking is needed). Throws on an invalid entry shape rather than silently writing
 * garbage that would poison every future prompt.
 * @param {string} filePath
 * @param {{ atMs: number, cycleId: string, summary: string, outcome?: 'good'|'bad'|'neutral' }} entry MemoryEntry
 * @param {{ readImpl?, writeImpl?, mkdirImpl? }} [ioImpls]
 * @returns {Promise<void>}
 */
export async function appendMemoryEntry(filePath, entry, ioImpls = {}) {
  const { readImpl = readFile, writeImpl = writeFile, mkdirImpl = mkdir } = ioImpls;
  if (!isValidMemoryEntry(entry)) {
    throw new TypeError('appendMemoryEntry: entry must have { atMs: number, cycleId: string, summary: string, outcome?: "good"|"bad"|"neutral" }');
  }
  const existing = await loadMemoryJournal(filePath, readImpl);
  const next = [...existing, entry];
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') await mkdirImpl(dir, { recursive: true });
  await writeImpl(filePath, JSON.stringify(next, null, 2), 'utf8');
}

/**
 * Keeps the prompt small: most-recent-first, truncated to maxChars (never mid-entry — a whole
 * entry is either included or dropped).
 * @param {object[]} entries MemoryEntry[]
 * @param {number} [maxChars]
 * @returns {string}
 */
export function summarizeMemory(entries, maxChars = 2000) {
  if (!Array.isArray(entries) || entries.length === 0) return 'No prior lessons recorded yet.';

  const sorted = [...entries].filter(isValidMemoryEntry).sort((a, b) => b.atMs - a.atMs);
  if (sorted.length === 0) return 'No prior lessons recorded yet.';

  const lines = [];
  let used = 0;
  for (const entry of sorted) {
    const tag = entry.outcome ? ` (${entry.outcome})` : '';
    const when = new Date(entry.atMs).toISOString();
    const line = `- [${when}]${tag} ${entry.summary}`;
    // +1 for the newline that will join it to the rest.
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.length > 0 ? lines.join('\n') : 'No prior lessons recorded yet.';
}
