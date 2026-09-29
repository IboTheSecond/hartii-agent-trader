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
// Contract: see INTERFACES.md#src-agents. This module is intentionally paper/live-agnostic: it
// never asks whether the run is paper or live — that switch lives entirely inside the guarded
// MCP trade-tool handlers (src/tools, wired by src/runner), per INTERFACES.md's cross-cutting
// "paper mode is a config flag read once, at the top" rule. All this module does is spawn a
// sandboxed session, hand it a prompt and a tool allowlist, and validate what comes back.

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { TOOL_ALLOWLISTS } from '../tools/index.mjs';
import { AgentOutputError, ROLES, parseAnalystOutput, parseDeciderOutput } from './schema.mjs';
import { buildAnalystPrompt, buildDeciderPrompt, buildSystemPrompt } from './prompts.mjs';
import { appendMemoryEntry, loadMemoryJournal, summarizeMemory } from './memory.mjs';

export { AgentOutputError, ROLES } from './schema.mjs';
export { buildAnalystPrompt, buildDeciderPrompt } from './prompts.mjs';
export { appendMemoryEntry, loadMemoryJournal, summarizeMemory } from './memory.mjs';
export { parseAnalystOutput, parseDeciderOutput } from './schema.mjs';

/** The `--mcp-config` server key this module writes and the tool-id prefix it assumes
 * (`mcp__hartii-agent__<tool>`) — whatever spawns the MCP server subprocess (see
 * `DEFAULT_MCP_SERVER_ENTRY` below / INTERFACE-REQUESTS.md) must register it under this same
 * name for the two sides to agree on tool ids. */
export const MCP_SERVER_NAME = 'hartii-agent';

export const DEFAULT_MODEL = 'haiku';
export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_CLAUDE_COMMAND = 'claude';

// Every built-in Claude Code tool that could read/write the filesystem, run a shell command, or
// reach the network outside the one MCP round-trip this repo wires up. Re-implemented locally
// (never imported from the reference prototype) per the owner's fixed spec for this build.
export const DISALLOWED_BUILTIN_TOOLS = Object.freeze([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
  'NotebookEdit',
  'Skill',
]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// SECURITY (see the security fix this closes): the top-level `claude -p` process this module
// spawns must never inherit this repo's own business secrets (HARTII_AGENT_KEY[_FILE],
// TELEGRAM_*, NTFY_URL) — it never needs any of them itself; only the MCP-server subprocess it
// spawns (via its OWN separately-built, role-scoped env — see buildMcpServerEnv in src/runner)
// ever touches a key, and only for the decider role in live mode. `childEnv` (opts.childEnv,
// defaulted here) is deliberately an ALLOWLIST of OS/runtime essentials the `claude` binary
// itself needs to run and authenticate, never `process.env` wholesale.
const CHILD_ENV_PASSTHROUGH_NAMES = Object.freeze([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SystemDrive',
  'TEMP', 'TMP', 'ProgramData', 'ComSpec', 'NODE_PATH', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH',
]);

/**
 * The env handed to the top-level `claude -p` process itself (not the MCP-server subprocess it
 * spawns via --mcp-config, which gets its own separately-built env — see
 * src/runner#buildMcpServerEnv). Forwards only OS/runtime essentials plus any `ANTHROPIC_*`/
 * `CLAUDE_*` var (the CLI's own auth/config vars) — never this app's HARTII_*, TELEGRAM_*, or
 * NTFY_URL secrets, which the `claude` binary itself has no legitimate use for.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(env = process.env) {
  const out = {};
  for (const key of CHILD_ENV_PASSTHROUGH_NAMES) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (/^(ANTHROPIC_|CLAUDE_)/i.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Case-insensitive address equality (checksummed vs. non-checksummed forms of the same address
 * must still match) — used only by reconcileDeciderActions below.
 */
function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * SECURITY (see the security fix this closes): the decider's own JSON reply is a self-reported,
 * un-verified claim — a hallucinating or prompt-manipulated session can fabricate a schema-valid
 * `ok:true` action that was never actually executed (or that the guard actually rejected). This
 * cross-checks each claimed action against `toolCallLog` — the REAL, append-only record of what
 * `bin/mcp-server.mjs`'s own hartii_buy/hartii_sell handlers actually did (see
 * src/tools#appendToolCallLog), read back from this session's own sandbox after it exits.
 *
 * Matching is positional-within-(token,side): the Nth claimed action for a given (token, side)
 * pairs with the Nth real log entry for that same (token, side), since paper-mode fills carry no
 * txHash to key off. A claimed action with no matching real log entry is DROPPED — never
 * recorded/reported — rather than trusted at face value; a matched action has every
 * outcome-bearing field (ok, amountWei, amountOutWei, txHash, gasWei, warnings) OVERWRITTEN by
 * the real logged result, so even a matched claim can't misstate what actually happened.
 * @param {object[]} claimedActions DeciderResult.actions as the model reported them
 * @param {object[]} toolCallLog real hartii_buy/hartii_sell results, in call order (see
 *   src/tools#appendToolCallLog for the shape)
 * @returns {object[]} verified actions only
 */
export function reconcileDeciderActions(claimedActions, toolCallLog) {
  const log = Array.isArray(toolCallLog) ? toolCallLog : [];
  const used = new Array(log.length).fill(false);
  const verified = [];
  for (const claimed of claimedActions || []) {
    const idx = log.findIndex(
      (entry, i) => !used[i] && entry?.side === claimed?.side && sameAddress(entry?.token, claimed?.token),
    );
    if (idx === -1) continue; // no matching real tool-call result — unverified, drop it
    used[idx] = true;
    const real = log[idx];
    verified.push({
      ...claimed,
      ok: Boolean(real.ok),
      amountWei: real.amountInWei ?? claimed.amountWei,
      amountOutWei: real.amountOutWei ?? null,
      txHash: real.txHash ?? null,
      gasWei: real.gasWei ?? null,
      warnings: Array.isArray(real.warnings) ? real.warnings : claimed.warnings || [],
    });
  }
  return verified;
}

/** Tolerant JSONL reader for the tool-call log — never throws; a missing/corrupt log (e.g. a
 * session that never called a trade tool) simply yields no verified actions. */
async function readToolCallLog(logPath, readFileImpl = readFile) {
  if (!logPath) return [];
  let raw;
  try {
    raw = await readFileImpl(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Default command used to start the MCP server subprocess `claude` spawns via --mcp-config.
 * Points at a `bin/mcp-server.mjs` this module does not own and does not create (see
 * INTERFACE-REQUESTS.md) — every caller can override via `opts.mcpServerCommand`/
 * `opts.mcpServerArgs`/`opts.mcpServerEnv` once that file exists and real ctx wiring is ready;
 * tests never reach this path at all since they inject `spawnImpl`. */
export const DEFAULT_MCP_SERVER_ENTRY = path.join(REPO_ROOT, 'bin', 'mcp-server.mjs');

function assertAnalystRole(role) {
  if (!ROLES.includes(role)) {
    throw new TypeError(`unknown analyst role "${role}" — expected one of ${ROLES.join(', ')}`);
  }
}

/** Claude Code's `mcp__<server>__<tool>` naming for one of our tool names. */
function mcpToolId(name, server = MCP_SERVER_NAME) {
  return `mcp__${server}__${name}`;
}

/**
 * The literal --allowedTools list (as mcp__ ids) for a role, sourced from src/tools'
 * TOOL_ALLOWLISTS — the one place that mapping is defined. `hartii_launch_token` is appended to
 * the decider's list only when launches are enabled for this run; every other role's list is
 * fixed regardless.
 */
export function buildAllowedToolIds(role, { launchesEnabled = false } = {}) {
  const names = TOOL_ALLOWLISTS[role];
  if (!names) throw new Error(`buildAllowedToolIds: no TOOL_ALLOWLISTS entry for role "${role}"`);
  const withLaunch = role === 'decider' && launchesEnabled ? [...names, 'hartii_launch_token'] : [...names];
  return withLaunch.map((name) => mcpToolId(name));
}

async function createSandbox({ sandboxDir, mkdtempImpl = mkdtemp, rmImpl = rm }) {
  if (sandboxDir) {
    // Caller-owned directory: we neither created it nor clean it up.
    return { dir: sandboxDir, cleanup: async () => {} };
  }
  const dir = await mkdtempImpl(path.join(os.tmpdir(), 'hartii-agent-'));
  return {
    dir,
    cleanup: async () => {
      await rmImpl(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function writeMcpConfig({ dir, writeFileImpl = writeFile, mcpServerCommand, mcpServerArgs, mcpServerEnv }) {
  const configPath = path.join(dir, 'mcp-config.json');
  const document = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: mcpServerCommand,
        args: mcpServerArgs,
        env: mcpServerEnv,
      },
    },
  };
  // mode 0600: this file may carry the agent signing key (decider, live mode only — see
  // buildMcpServerEnv) or other operational env — never group/world readable on disk.
  await writeFileImpl(configPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
  return configPath;
}

// The task prompt is sent over the spawned child's stdin (see runChildWithTimeout), never as a
// positional argv element: the task embeds the full market snapshot plus (for the decider) every
// analyst's proposals, easily exceeding Windows' ~32K total command-line length (CreateProcess's
// lpCommandLine limit) once the market has any real number of tokens on it — this is exactly what
// broke the first live smoke-test run ("spawn ENAMETOOLONG") once real market data replaced the
// tiny fixtures used in tests. `-p` with no attached value is Claude Code's documented "read the
// prompt from stdin" form.
function buildClaudeArgv({ model, mcpConfigPath, allowedToolIds, systemPrompt }) {
  return [
    '-p',
    '--model',
    model,
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    allowedToolIds.join(','),
    '--disallowedTools',
    DISALLOWED_BUILTIN_TOOLS.join(','),
    '--permission-prompts',
    'none',
    '--setting-sources',
    'project',
    '--append-system-prompt',
    systemPrompt,
    '--output-format',
    'json',
  ];
}

/**
 * Spawns `command`/`args` with a hard wall-clock timeout, writing `stdin` (the task prompt — see
 * buildClaudeArgv's header comment on why it travels this way, not as an argv element) to the
 * child's stdin and closing it. Never rejects — a spawn error or a timeout comes back as a normal
 * `{ code, stdout, stderr, timedOut }` result so callers decide what a failed session means,
 * exactly like the proven prototype's own child-process runner (re-implemented here, not
 * imported).
 */
function runChildWithTimeout(spawnImpl, command, args, { cwd, timeoutMs, env, stdin }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: `spawn error: ${err?.message || err}`, timedOut: false });
      return;
    }

    if (typeof stdin === 'string') {
      try {
        // A child that exits before we finish writing (crash, --help, etc.) can make this throw
        // (EPIPE) or emit an 'error' on the stream — either way that's just this write failing,
        // never this whole session; the child's own close/error handlers below still resolve.
        child.stdin?.on?.('error', () => {});
        child.stdin?.end?.(stdin, 'utf8');
      } catch {
        /* see above */
      }
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const killTimer = setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n[spawn error] ${err?.message || err}`, timedOut: false });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Pulls the model's final reply text out of a `claude --output-format json` envelope, trying
 * every shape this repo has reason to expect. Never throws; falls back to the raw stdout if it
 * isn't JSON at all (a CLI-level failure still leaves something for parseAnalystOutput /
 * parseDeciderOutput to reject with a useful raw-text error).
 */
function extractResultText(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return '';
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  if (typeof envelope === 'string') return envelope;
  if (!envelope || typeof envelope !== 'object') return '';
  if (typeof envelope.result === 'string') return envelope.result;
  if (envelope.result && typeof envelope.result === 'object' && typeof envelope.result.text === 'string') {
    return envelope.result.text;
  }
  if (typeof envelope.output === 'string') return envelope.output;
  if (typeof envelope.text === 'string') return envelope.text;
  if (Array.isArray(envelope.content)) {
    return envelope.content
      .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Full spawn-a-sandboxed-session flow shared by runAnalyst and runDecider: writes an mcp-config
 * into a fresh (or caller-supplied) empty sandbox dir, builds argv, runs `claude` with a
 * timeout, and returns the model's raw final-reply text. Throws AgentOutputError on a timeout or
 * a nonzero exit — both are "this session produced nothing usable", the same failure shape as
 * malformed JSON, so every caller can handle them in one place.
 */
async function spawnSandboxedSession({ role, task, systemPrompt, allowedToolIds, opts }) {
  const {
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnImpl = nodeSpawn,
    claudeCommand = DEFAULT_CLAUDE_COMMAND,
    sandboxDir,
    mkdtempImpl,
    rmImpl,
    writeFileImpl,
    readFileImpl,
    mcpServerCommand = 'node',
    mcpServerArgs, // undefined -> computed below once `dir` is known (carries the tool-call log path)
    mcpServerEnv = {},
    childEnv = buildChildEnv(process.env),
  } = opts;

  const { dir, cleanup } = await createSandbox({ sandboxDir, mkdtempImpl, rmImpl });
  // Only the decider ever calls a guarded trade tool, so only its session gets a tool-call log to
  // reconcile against (see reconcileDeciderActions above) — read back BEFORE cleanup() removes
  // the sandbox dir.
  const toolCallLogPath = role === 'decider' ? path.join(dir, 'tool-calls.jsonl') : null;
  const resolvedMcpServerArgs =
    mcpServerArgs ?? [DEFAULT_MCP_SERVER_ENTRY, '--role', role, ...(toolCallLogPath ? ['--log-file', toolCallLogPath] : [])];
  try {
    const mcpConfigPath = await writeMcpConfig({
      dir,
      writeFileImpl,
      mcpServerCommand,
      mcpServerArgs: resolvedMcpServerArgs,
      mcpServerEnv,
    });
    const argv = buildClaudeArgv({ model, mcpConfigPath, allowedToolIds, systemPrompt });
    const { code, stdout, stderr, timedOut } = await runChildWithTimeout(spawnImpl, claudeCommand, argv, {
      cwd: dir,
      timeoutMs,
      env: childEnv,
      stdin: task,
    });

    if (timedOut) {
      throw new AgentOutputError(role, stdout, `"${role}" session timed out after ${timeoutMs}ms`);
    }
    if (code !== 0) {
      const detail = stderr ? `: ${stderr.slice(0, 300)}` : '';
      throw new AgentOutputError(role, stdout || stderr, `"${role}" session exited with code ${code}${detail}`);
    }
    const toolCallLog = await readToolCallLog(toolCallLogPath, readFileImpl);
    return { text: extractResultText(stdout), toolCallLog };
  } finally {
    await cleanup();
  }
}

/**
 * Spawns one sandboxed analyst and returns its parsed, validated proposals — never raw text.
 * Throws AgentOutputError on a timeout, a nonzero exit, or output that fails schema validation;
 * runAnalystsInParallel is what turns that into a zero-proposal result for this one role without
 * failing the others.
 * @param {typeof ROLES[number]} role
 * @param {object} input AnalystInput
 * @param {object} [opts]
 * @returns {Promise<object[]>} AnalystProposal[]
 */
export async function runAnalyst(role, input, opts = {}) {
  assertAnalystRole(role);
  const systemPrompt = buildSystemPrompt(role, opts);
  const task = buildAnalystPrompt(role, input);
  const allowedToolIds = buildAllowedToolIds(role);
  const { text } = await spawnSandboxedSession({ role, task, systemPrompt, allowedToolIds, opts });
  return parseAnalystOutput(role, text);
}

/**
 * Runs all three analysts in parallel; a single analyst's failure/timeout/malformed output does
 * not fail the others — it is recorded (via `opts.onAnalystError(role, err)`, if given) and
 * simply contributes zero proposals for that role.
 * @param {object} input AnalystInput
 * @param {object} [opts]
 * @returns {Promise<Record<typeof ROLES[number], object[]>>}
 */
export async function runAnalystsInParallel(input, opts = {}) {
  const { onAnalystError } = opts;
  const settled = await Promise.all(
    ROLES.map(async (role) => {
      try {
        return [role, await runAnalyst(role, input, opts)];
      } catch (err) {
        if (typeof onAnalystError === 'function') {
          try {
            onAnalystError(role, err);
          } catch {
            /* a logging hook must never itself break the cycle */
          }
        }
        return [role, []];
      }
    }),
  );
  return Object.fromEntries(settled);
}

/**
 * Spawns the decider with the guarded trade tools; reconciles proposals into 1-3 executed (or
 * paper-executed — invisible to this module, see the file-level comment) actions via the MCP
 * server's own guarded handlers. Throws AgentOutputError on a timeout, nonzero exit, or output
 * that fails schema validation — a decider that can't produce a valid result took no verifiable
 * action and callers should treat this cycle as a no-op, never invent one.
 * @param {object} input DeciderInput
 * @param {object} [opts] also accepts `launchesEnabled` (default false) to widen the tool list.
 * @returns {Promise<object>} DeciderResult
 */
export async function runDecider(input, opts = {}) {
  const role = 'decider';
  const systemPrompt = buildSystemPrompt(role, opts);
  const task = buildDeciderPrompt(input);
  const allowedToolIds = buildAllowedToolIds(role, { launchesEnabled: opts.launchesEnabled });
  const { text, toolCallLog } = await spawnSandboxedSession({ role, task, systemPrompt, allowedToolIds, opts });
  const parsed = parseDeciderOutput(text);
  // SECURITY: never trust the decider's own self-reported `actions` at face value — reconcile
  // against the real hartii_buy/hartii_sell results this session's own sandboxed MCP-server
  // subprocess actually logged (see reconcileDeciderActions above).
  return { ...parsed, actions: reconcileDeciderActions(parsed.actions, toolCallLog) };
}
