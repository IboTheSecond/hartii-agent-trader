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

/**
 * Percentage price impact of one quoted trade vs. the token's current spot price — the live
 * `/api/agent/quote` endpoint reports no `priceImpact` field at all (see src/data#getQuote), so
 * this computes it from the quote's own implied average execution price against
 * `detail.lastPriceWei` (fetched via `ctx.api.getToken`, cached, so this is a cheap call in
 * practice). Returns `NaN` — never a fabricated `0` — on any failure (missing/invalid quote
 * amount, a getToken failure, an unknown/zero spot price): `src/guard#enforcePriceImpact`
 * already rejects a non-finite `priceImpactPct` outright, so an unknown price impact fails
 * closed exactly like an excessive one, never silently passes as "0% impact".
 * @returns {Promise<number>}
 */
async function computePriceImpactPct(ctx, { side, token, primaryWei, quote }) {
  if (typeof quote?.priceImpact === 'number' && Number.isFinite(quote.priceImpact)) {
    return quote.priceImpact; // the API provided one directly — trust it over a derived estimate.
  }
  const amountOutWei = safeBigInt(quote?.amountOut);
  if (amountOutWei === null || amountOutWei <= 0n || primaryWei <= 0n) return NaN;

  let spotPriceWei;
  try {
    const detail = await ctx.api.getToken(token);
    spotPriceWei = safeBigInt(detail?.lastPriceWei);
  } catch {
    return NaN;
  }
  if (spotPriceWei === null || spotPriceWei <= 0n) return NaN;

  const SCALE = 10n ** 18n;
  // side === 'buy': primaryWei is QUAI in, amountOutWei is tokens out — avg QUAI paid per 1e18
  // tokens. side === 'sell': primaryWei is tokens in, amountOutWei is QUAI out — avg QUAI
  // received per 1e18 tokens. Both compare that average against the current spot price, as a
  // positive percentage only when the fill is worse than spot (never negative — a fill at or
  // better than spot is 0% impact, not a "negative impact").
  const avgPriceWei = side === 'buy' ? (primaryWei * SCALE) / amountOutWei : (amountOutWei * SCALE) / primaryWei;
  const worseThanSpot = side === 'buy' ? avgPriceWei > spotPriceWei : avgPriceWei < spotPriceWei;
  if (!worseThanSpot) return 0;
  const diff = side === 'buy' ? avgPriceWei - spotPriceWei : spotPriceWei - avgPriceWei;
  return Number((diff * 10000n) / spotPriceWei) / 100;
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

/** `holder.pct` as a plain number, computed against `totalSupplyWei` when the row itself doesn't
 * already carry one — the live API's holder rows report no percentage at all (see
 * src/data#normalizeHolder), so this is how one gets computed at all. Returns 0 (never NaN) when
 * neither is available. */
function holderPct(holder, totalSupplyWei) {
  if (typeof holder?.pct === 'number') return holder.pct;
  const amount = safeBigInt(holder?.amountWei);
  if (amount === null || amount <= 0n || totalSupplyWei === null || totalSupplyWei <= 0n) return 0;
  return Number((amount * 1000000n) / totalSupplyWei) / 10000; // 4 decimal places, no float division of bigints
}

/** Top-10 + creator holder concentration, defensive against missing fields. `detail` (when
 * given) supplies `totalSupplyWei` to compute each holder's pct on the fly whenever the row
 * itself doesn't already carry one (see holderPct above). */
function summarizeHolders(holders, detail) {
  const list = Array.isArray(holders) ? holders : [];
  const totalSupplyWei = safeBigInt(detail?.totalSupplyWei);
  const top10PctSum = list.slice(0, 10).reduce((sum, h) => sum + holderPct(h, totalSupplyWei), 0);
  const creator = typeof detail?.creator === 'string' ? detail.creator.toLowerCase() : null;
  const creatorHolder = creator
    ? list.find((h) => typeof h?.wallet === 'string' && h.wallet.toLowerCase() === creator)
    : null;
  return {
    top10Pct: Number(top10PctSum.toFixed(2)),
    creatorPct: creatorHolder ? holderPct(creatorHolder, totalSupplyWei) : null,
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

// Used only when paper mode has no real vault configured at all (no HARTII_VAULT_ADDRESS) — a
// documented approximate gas-cost fallback for the 5x-gas guard floor, matching the task brief's
// own HARTII CHAIN FACTS ("Gas ~26k gwei => ~3-4 QUAI per vault trade"), since there is no
// deployed vault.execute() target to preview a real gas estimate against. Whenever a vault IS
// configured (even an unfunded one, even in paper mode — see README's recommendation), the real
// chain.estimateGasWei path below is used instead of this constant.
export const DEFAULT_PAPER_GAS_ESTIMATE_WEI = 4n * 10n ** 18n;

/**
 * Paper-mode, vault-shaped portfolio state built from the PaperEngine's own cash + positions —
 * used in place of a live ctx.api.getVault(ctx.vault) read whenever paper mode has no real vault
 * configured (nothing paper does ever needs the real vault; see src/runner's own paper-mode
 * stance and INTERFACE-REQUESTS.md item 3). Each holding's mark value comes from a best-effort
 * live sell quote — a quote failure degrades that one holding to a 0 mark rather than failing the
 * whole call, since an unknown mark must never block guard sizing or status reporting.
 * @param {object} ctx ToolCtx (ctx.paperEngine must be wired)
 * @returns {Promise<{ quaiBalanceWei: string, holdings: Array<{ token: string, amountWei: string, markValueQuaiWei: string }>, paused: boolean }>}
 */
async function buildPaperVaultState(ctx) {
  const state = ctx.paperEngine.getState();
  const holdings = [];
  for (const [token, amountWei] of Object.entries(state.positions)) {
    let markValueQuaiWei = '0';
    try {
      const quote = await ctx.api.getQuote({ token, side: 'sell', amountWei: amountWei.toString() });
      markValueQuaiWei = (safeBigInt(quote?.amountOut) ?? 0n).toString();
    } catch {
      /* best-effort mark only — see doc comment above */
    }
    holdings.push({ token, amountWei: amountWei.toString(), markValueQuaiWei });
  }
  return { quaiBalanceWei: state.quaiWei.toString(), holdings, paused: false };
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
      // Paper mode never needs the real vault — a configured one is read for extra realism when
      // present, but a pure paper session (no HARTII_VAULT_ADDRESS at all) still works, derived
      // from the PaperEngine itself. See buildPaperVaultState's doc comment.
      if (c.config?.paperMode && !c.vault) {
        if (!c.paperEngine) return { ok: false, error: 'paper mode requires ctx.paperEngine to be wired' };
        const vault = await buildPaperVaultState(c);
        const pnl = await computeLedgerPnl(c, vault);
        return { ok: true, ...vault, ...pnl };
      }
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
      // getToken (for totalSupplyWei, to compute each holder's pct — see summarizeHolders/
      // holderPct) is best-effort: a failure never blocks returning the holder list itself, it
      // just leaves top10Pct at 0 the same as if totalSupplyWei were simply unavailable.
      const [holders, detail] = await Promise.all([
        c.api.getHolders(args.token, { limit: args.limit || 50 }),
        c.api.getToken(args.token).catch(() => null),
      ]);
      return {
        ok: true,
        token: args.token,
        holders,
        top10Pct: summarizeHolders(holders, detail).top10Pct,
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
    const paperMode = Boolean(ctx.config?.paperMode);
    // A real vault is required in live mode (it's the only thing that ever gets signed against).
    // Paper mode never needs one — see buildPaperVaultState below — so this only rejects the live
    // case; whether ctx.paperEngine itself is wired is still checked lazily, at the point each
    // paper-mode-only step actually needs it (matches this function's existing "fail where the
    // dependency is actually used" ordering, unchanged from before this paper-mode-without-a-
    // vault path existed).
    if (!paperMode && !ctx.vault) return tradeFailure(side, args, 'ctx.vault is not configured');
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
    const priceImpactPct = await computePriceImpactPct(ctx, { side, token, primaryWei, quote });

    // Portfolio sizing context: a real vault read whenever one is configured (live mode always
    // has one; paper mode may optionally have an unfunded one for extra realism per README), or
    // — pure paper mode with no vault at all — the PaperEngine's own cash + best-effort-marked
    // holdings. Nothing paper does ever needs the real vault. (paperMode is guaranteed true here
    // whenever ctx.vault is falsy — the top-of-function check above already rejected the live+no-
    // vault case — so an unwired ctx.paperEngine at this point is unambiguously this error.)
    if (!ctx.vault && !ctx.paperEngine) {
      return tradeFailure(side, args, 'paper mode requires ctx.paperEngine to be wired');
    }
    const vaultState = ctx.vault ? await ctx.api.getVault(ctx.vault) : await buildPaperVaultState(ctx);
    const fullPortfolioQuaiWei = computeFullPortfolioWei(vaultState);

    const buildInner = (amt, minOut) =>
      side === 'buy'
        ? chain.buildV1BuyCalldata(curveAddress, { amountInWei: amt, minTokensOutWei: minOut })
        : chain.buildV1SellCalldata(curveAddress, { tokensInWei: amt, minQuaiOutWei: minOut });

    // Gas estimate: a real preview against the configured vault when one exists — the only way to
    // get a genuine gas figure, since it depends on the deployed contract actually being called —
    // or, pure paper mode with nothing to preview against, the documented approximate fallback
    // above.
    let estimatedGasCostWei;
    if (ctx.vault) {
      const previewOuter = chain.buildVaultExecuteCalldata(ctx.vault, buildInner(primaryWei, minOutWei));
      const from = await resolveAgentAddress(ctx, chain);
      try {
        estimatedGasCostWei = await chain.estimateGasWei(ctx.provider, { ...previewOuter, from });
      } catch (err) {
        return tradeFailure(side, args, `gas estimation failed: ${err?.message ?? err}`);
      }
    } else {
      estimatedGasCostWei = DEFAULT_PAPER_GAS_ESTIMATE_WEI;
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
    // The actual output leg of the fill (tokens received on a buy, QUAI received on a sell) —
    // additive beyond the pinned {ok,clipped,amountInWei,txHash,warnings} tool-response shape,
    // surfaced so the decider's own final JSON (DeciderAction.amountOutWei — see
    // src/agents/schema.mjs) can carry it through to src/runner#buildTradeRecord, which already
    // knows how to consume it. Without this, every recorded trade's tokens/price came back as 0
    // (confirmed live: a real paper BUY reported "0 ART out, price: 0 QUAI/token" and left the
    // ledger position amount at 0 — see INTERFACE-REQUESTS.md's integration entry) since neither
    // the decider nor src/runner had any other way to learn what was actually filled.
    let amountOutWei = null;
    let gasWei = null;
    if (paperMode) {
      if (!ctx.paperEngine) return tradeFailure(side, args, 'paper mode requires ctx.paperEngine to be wired', { clipped });
      const simResult = side === 'buy'
        ? await ctx.paperEngine.buy(token, finalPrimaryWei, finalMinOutWei)
        : await ctx.paperEngine.sell(token, finalPrimaryWei, finalMinOutWei);
      if (!simResult.ok) return tradeFailure(side, args, simResult.error || 'paper fill rejected', { clipped });
      const filled = side === 'buy' ? simResult.filledTokensWei : simResult.filledQuaiWei;
      amountOutWei = (filled ?? 0n).toString();
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
      gasWei = sendResult.receipt?.gasUsedWei != null ? sendResult.receipt.gasUsedWei.toString() : null;
      // amountOutWei stays null for a live fill — this repo has no event-log decoder for the
      // curve's Buy/Sell event yet, so the real output amount isn't independently knowable here;
      // fabricating one from a quote would misrepresent an actual on-chain fill. Low priority:
      // this build never sends a real transaction (see HARD RULES), so the live path is
      // untested/unexercised regardless.
    }

    return { ok: true, clipped, amountInWei: finalPrimaryWei.toString(), amountOutWei, txHash, gasWei, warnings };
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
