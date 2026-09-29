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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await writeFileImpl(configPath, JSON.stringify(document, null, 2), 'utf8');
  return configPath;
}

function buildClaudeArgv({ task, model, mcpConfigPath, allowedToolIds, systemPrompt }) {
  return [
    '-p',
    task,
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
 * Spawns `command`/`args` with a hard wall-clock timeout. Never rejects — a spawn error or a
 * timeout comes back as a normal `{ code, stdout, stderr, timedOut }` result so callers decide
 * what a failed session means, exactly like the proven prototype's own child-process runner
 * (re-implemented here, not imported).
 */
function runChildWithTimeout(spawnImpl, command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: `spawn error: ${err?.message || err}`, timedOut: false });
      return;
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
    mcpServerCommand = 'node',
    mcpServerArgs = [DEFAULT_MCP_SERVER_ENTRY, '--role', role],
    mcpServerEnv = {},
    childEnv = process.env,
  } = opts;

  const { dir, cleanup } = await createSandbox({ sandboxDir, mkdtempImpl, rmImpl });
  try {
    const mcpConfigPath = await writeMcpConfig({
      dir,
      writeFileImpl,
      mcpServerCommand,
      mcpServerArgs,
      mcpServerEnv,
    });
    const argv = buildClaudeArgv({ task, model, mcpConfigPath, allowedToolIds, systemPrompt });
    const { code, stdout, stderr, timedOut } = await runChildWithTimeout(spawnImpl, claudeCommand, argv, {
      cwd: dir,
      timeoutMs,
      env: childEnv,
    });

    if (timedOut) {
      throw new AgentOutputError(role, stdout, `"${role}" session timed out after ${timeoutMs}ms`);
    }
    if (code !== 0) {
      const detail = stderr ? `: ${stderr.slice(0, 300)}` : '';
      throw new AgentOutputError(role, stdout || stderr, `"${role}" session exited with code ${code}${detail}`);
    }
    return extractResultText(stdout);
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
  const text = await spawnSandboxedSession({ role, task, systemPrompt, allowedToolIds, opts });
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
  const text = await spawnSandboxedSession({ role, task, systemPrompt, allowedToolIds, opts });
  return parseDeciderOutput(text);
}
