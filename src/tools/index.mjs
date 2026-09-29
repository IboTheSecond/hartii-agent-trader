// src/tools — the MCP server(s): read-only intelligence tools for analysts, guarded trade
// tools for the decider, and the per-role tool-name allowlist builder.
// Contract: see INTERFACES.md#src-tools.
//
// DI seam: ctx.chain / ctx.guard let tests (and any future caller) inject fakes for the
// still-in-parallel-development src/chain and src/guard modules. Production callers omit them
// and get the real modules — see INTERFACE-REQUESTS.md for the note to other module owners.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as defaultChain from '../chain/index.mjs';
import * as defaultGuard from '../guard/index.mjs';
import { getProfile, DEFAULTS } from '../config/index.mjs';
import { sanitizeTokenText } from '../data/index.mjs';

function notImplemented(fn) {
  throw new Error(`src/tools: ${fn} not implemented — see INTERFACES.md`);
}

// --- small pure helpers ----------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isAddressLike(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

function safeBigInt(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Scales `value` by newNumerator/oldDenominator using bigint math (no floating point). */
function scaleBigInt(value, newNumerator, oldDenominator) {
  if (oldDenominator === 0n) return value;
  return (value * newNumerator) / oldDenominator;
}

/** vault QUAI balance + the live mark value of every holding, per INTERFACES.md's VaultState. */
function computeFullPortfolioWei(vaultState) {
  let total = safeBigInt(vaultState?.quaiBalanceWei) ?? 0n;
  for (const holding of vaultState?.holdings ?? []) {
    total += safeBigInt(holding?.markValueQuaiWei) ?? 0n;
  }
  return total;
}

function resolveMaxPriceImpactPct(ctx) {
  if (typeof ctx.config?.maxPriceImpactPct === 'number') return ctx.config.maxPriceImpactPct;
  const profileName = ctx.config?.profile || 'reckless';
  return getProfile(profileName).maxPriceImpactPct;
}

function resolveMaxFractionBps(ctx) {
  return ctx.config?.maxFractionOfPortfolioBps ?? DEFAULTS.maxFractionOfPortfolioBps;
}

async function resolveAgentAddress(ctx, chain) {
  if (ctx.wallet?.address) return ctx.wallet.address;
  const caps = await chain.getVaultCaps(ctx.provider, ctx.vault);
  return caps.agent;
}

const NON_TRADEABLE_STATUSES = new Set([
  'hidden', 'flagged', 'delisted', 'banned', 'rugged', 'paused', 'blocked',
]);

/** Filters out hidden/flagged/untradeable tokens per the hartii_market contract. */
function isTradeable(token) {
  if (!token || typeof token !== 'object') return false;
  if (token.tradeable === false) return false;
  if (token.hidden === true || token.flagged === true) return false;
  if (typeof token.status === 'string' && NON_TRADEABLE_STATUSES.has(token.status.toLowerCase())) return false;
  return true;
}

/** Top-10 + creator holder concentration, defensive against missing fields. */
function summarizeHolders(holders, detail) {
  const list = Array.isArray(holders) ? holders : [];
  const top10PctSum = list.slice(0, 10).reduce((sum, h) => sum + (Number(h?.pct) || 0), 0);
  const creator = typeof detail?.creator === 'string' ? detail.creator.toLowerCase() : null;
  const creatorHolder = creator
    ? list.find((h) => typeof h?.wallet === 'string' && h.wallet.toLowerCase() === creator)
    : null;
  return {
    top10Pct: Number(top10PctSum.toFixed(2)),
    creatorPct: creatorHolder ? Number(creatorHolder.pct) || 0 : null,
    holderCount: list.length,
  };
}

/**
 * Bonding-curve progress toward graduation from tokensSold/totalSupplyWei. The public schema
 * does not pin an exact graduation threshold field, so this is a best-effort fraction of total
 * supply sold — see INTERFACE-REQUESTS.md.
 */
function computeCurveProgress(detail) {
  const totalSupply = safeBigInt(detail?.totalSupplyWei);
  const tokensSold = safeBigInt(detail?.tokensSold);
  if (totalSupply === null || tokensSold === null || totalSupply === 0n) {
    return { progressPct: null, remainingWei: null };
  }
  const progressPct = Number((tokensSold * 10000n) / totalSupply) / 100;
  const remainingWei = (totalSupply - tokensSold >= 0n ? totalSupply - tokensSold : 0n).toString();
  return { progressPct, remainingWei };
}

/** Buy/sell QUAI-volume imbalance and unique-trader count over a trade window. */
function summarizeTradeFlow(trades) {
  const list = Array.isArray(trades) ? trades : [];
  let buyQuaiWei = 0n;
  let sellQuaiWei = 0n;
  const uniqueTraders = new Set();
  for (const t of list) {
    const amt = safeBigInt(t?.amountQuaiWei) ?? 0n;
    if (t?.side === 'buy') buyQuaiWei += amt;
    else if (t?.side === 'sell') sellQuaiWei += amt;
    if (typeof t?.wallet === 'string') uniqueTraders.add(t.wallet.toLowerCase());
  }
  const totalQuaiWei = buyQuaiWei + sellQuaiWei;
  const imbalancePct = totalQuaiWei === 0n
    ? 0
    : Number(((buyQuaiWei - sellQuaiWei) * 10000n) / totalQuaiWei) / 100;
  return {
    buyQuaiWei: buyQuaiWei.toString(),
    sellQuaiWei: sellQuaiWei.toString(),
    imbalancePct, // positive = net buy pressure
    uniqueTraders: uniqueTraders.size,
    tradeCount: list.length,
  };
}

async function computeLedgerPnl(ctx, vaultState) {
  if (!ctx.ledger || !ctx.ledgerApi) {
    return { realizedPnlWei: '0', unrealizedPnlWei: '0', growthPct: 0 };
  }
  try {
    const markPrices = {};
    for (const h of vaultState?.holdings ?? []) {
      if (h?.token && h?.amountWei && h.amountWei !== '0') {
        const amt = safeBigInt(h.amountWei);
        const mark = safeBigInt(h.markValueQuaiWei);
        if (amt && amt > 0n && mark !== null) {
          markPrices[h.token] = (mark * 10n ** 18n) / amt;
        }
      }
    }
    const realizedPnlWei = ctx.ledgerApi.getRealizedPnlWei(ctx.ledger);
    const unrealizedPnlWei = ctx.ledgerApi.getUnrealizedPnlWei(ctx.ledger, markPrices);
    const fullPortfolioQuaiWei = computeFullPortfolioWei(vaultState);
    const growthPct = ctx.ledgerApi.getGrowthPct(ctx.ledger, fullPortfolioQuaiWei);
    return {
      realizedPnlWei: realizedPnlWei.toString(),
      unrealizedPnlWei: unrealizedPnlWei.toString(),
      growthPct,
    };
  } catch {
    return { realizedPnlWei: '0', unrealizedPnlWei: '0', growthPct: 0 };
  }
}

// --- read-only tools ---------------------------------------------------------------------------

/**
 * Read-only tools: market snapshot, vault status, quote, token deep-dive, trade flow, holders.
 * No key use, no writes.
 * @param {object} ctx ToolCtx
 * @returns {Array<{ name: string, description: string, inputSchema: object, handler: Function }>}
 */
export function buildReadOnlyTools(ctx) {
  if (!ctx || !ctx.api) throw new Error('src/tools: buildReadOnlyTools requires ctx.api');

  const marketTool = {
    name: 'hartii_market',
    description:
      'Sanitized snapshot of tradeable HartiiLabs tokens (market data only, no free text) plus current vault holdings.',
    inputSchema: {},
    handler: async (_args, ctxArg) => {
      const c = ctxArg || ctx;
      const [tokens, vault] = await Promise.all([
        c.api.getTokens({ sort: 'trending', limit: 50 }),
        c.vault ? c.api.getVault(c.vault) : Promise.resolve(null),
      ]);
      const candidates = (Array.isArray(tokens) ? tokens : []).filter(isTradeable).map(sanitizeTokenText);
      return {
        ok: true,
        candidates,
        holdings: vault?.holdings ?? [],
        at: new Date().toISOString(),
      };
    },
  };

  const statusTool = {
    name: 'hartii_status',
    description: 'Current vault state (balances, caps, holdings) plus realized/unrealized PnL and growth vs deposits.',
    inputSchema: {},
    handler: async (_args, ctxArg) => {
      const c = ctxArg || ctx;
      if (!c.vault) return { ok: false, error: 'ctx.vault is not configured' };
      const vault = await c.api.getVault(c.vault);
      const pnl = await computeLedgerPnl(c, vault);
      return { ok: true, ...vault, ...pnl };
    },
  };

  const quoteTool = {
    name: 'hartii_quote',
    description: 'Live buy/sell quote for a token, including price impact and minimum-out.',
    inputSchema: {
      token: z.string(),
      side: z.enum(['buy', 'sell']),
      amountWei: z.string(),
    },
    handler: async (args, ctxArg) => {
      const c = ctxArg || ctx;
      if (!isAddressLike(args?.token)) return { ok: false, error: 'invalid token address' };
      const quote = await c.api.getQuote({ token: args.token, side: args.side, amountWei: args.amountWei });
      return { ok: true, quote };
    },
  };

  const tokenDetailTool = {
    name: 'hartii_token_detail',
    description:
      'Deep-dive on one token: sanitized detail, combined liquidity, holder concentration (top10 + creator share), and curve progress toward graduation.',
    inputSchema: { token: z.string() },
    handler: async (args, ctxArg) => {
      const c = ctxArg || ctx;
      if (!isAddressLike(args?.token)) return { ok: false, error: 'invalid token address' };
      const [detail, liquidity, holders] = await Promise.all([
        c.api.getToken(args.token),
        c.api.getLiquidity(args.token).catch(() => null),
        c.api.getHolders(args.token, { limit: 10 }).catch(() => []),
      ]);
      return {
        ok: true,
        token: sanitizeTokenText(detail),
        liquidity: liquidity
          ? { totalQuai: liquidity.totalQuai ?? null, liquidityQuaiValue: liquidity.liquidityQuaiValue ?? null }
          : null,
        holderConcentration: summarizeHolders(holders, detail),
        curveProgress: computeCurveProgress(detail),
        at: new Date().toISOString(),
      };
    },
  };

  const tradeFlowTool = {
    name: 'hartii_trade_flow',
    description: 'Recent trades for a token plus buy/sell QUAI-volume imbalance and unique-trader count.',
    inputSchema: { token: z.string(), limit: z.number().int().positive().max(200).optional() },
    handler: async (args, ctxArg) => {
      const c = ctxArg || ctx;
      if (!isAddressLike(args?.token)) return { ok: false, error: 'invalid token address' };
      const trades = await c.api.getTrades(args.token, { limit: args.limit || 50 });
      return {
        ok: true,
        token: args.token,
        trades,
        flow: summarizeTradeFlow(trades),
        at: new Date().toISOString(),
      };
    },
  };

  const holdersTool = {
    name: 'hartii_holders',
    description: 'Top holders for a token plus top-10 concentration percentage.',
    inputSchema: { token: z.string(), limit: z.number().int().positive().max(200).optional() },
    handler: async (args, ctxArg) => {
      const c = ctxArg || ctx;
      if (!isAddressLike(args?.token)) return { ok: false, error: 'invalid token address' };
      const holders = await c.api.getHolders(args.token, { limit: args.limit || 50 });
      return {
        ok: true,
        token: args.token,
        holders,
        top10Pct: summarizeHolders(holders, null).top10Pct,
        at: new Date().toISOString(),
      };
    },
  };

  return [marketTool, statusTool, quoteTool, tokenDetailTool, tradeFlowTool, holdersTool];
}

// --- guarded trade tools -------------------------------------------------------------------

function tradeFailure(side, args, error, { clipped = false } = {}) {
  const amount = side === 'buy' ? args?.amountInWei : args?.tokensInWei;
  return { ok: false, clipped, amountInWei: String(amount ?? '0'), txHash: null, error, warnings: [] };
}

/**
 * Runs one proposed buy/sell through src/guard, then (if allowed) builds calldata via
 * src/chain and executes it — through ctx.paperEngine in paper mode, or
 * chain.sendVaultExecute live. Never throws: every failure mode returns { ok: false, error }.
 */
async function executeGuardedTrade(side, args, ctx, chain, guard) {
  try {
    if (!ctx.vault) return tradeFailure(side, args, 'ctx.vault is not configured');
    if (!isAddressLike(args?.token)) return tradeFailure(side, args, 'invalid token address');

    const primaryField = side === 'buy' ? 'amountInWei' : 'tokensInWei';
    const minOutField = side === 'buy' ? 'minTokensOutWei' : 'minQuaiOutWei';

    let primaryWei;
    let minOutWei;
    try {
      primaryWei = BigInt(args[primaryField]);
      minOutWei = BigInt(args[minOutField]);
    } catch {
      return tradeFailure(side, args, `${primaryField} and ${minOutField} must be decimal-string wei`);
    }
    if (primaryWei <= 0n) return tradeFailure(side, args, `${primaryField} must be > 0`);

    const slippageCheck = guard.enforceSlippageFloor(minOutWei);
    if (!slippageCheck.ok) return tradeFailure(side, args, slippageCheck.reason || 'slippage floor rejected');

    const token = chain.checksum(args.token);

    const curveAddress = await chain.curveOf(ctx.provider, chain.TOKEN_FACTORY_V1_ADDRESS, token);
    if (!curveAddress) {
      return tradeFailure(side, args, 'token has no curve registered with the V1 token factory — this vault cannot reach it');
    }

    const quote = await ctx.api.getQuote({ token, side, amountWei: primaryWei.toString() });
    const priceImpactPct = Number(quote?.priceImpact ?? 0);

    const vaultState = await ctx.api.getVault(ctx.vault);
    const fullPortfolioQuaiWei = computeFullPortfolioWei(vaultState);

    const buildInner = (amt, minOut) =>
      side === 'buy'
        ? chain.buildV1BuyCalldata(curveAddress, { amountInWei: amt, minTokensOutWei: minOut })
        : chain.buildV1SellCalldata(curveAddress, { tokensInWei: amt, minQuaiOutWei: minOut });

    const previewOuter = chain.buildVaultExecuteCalldata(ctx.vault, buildInner(primaryWei, minOutWei));
    const from = await resolveAgentAddress(ctx, chain);

    let estimatedGasCostWei;
    try {
      estimatedGasCostWei = await chain.estimateGasWei(ctx.provider, { ...previewOuter, from });
    } catch (err) {
      return tradeFailure(side, args, `gas estimation failed: ${err?.message ?? err}`);
    }

    const guardCtx = {
      fullPortfolioQuaiWei,
      estimatedGasCostWei,
      maxPriceImpactPct: resolveMaxPriceImpactPct(ctx),
      maxFractionBps: resolveMaxFractionBps(ctx),
    };

    const guardResult = side === 'buy'
      ? guard.guardBuy({ amountInWei: primaryWei, minTokensOutWei: minOutWei, priceImpactPct }, guardCtx)
      : guard.guardSell(
          { tokensInWei: primaryWei, minQuaiOutWei: minOutWei, priceImpactPct, valueOfProposedWei: safeBigInt(quote?.amountOut) ?? 0n },
          guardCtx,
        );

    if (!guardResult.ok) {
      return tradeFailure(side, args, guardResult.reason || 'rejected by guard');
    }

    const finalPrimaryWei = side === 'buy' ? guardResult.amountInWei : guardResult.tokensInWei;
    const clipped = Boolean(guardResult.clipped);
    const warnings = [];
    let finalMinOutWei = minOutWei;

    if (clipped && primaryWei > 0n && finalPrimaryWei !== primaryWei) {
      finalMinOutWei = scaleBigInt(minOutWei, finalPrimaryWei, primaryWei);
      const rescaledCheck = guard.enforceSlippageFloor(finalMinOutWei);
      if (!rescaledCheck.ok) {
        return tradeFailure(side, args, 'clipped size no longer clears the slippage floor', { clipped: true });
      }
      warnings.push(`clipped from ${primaryWei.toString()} to ${finalPrimaryWei.toString()} wei by the portfolio-fraction guard`);
    }

    const finalInner = buildInner(finalPrimaryWei, finalMinOutWei);

    let txHash = null;
    if (ctx.config?.paperMode) {
      if (!ctx.paperEngine) return tradeFailure(side, args, 'paper mode requires ctx.paperEngine to be wired', { clipped });
      const simResult = side === 'buy'
        ? await ctx.paperEngine.buy(token, finalPrimaryWei, finalMinOutWei)
        : await ctx.paperEngine.sell(token, finalPrimaryWei, finalMinOutWei);
      if (!simResult.ok) return tradeFailure(side, args, simResult.error || 'paper fill rejected', { clipped });
    } else {
      if (!ctx.wallet) return tradeFailure(side, args, 'live mode requires ctx.wallet', { clipped });
      const sendResult = await chain.sendVaultExecute(ctx.wallet, ctx.vault, finalInner);
      if (!sendResult.receipt?.status) {
        return {
          ok: false,
          clipped,
          amountInWei: finalPrimaryWei.toString(),
          txHash: sendResult.txHash ?? null,
          error: 'transaction reverted on-chain',
          warnings,
        };
      }
      txHash = sendResult.txHash;
    }

    return { ok: true, clipped, amountInWei: finalPrimaryWei.toString(), txHash, warnings };
  } catch (err) {
    return tradeFailure(side, args, `unexpected error: ${err?.message ?? err}`);
  }
}

function buildLaunchTool(ctx, guard) {
  return {
    name: 'hartii_launch_token',
    description:
      'Launch-gated tool for creating a new HartiiLabs token. Only present when launches are enabled; requires an owner-approved image URL. No on-chain launch calldata path exists yet — see INTERFACE-REQUESTS.md.',
    inputSchema: { name: z.string(), symbol: z.string(), imageUrl: z.string() },
    handler: async (args, ctxArg) => {
      const c = ctxArg || ctx;
      const launchState = c.launchState || { count: 0, lastAtMs: null };
      const gate = guard.enforceLaunchGate({
        launchesEnabled: Boolean(c.config?.launchesEnabled),
        launchCountSession: launchState.count || 0,
        lastLaunchAtMs: launchState.lastAtMs ?? null,
        nowMs: Date.now(),
        imageUrl: args?.imageUrl,
        approvedImageUrls: c.approvedImageUrls || [],
      });
      if (!gate.ok) {
        return { ok: false, clipped: false, amountInWei: '0', txHash: null, error: gate.reason, warnings: [] };
      }
      return {
        ok: false,
        clipped: false,
        amountInWei: '0',
        txHash: null,
        error: 'token-launch calldata building is not yet implemented in src/chain — see INTERFACE-REQUESTS.md',
        warnings: ['launch gate passed but no on-chain launch path exists yet'],
      };
    },
  };
}

/**
 * Guarded trade tools: hartii_buy / hartii_sell run every proposed size through src/guard
 * before src/chain ever builds calldata. hartii_launch_token is included only when
 * ctx.config.launchesEnabled is true. There is no hartii_launch_nft tool — ever.
 * @param {object} ctx ToolCtx
 * @returns {Array<{ name: string, description: string, inputSchema: object, handler: Function }>}
 */
export function buildTradeTools(ctx) {
  if (!ctx || !ctx.api) throw new Error('src/tools: buildTradeTools requires ctx.api');
  if (!ctx.config) throw new Error('src/tools: buildTradeTools requires ctx.config');

  const chain = ctx.chain || defaultChain;
  const guard = ctx.guard || defaultGuard;

  const buyTool = {
    name: 'hartii_buy',
    description:
      'Guarded buy of a HartiiLabs token through the AgentVault. Every proposed size is clipped or rejected by code-level guards before anything is built or sent — a returned amount smaller than requested means the guard clipped it, not an error.',
    inputSchema: { token: z.string(), amountInWei: z.string(), minTokensOutWei: z.string() },
    handler: (args, ctxArg) => executeGuardedTrade('buy', args, ctxArg || ctx, chain, guard),
  };

  const sellTool = {
    name: 'hartii_sell',
    description: 'Guarded sell of a HartiiLabs token through the AgentVault. Same guard pipeline as hartii_buy.',
    inputSchema: { token: z.string(), tokensInWei: z.string(), minQuaiOutWei: z.string() },
    handler: (args, ctxArg) => executeGuardedTrade('sell', args, ctxArg || ctx, chain, guard),
  };

  const tools = [buyTool, sellTool];
  if (ctx.config.launchesEnabled) tools.push(buildLaunchTool(ctx, guard));
  return tools;
}

// --- MCP stdio server + allowlists -----------------------------------------------------------

/**
 * Tool-name allowlists per agent role — the literal --allowedTools list passed to each
 * sandboxed `claude -p` invocation. There is no NFT-deploy tool, ever, in any list.
 */
export const TOOL_ALLOWLISTS = Object.freeze({
  momentumScout: Object.freeze(['hartii_market', 'hartii_trade_flow']),
  riskAnalyst: Object.freeze(['hartii_market', 'hartii_token_detail', 'hartii_holders', 'hartii_trade_flow']),
  portfolioManager: Object.freeze(['hartii_market', 'hartii_status']),
  decider: Object.freeze(['hartii_market', 'hartii_status', 'hartii_quote', 'hartii_buy', 'hartii_sell']),
});

/**
 * Resolves the actual --allowedTools list for a role given the active config — appends
 * 'hartii_launch_token' to the decider's list only when launches are enabled.
 * @param {'momentumScout'|'riskAnalyst'|'portfolioManager'|'decider'} role
 * @param {{ launchesEnabled?: boolean }} [config]
 * @returns {string[]}
 */
export function resolveAllowlist(role, config = {}) {
  const base = TOOL_ALLOWLISTS[role];
  if (!base) throw new Error(`src/tools: unknown role "${role}"`);
  if (role === 'decider' && config.launchesEnabled) return [...base, 'hartii_launch_token'];
  return [...base];
}

/**
 * @param {Array<{ name: string, description: string, inputSchema: object, handler: Function }>} tools
 * @param {{ name: string, version?: string }} opts
 * @returns {McpServer}
 */
export function createMcpServer(tools, opts) {
  if (!opts?.name) throw new Error('src/tools: createMcpServer requires opts.name');
  if (!Array.isArray(tools)) throw new TypeError('src/tools: createMcpServer requires a tools array');

  const server = new McpServer({ name: opts.name, version: opts.version || '0.1.0' });

  for (const toolDef of tools) {
    server.registerTool(
      toolDef.name,
      { description: toolDef.description, inputSchema: toolDef.inputSchema || {} },
      async (args) => {
        let result;
        try {
          result = await toolDef.handler(args);
        } catch (err) {
          result = { ok: false, error: err?.message ?? String(err) };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );
  }

  return server;
}

/**
 * Connects an already-built McpServer to a stdio transport. Not part of the pinned
 * INTERFACES.md surface, but the natural companion to createMcpServer for bin/run.mjs.
 * @param {McpServer} server
 */
export async function serveStdio(server) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
