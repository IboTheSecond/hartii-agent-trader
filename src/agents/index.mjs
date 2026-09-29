// src/agents — multi-agent cognition: spawns sandboxed `claude -p` analysts in parallel and a
// decider, parses+validates their strict-JSON output, maintains the memory journal.
//
// Mirrors the proven prototype pattern (re-implemented here, never imported):
//   claude -p "<task>" --model haiku --strict-mcp-config --mcp-config <json>
//     --allowedTools <ids> --disallowedTools Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,
//     Agent,NotebookEdit,Skill --permission-prompts none --setting-sources project
//     --append-system-prompt <brief> --output-format json
//   run with cwd = an empty sandbox directory (the model never gets file/shell/web access).
//
// Contract: see INTERFACES.md#src-agents.

function notImplemented(fn) {
  throw new Error(`src/agents: ${fn} not implemented — see INTERFACES.md`);
}

export const ROLES = Object.freeze(['momentumScout', 'riskAnalyst', 'portfolioManager']);

export class AgentOutputError extends Error {
  /**
   * @param {string} role
   * @param {string} raw
   * @param {string} [message]
   */
  constructor(role, raw, message = `agent output for role "${role}" failed validation`) {
    super(message);
    this.name = 'AgentOutputError';
    this.role = role;
    this.raw = raw;
  }
}

/**
 * Spawns one sandboxed analyst and returns its parsed, validated proposals — never raw text.
 * @param {typeof ROLES[number]} role
 * @param {object} input AnalystInput
 * @param {{ model?: string, timeoutMs?: number, spawnImpl?: Function }} [opts]
 * @returns {Promise<object[]>} AnalystProposal[]
 */
export async function runAnalyst(role, input, opts = {}) {
  return notImplemented('runAnalyst');
}

/**
 * Runs all three analysts in parallel; one analyst's failure/timeout does not fail the others
 * — it is recorded and contributes zero proposals.
 * @returns {Promise<Record<typeof ROLES[number], object[]>>}
 */
export async function runAnalystsInParallel(input, opts = {}) {
  return notImplemented('runAnalystsInParallel');
}

/**
 * Spawns the decider with the guarded trade tools; reconciles proposals into 1-3 executed (or
 * paper-executed) actions via src/tools' guarded handlers.
 * @param {object} input DeciderInput
 * @returns {Promise<object>} DeciderResult
 */
export async function runDecider(input, opts = {}) {
  return notImplemented('runDecider');
}

/** @returns {string} */
export function buildAnalystPrompt(role, input) {
  return notImplemented('buildAnalystPrompt');
}

/** @returns {string} */
export function buildDeciderPrompt(input) {
  return notImplemented('buildDeciderPrompt');
}

/**
 * Strict JSON parse + schema validation. Throws AgentOutputError (with the raw text attached)
 * on anything malformed.
 * @returns {object[]} AnalystProposal[]
 */
export function parseAnalystOutput(role, rawText) {
  return notImplemented('parseAnalystOutput');
}

/** @returns {object} DeciderResult */
export function parseDeciderOutput(rawText) {
  return notImplemented('parseDeciderOutput');
}

/** @returns {Promise<object[]>} MemoryEntry[] */
export async function loadMemoryJournal(filePath, readImpl) {
  return notImplemented('loadMemoryJournal');
}

/** @returns {Promise<void>} */
export async function appendMemoryEntry(filePath, entry, ioImpls) {
  return notImplemented('appendMemoryEntry');
}

/** Keeps the prompt small: most-recent-first, truncated to maxChars. @returns {string} */
export function summarizeMemory(entries, maxChars = 2000) {
  return notImplemented('summarizeMemory');
}
