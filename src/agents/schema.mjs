// src/agents/schema.mjs — strict JSON parsing + zod validation for the two JSON contracts a
// sandboxed session must emit (AnalystProposal[] and DeciderResult), plus the AgentOutputError
// thrown on anything malformed. Contract: see INTERFACES.md#src-agents.
//
// A haiku session won't always end its reply with nothing but the JSON we asked for — it may
// add a stray sentence before or after it. Extraction here is deliberately forgiving about
// *finding* the JSON (last non-empty line first, then the widest matching bracket span in the
// whole text); validation of what it finds is not forgiving at all — anything that doesn't match
// the schema throws.

import { z } from 'zod';

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
    this.raw = typeof raw === 'string' ? raw : String(raw ?? '');
  }
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const WEI_RE = /^\d+$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const AnalystProposalSchema = z.object({
  token: z.string().regex(ADDRESS_RE, 'token must be a 0x-checksummed 20-byte address'),
  action: z.enum(['buy', 'sell', 'hold', 'exit']),
  sizeFractionBps: z.number().int().min(0).max(10000).optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  reason: z.string().min(1).max(500),
  flags: z.array(z.string().min(1).max(64)).max(12).optional(),
});

const AnalystProposalArraySchema = z.array(AnalystProposalSchema).max(25);

const DeciderActionSchema = z.object({
  token: z.string().regex(ADDRESS_RE, 'token must be a 0x-checksummed 20-byte address'),
  side: z.enum(['buy', 'sell']),
  amountWei: z.string().regex(WEI_RE, 'amountWei must be a decimal-string wei amount'),
  txHash: z
    .string()
    .regex(TX_HASH_RE, 'txHash must be a 32-byte 0x hash')
    .nullable(),
  ok: z.boolean(),
  warnings: z.array(z.string()).default([]),
  // Additive, optional — not in INTERFACES.md's original minimal DeciderResult.actions shape.
  // src/runner#buildTradeRecord already knows how to consume each of these when present (falling
  // back sanely when absent); without amountOutWei in particular, a recorded trade's tokens/price
  // always came back as 0 regardless of what actually filled, since a sandboxed decider session's
  // own tool calls are otherwise invisible to src/runner — see INTERFACE-REQUESTS.md's
  // integration entry (confirmed live) and this schema's task prompt (buildDeciderPrompt), which
  // now explicitly asks the model to copy a successful hartii_buy/hartii_sell tool response's
  // amountOutWei through into this field.
  amountOutWei: z.string().regex(WEI_RE, 'amountOutWei must be a decimal-string wei amount').nullish(),
  priceQuaiPerTokenWei: z.string().regex(WEI_RE, 'priceQuaiPerTokenWei must be a decimal-string wei amount').nullish(),
  gasWei: z.string().regex(WEI_RE, 'gasWei must be a decimal-string wei amount').nullish(),
  symbol: z.string().max(32).nullish(),
  reason: z.string().max(500).nullish(),
});

const DeciderResultSchema = z.object({
  actions: z.array(DeciderActionSchema).max(3),
  reasoning: z.string().min(1).max(2000),
  skipped: z.string().max(500).nullable(),
});

/** Formats zod issues into one short, human-readable line for the error message. */
function describeIssues(error) {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Finds a JSON value of the requested bracket shape inside free-form model text: the last
 * non-empty line first (what every brief asks for), then the widest matching bracket span in
 * the whole text as a fallback. Never throws — returns null on anything unparsable.
 * @param {string} rawText
 * @param {{ open: '[' | '{', close: ']' | '}' }} shape
 * @returns {unknown | null}
 */
function extractJsonCandidate(rawText, { open, close }) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const trimmed = rawText.trim();

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine && lastLine.startsWith(open)) {
    try {
      return JSON.parse(lastLine);
    } catch {
      /* fall through to the wider scan below */
    }
  }

  const first = trimmed.indexOf(open);
  const last = trimmed.lastIndexOf(close);
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* give up below */
    }
  }
  return null;
}

/**
 * Strict JSON parse + schema validation for one analyst's output. Throws AgentOutputError (raw
 * text attached) on anything malformed — callers (runAnalystsInParallel) decide whether that
 * becomes a zero-proposal result or a hard failure.
 * @param {typeof ROLES[number]} role
 * @param {string} rawText
 * @returns {object[]} AnalystProposal[]
 */
export function parseAnalystOutput(role, rawText) {
  let candidate = extractJsonCandidate(rawText, { open: '[', close: ']' });
  if (!Array.isArray(candidate)) {
    // Tolerate a common wrapper shape ({"proposals":[...]}) without loosening validation itself.
    const wrapped = extractJsonCandidate(rawText, { open: '{', close: '}' });
    if (wrapped && Array.isArray(wrapped.proposals)) candidate = wrapped.proposals;
  }
  if (!Array.isArray(candidate)) {
    throw new AgentOutputError(role, rawText, `analyst "${role}" output did not contain a JSON array`);
  }

  const result = AnalystProposalArraySchema.safeParse(candidate);
  if (!result.success) {
    throw new AgentOutputError(role, rawText, `analyst "${role}" output failed schema validation: ${describeIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Strict JSON parse + schema validation for the decider's output.
 * @param {string} rawText
 * @returns {object} DeciderResult
 */
export function parseDeciderOutput(rawText) {
  const candidate = extractJsonCandidate(rawText, { open: '{', close: '}' });
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AgentOutputError('decider', rawText, 'decider output did not contain a JSON object');
  }

  const result = DeciderResultSchema.safeParse(candidate);
  if (!result.success) {
    throw new AgentOutputError('decider', rawText, `decider output failed schema validation: ${describeIssues(result.error)}`);
  }
  return result.data;
}
