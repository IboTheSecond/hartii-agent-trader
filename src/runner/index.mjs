// src/runner — cycle orchestration, loop, stop conditions, status.json, the paper/live
// switch. The only module allowed to decide whether src/chain's sending functions ever run
// (indirectly: it never calls src/chain's send* functions itself — src/tools' guarded trade
// handlers do, routed by ctx.config.paperMode, which src/tools reads. runCycle just orchestrates
// the pipeline and records/reports whatever src/agents' decider actually executed).
// Contract: see INTERFACES.md#src-runner.
//
// --- Dependency injection beyond the pinned RunnerCtx shape --------------------------------
// RunnerCtx per INTERFACES.md is `{ config, api, provider, wallet, ledger, reporter }`. This
// module also reads an ADDITIONAL, OPTIONAL `ctx.deps` bag — every key defaults to the real
// sibling module, so production callers (bin/run.mjs) never need to pass it, and every exported
// function here is still called exactly as INTERFACES.md pins (`runCycle(ctx)`, `shouldStop(ctx)`,
// `runLoop(ctx, { intervalMs?, maxCycles? })`). Tests pass `ctx.deps` overrides so this module's
// own suite never has to depend on src/ledger, src/agents, src/guard or src/chain actually being
// implemented yet (see INTERFACES.md's own cross-cutting rule: "every function ... takes its
// dependency as a parameter ... tests inject a fake" — this is that rule applied one level up,
// at composition time, since runCycle's real dependencies are whole sibling modules, not a
// single fetch/provider/spawn call). See INTERFACE-REQUESTS.md for the couple of places this
// module had to make a judgment call the interface didn't fully pin (DeciderResult.actions'
// exact fields, the cadence knobs, the gas/capital-exhausted thresholds).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import * as ledgerModule from '../ledger/index.mjs';
import * as agentsModule from '../agents/index.mjs';
import * as guardModule from '../guard/index.mjs';
import * as chainModule from '../chain/index.mjs';
import * as simModule from '../sim/index.mjs';
import { sanitizeTokenText as defaultSanitizeTokenText } from '../data/index.mjs';
import { getProfile as defaultGetProfile } from '../config/index.mjs';

const WEI_PER_QUAI = 10n ** 18n;

// Owner spec ("very often trading", "a lot of trades" — see the task brief and the proven
// reference prototype's lib/pace.mjs): a short randomized pause between cycles, not the 5-minute
// fixed default `config.cycleIntervalMs` currently defaults to. runLoop's pinned opts still take
// a single `intervalMs` (used as-is, unjittered, when given — e.g. for deterministic tests or an
// operator who explicitly wants a fixed cadence); left unset, it jitters in this range instead.
// See INTERFACE-REQUESTS.md: recommend src/config grow a HARTII_PAUSE_MIN_MS/_MAX_MS pair.
export const DEFAULT_PAUSE_MIN_MS = 20_000;
export const DEFAULT_PAUSE_MAX_MS = 60_000;
export const DEFAULT_MAX_SESSION_MS = 6 * 60 * 60 * 1000; // 6h, matches the reference prototype
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
// Neither of these has a pinned Config field (see INTERFACE-REQUESTS.md) — ctx.config may
// optionally carry `minGasReserveWei` / `capitalExhaustedThresholdWei` (decimal-string or bigint)
// to override; absent that, these conservative defaults apply.
export const DEFAULT_GAS_RESERVE_WEI = 10n * WEI_PER_QUAI; // 10 QUAI gas floor for the agent EOA
export const DEFAULT_CAPITAL_EXHAUSTED_THRESHOLD_WEI = 2n * WEI_PER_QUAI; // 2 QUAI total vault value

function toBigIntSafe(v) {
  try {
    if (v === undefined || v === null) return 0n;
    return typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    return 0n;
  }
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function jitteredPause(minMs, maxMs, randomFn = Math.random) {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return Math.floor(lo + randomFn() * (hi - lo));
}

function safeConsoleError(context, err) {
  try {
    console.error(`[runner] ${context}: ${err?.message || err}`);
  } catch {
    /* logging must never itself throw */
  }
}

async function safeReportBlocked(reporter, reason) {
  try {
    await reporter?.reportBlocked?.(reason);
  } catch (err) {
    safeConsoleError('reportBlocked failed', err);
  }
}

async function safeReportTrade(reporter, trade, snapshot) {
  try {
    await reporter?.reportTrade?.(trade, snapshot);
  } catch (err) {
    safeConsoleError('reportTrade failed', err);
  }
}

function defaultDeps() {
  return {
    ledger: ledgerModule,
    agents: agentsModule,
    guard: guardModule,
    chain: chainModule,
    sim: simModule,
    sanitizeTokenText: defaultSanitizeTokenText,
    getProfile: defaultGetProfile,
    now: () => Date.now(),
    randomFn: Math.random,
    sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    idFn: () => randomUUID(),
    readStatusImpl: (p) => readFile(p, 'utf8'),
    writeStatusImpl: async (p, content) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    },
  };
}

function resolveDeps(ctx) {
  return { ...defaultDeps(), ...(ctx?.deps || {}) };
}

// Tokens whose API-reported status marks them as something the agent must never trade, mirroring
// hartii_market's documented `tradeable: true`-only filter. Anything not in this set is treated
// as tradeable by default (inclusive), since the exact status vocabulary isn't pinned in
// INTERFACES.md's TokenListItem — see INTERFACE-REQUESTS.md.
const BLOCKED_TOKEN_STATUSES = new Set(['hidden', 'flagged', 'rugged', 'delisted', 'banned', 'paused']);

function buildMarketCandidates(tokens, sanitizeTokenText) {
  return (tokens || [])
    .filter((t) => t && t.address && t.symbol && !BLOCKED_TOKEN_STATUSES.has(String(t.status || '').toLowerCase()))
    .map((t) => ({ ...sanitizeTokenText(t), tradeable: true }));
}

function sumHoldingsMarkValue(holdings) {
  return (holdings || []).reduce((sum, h) => sum + toBigIntSafe(h?.markValueQuaiWei), 0n);
}

function buildPortfolio(vault) {
  const quaiWei = toBigIntSafe(vault?.quaiBalanceWei);
  const totalValueWei = quaiWei + sumHoldingsMarkValue(vault?.holdings);
  return { quaiWei, totalValueWei };
}

/**
 * Paper mode never reads a real vault for portfolio/holdings — even when a real vaultAddress is
 * configured for market-context rehearsal, a paper trade never touches it, so treating its live
 * balance as "the paper portfolio" would be simply wrong. src/ledger is the durable, correct
 * source of truth for paper state instead (see src/sim#derivePaperPortfolioFromLedger). Mark
 * values are estimated from each held token's last trade price in the already-fetched `market`
 * snapshot — deliberately not an extra live quote per holding (see INTERFACE-REQUESTS.md).
 */
function buildPaperHoldings(ledger, market) {
  const holdings = [];
  for (const [token, pos] of Object.entries(ledger?.positions || {})) {
    const amountWei = toBigIntSafe(pos?.amountWei);
    if (amountWei <= 0n) continue;
    const candidate = (market || []).find((m) => sameAddress(m.address, token));
    const priceWei = toBigIntSafe(candidate?.lastPriceWei);
    const markValueQuaiWei = (amountWei * priceWei) / WEI_PER_QUAI;
    holdings.push({
      token,
      symbol: pos.symbol || candidate?.symbol || null,
      amountWei: amountWei.toString(),
      avgCostQuaiWei: pos.avgCostQuaiWei ?? '0',
      markValueQuaiWei: markValueQuaiWei.toString(),
    });
  }
  return holdings;
}

function buildPaperPortfolio(ledger, holdings, deps) {
  const { quaiWei } = deps.sim.derivePaperPortfolioFromLedger(ledger);
  const totalValueWei = quaiWei + sumHoldingsMarkValue(holdings);
  return { quaiWei, totalValueWei };
}

function buildMarkPricesByToken(holdings) {
  const out = {};
  for (const h of holdings || []) {
    const amount = toBigIntSafe(h?.amountWei);
    if (amount > 0n) out[h.token] = (toBigIntSafe(h?.markValueQuaiWei) * WEI_PER_QUAI) / amount;
  }
  return out;
}

function emptyDecider(reason) {
  return { actions: [], reasoning: '', skipped: reason };
}

/**
 * Builds a ledger-ready TradeRecord from one executed DeciderResult action. INTERFACES.md's
 * `DeciderResult.actions` entry is thin (`{ token, side, amountWei, txHash, ok, warnings }`) —
 * `amountWei` is that action's INPUT amount (QUAI-in for a buy, tokens-in for a sell), matching
 * the guarded hartii_buy/hartii_sell tool args it came from. The output leg, price, gas and a
 * per-action reason aren't in the pinned shape; this reads them from optional extra fields when
 * an implementation provides them (`amountOutWei`, `priceQuaiPerTokenWei`, `gasWei`, `symbol`,
 * `reason`) and falls back sanely otherwise. See INTERFACE-REQUESTS.md — src/agents should grow
 * these fields so this stops being a best-effort reconstruction.
 */
function buildTradeRecord({ action, market, atMs, paperMode, fallbackReason }) {
  const candidate = (market || []).find((m) => sameAddress(m.address, action.token));
  const symbol = action.symbol || candidate?.symbol || null;
  const isBuy = action.side === 'buy';
  const primaryWei = toBigIntSafe(action.amountWei);
  const secondaryWei = action.amountOutWei !== undefined ? toBigIntSafe(action.amountOutWei) : 0n;
  const amountQuaiWei = isBuy ? primaryWei : secondaryWei;
  const amountTokenWei = isBuy ? secondaryWei : primaryWei;
  const priceQuaiPerTokenWei =
    action.priceQuaiPerTokenWei !== undefined
      ? toBigIntSafe(action.priceQuaiPerTokenWei)
      : amountTokenWei > 0n
        ? (amountQuaiWei * WEI_PER_QUAI) / amountTokenWei
        : 0n;

  return {
    id: randomUUID(),
    atMs,
    side: action.side,
    token: action.token,
    symbol,
    amountQuaiWei: amountQuaiWei.toString(),
    amountTokenWei: amountTokenWei.toString(),
    priceQuaiPerTokenWei: priceQuaiPerTokenWei.toString(),
    txHash: action.txHash ?? null,
    gasWei: action.gasWei !== undefined && action.gasWei !== null ? toBigIntSafe(action.gasWei).toString() : null,
    reason: action.reason || fallbackReason || '(no reason given)',
    paper: paperMode,
  };
}

function buildSnapshot(ledger, portfolio, holdings, deps) {
  let realizedPnlWei = 0n;
  let unrealizedPnlWei = 0n;
  let growthPct = 0;
  let recentTrades = (ledger?.trades || []).slice(-5);

  try {
    realizedPnlWei = deps.ledger.getRealizedPnlWei(ledger);
  } catch (err) {
    safeConsoleError('getRealizedPnlWei failed', err);
  }
  try {
    unrealizedPnlWei = deps.ledger.getUnrealizedPnlWei(ledger, buildMarkPricesByToken(holdings));
  } catch (err) {
    safeConsoleError('getUnrealizedPnlWei failed', err);
  }
  try {
    growthPct = deps.ledger.getGrowthPct(ledger, portfolio.totalValueWei);
  } catch (err) {
    safeConsoleError('getGrowthPct failed', err);
  }
  try {
    recentTrades = deps.ledger.getRecentTrades(ledger, 5);
  } catch (err) {
    safeConsoleError('getRecentTrades failed', err);
  }

  return {
    quaiWei: portfolio.quaiWei.toString(),
    totalValueWei: portfolio.totalValueWei.toString(),
    holdings,
    recentTrades,
    realizedPnlWei: realizedPnlWei.toString(),
    unrealizedPnlWei: unrealizedPnlWei.toString(),
    gasSpentWei: (toBigIntSafe(ledger?.gasSpentWei)).toString(),
    growthPct: Number.isFinite(growthPct) ? growthPct : 0,
  };
}

async function writeCycleStatus(ctx, deps, { paperMode, lastError, portfolio }) {
  const prior = await readStatus(ctx.config.statusFile, deps.readStatusImpl).catch(() => null);
  const cyclesRun = (prior?.cyclesRun || 0) + 1;
  const resolvedPortfolio =
    portfolio ||
    (prior?.portfolio
      ? { quaiWei: toBigIntSafe(prior.portfolio.quaiWei), totalValueWei: toBigIntSafe(prior.portfolio.totalValueWei) }
      : { quaiWei: 0n, totalValueWei: 0n });

  let realizedPnlWei = 0n;
  let growthPct = 0;
  try {
    realizedPnlWei = deps.ledger.getRealizedPnlWei(ctx.ledger);
  } catch (err) {
    safeConsoleError('status: getRealizedPnlWei failed', err);
  }
  try {
    growthPct = deps.ledger.getGrowthPct(ctx.ledger, resolvedPortfolio.totalValueWei);
  } catch (err) {
    safeConsoleError('status: getGrowthPct failed', err);
  }

  const status = {
    lastCycleAtMs: deps.now(),
    cyclesRun,
    paperMode,
    portfolio: { quaiWei: resolvedPortfolio.quaiWei.toString(), totalValueWei: resolvedPortfolio.totalValueWei.toString() },
    realizedPnlWei: realizedPnlWei.toString(),
    growthPct: Number.isFinite(growthPct) ? growthPct : 0,
    lastError: lastError || null,
  };

  try {
    await writeStatus(ctx.config.statusFile, status, deps.writeStatusImpl);
  } catch (err) {
    safeConsoleError('writeStatus failed', err);
  }
  return status;
}

/**
 * Order: checkKillSwitch -> data.getVault + data.getTokens -> runAnalystsInParallel ->
 * runDecider (guarded tools; paperMode routes trade-tool handlers to src/sim instead of
 * src/chain#sendVaultExecute) -> ledger.recordTrade per action -> report.reportTrade per
 * action -> writeStatus.
 * @param {object} ctx RunnerCtx
 * @returns {Promise<object>} CycleResult
 */
export async function runCycle(ctx) {
  const deps = resolveDeps(ctx);
  const cycleId = deps.idFn();
  const atMs = deps.now();
  const paperMode = !!ctx.config?.paperMode;

  async function finish(decider, extra = {}, portfolio) {
    const status = await writeCycleStatus(ctx, deps, { paperMode, lastError: extra.error || null, portfolio });
    return { cycleId, atMs, decider, stopped: false, status, ...extra };
  }

  // 1. Kill switch, checked before any tool/model call — belt-and-braces alongside shouldStop(),
  // which runLoop also checks between cycles.
  let killed = false;
  try {
    killed = await deps.guard.checkKillSwitch(ctx.config.killSwitchFile);
  } catch (err) {
    const msg = `kill-switch check failed: ${err?.message || err}`;
    return finish(emptyDecider(msg), { error: msg });
  }
  if (killed) {
    await safeReportBlocked(ctx.reporter, 'kill switch active');
    return finish(emptyDecider('kill switch active'), { stopped: true, stopReason: 'kill-switch' });
  }

  try {
    // 2. Vault + market snapshot. Paper mode never reads (or needs) the real vault for
    // portfolio/holdings — see buildPaperHoldings/buildPaperPortfolio above — but still checks a
    // configured vault's `paused` flag as a courtesy signal (never a stop condition on its own
    // in paper mode, since nothing paper does actually touches that vault).
    let vault = null;
    if (ctx.config.vaultAddress) {
      vault = await ctx.api.getVault(ctx.config.vaultAddress);
      if (vault?.paused && !paperMode) {
        await safeReportBlocked(ctx.reporter, 'vault paused');
        return finish(emptyDecider('vault paused'), { stopped: true, stopReason: 'vault-paused' }, buildPortfolio(vault));
      }
    }
    const tokens = await ctx.api.getTokens();
    const market = buildMarketCandidates(tokens, deps.sanitizeTokenText);
    const holdings = paperMode ? buildPaperHoldings(ctx.ledger, market) : vault?.holdings || [];
    const portfolio = paperMode ? buildPaperPortfolio(ctx.ledger, holdings, deps) : buildPortfolio(vault);

    // 3. Memory journal — non-fatal: a missing/corrupt journal must never block a cycle, it just
    // means the agents run without recent-lessons context this time.
    let memorySummary = '';
    try {
      const entries = await deps.agents.loadMemoryJournal(ctx.config.memoryFile);
      memorySummary = deps.agents.summarizeMemory(entries);
    } catch (err) {
      safeConsoleError('memory journal load failed (continuing with no memory context)', err);
    }

    const profile = deps.getProfile(ctx.config.profile);

    // 4. Analysts, in parallel — each is independently fault-tolerant per INTERFACES.md
    // (src/agents#runAnalystsInParallel never lets one analyst's failure fail the others).
    // `mcpServerEnv: process.env` — see INTERFACE-REQUESTS.md: src/agents' spawned MCP-server
    // subprocess (bin/mcp-server.mjs) needs the same HARTII_*/TELEGRAM_*/NTFY_* env this process
    // has, and src/agents' own default for that option is an EMPTY env object, not "inherit".
    const proposals = await deps.agents.runAnalystsInParallel({ market, holdings, memorySummary, profile }, { mcpServerEnv: process.env });

    // 5. Decider — reconciles proposals into guarded, already-executed (paper or live,
    // transparently) actions via src/tools. runCycle records and reports the outcome; it never
    // re-decides or re-executes a trade itself.
    const deciderResult = await deps.agents.runDecider(
      {
        proposals,
        market,
        holdings,
        portfolio: { quaiWei: portfolio.quaiWei.toString(), totalValueWei: portfolio.totalValueWei.toString() },
        memorySummary,
        profile,
        maxActions: ctx.config.maxActionsPerCycle,
      },
      { mcpServerEnv: process.env },
    );

    // Belt-and-braces cap: never act on more than configured, even if the decider misbehaves.
    const cap = ctx.config.maxActionsPerCycle;
    const actions = Number.isFinite(cap) ? (deciderResult.actions || []).slice(0, cap) : deciderResult.actions || [];

    // 6. Record + report each executed action. `portfolio`/`holdings` above are (deliberately)
    // the start-of-cycle snapshot the analysts/decider actually reasoned against — left
    // unchanged. `livePortfolio`/`liveHoldings` track what this cycle's own trades have done so
    // far: in paper mode, cheaply recomputed from the ledger after each recorded trade (pure
    // math, no I/O) so a cycle's 2nd/3rd action's own report — and this cycle's final
    // status.json — reflect what already happened this cycle, not a stale pre-cycle balance
    // (confirmed live: a real paper buy's own report showed the PRE-trade QUAI balance,
    // unchanged by the trade it was reporting — see INTERFACE-REQUESTS.md's integration entry).
    // Live mode keeps one point-in-time vault read for the whole cycle, unchanged from before —
    // re-reading the real vault after every action is a live-mode-only cost/latency tradeoff not
    // exercised by this pass.
    let ledger = ctx.ledger;
    let liveHoldings = holdings;
    let livePortfolio = portfolio;
    for (const action of actions) {
      if (!action || action.ok !== true) continue; // only executed actions become ledger entries
      const trade = buildTradeRecord({ action, market, atMs: deps.now(), paperMode, fallbackReason: deciderResult.reasoning });
      try {
        ledger = deps.ledger.recordTrade(ledger, trade);
        if (trade.gasWei) {
          ledger = deps.ledger.recordGas(ledger, { gasWei: BigInt(trade.gasWei), atMs: trade.atMs, txHash: trade.txHash });
        }
      } catch (err) {
        safeConsoleError(`recordTrade failed for ${trade.token}`, err);
        continue; // don't let one bad record block reporting/saving the rest of the cycle
      }
      if (paperMode) {
        liveHoldings = buildPaperHoldings(ledger, market);
        livePortfolio = buildPaperPortfolio(ledger, liveHoldings, deps);
      }
      const snapshot = buildSnapshot(ledger, livePortfolio, liveHoldings, deps);
      await safeReportTrade(ctx.reporter, trade, snapshot);
    }
    ctx.ledger = ledger; // carry forward so a runLoop's next iteration sees this cycle's trades

    try {
      await deps.ledger.saveLedger(ctx.config.ledgerFile, ledger);
    } catch (err) {
      safeConsoleError('saveLedger failed', err);
    }

    return finish({ ...deciderResult, actions }, {}, livePortfolio);
  } catch (err) {
    const msg = err?.message || String(err);
    await safeReportBlocked(ctx.reporter, `cycle error: ${msg}`);
    return finish(emptyDecider(`cycle error: ${msg}`), { error: msg });
  }
}

/**
 * Kill-switch file present, OR agent EOA gas below the configured floor, OR vault paused=true,
 * OR the vault's total value has fallen below a dust "capital exhausted" threshold. Each check
 * degrades gracefully on its own transient failure (a flaky RPC/API read must never itself halt
 * a live session) — real, persistent outages surface instead via runLoop's consecutive-failure
 * counter, a different and more deliberate stop path.
 * @returns {Promise<{ stop: boolean, reason?: string }>}
 */
export async function shouldStop(ctx) {
  const deps = resolveDeps(ctx);
  const paperMode = !!ctx.config?.paperMode;

  try {
    if (await deps.guard.checkKillSwitch(ctx.config.killSwitchFile)) {
      return { stop: true, reason: 'kill-switch' };
    }
  } catch (err) {
    safeConsoleError('shouldStop: checkKillSwitch failed (treating as not-stopped)', err);
  }

  if (ctx.wallet?.address && ctx.provider) {
    try {
      const gasWei = await deps.chain.getQuaiBalanceWei(ctx.provider, ctx.wallet.address);
      const reserve = ctx.config.minGasReserveWei !== undefined ? toBigIntSafe(ctx.config.minGasReserveWei) : DEFAULT_GAS_RESERVE_WEI;
      const check = deps.guard.enforceGasReserve(gasWei, reserve);
      if (!check.ok) return { stop: true, reason: 'gas-floor' };
    } catch (err) {
      safeConsoleError('shouldStop: gas balance check failed (treating as not-stopped)', err);
    }
  }

  const threshold =
    ctx.config.capitalExhaustedThresholdWei !== undefined
      ? toBigIntSafe(ctx.config.capitalExhaustedThresholdWei)
      : DEFAULT_CAPITAL_EXHAUSTED_THRESHOLD_WEI;

  if (paperMode) {
    // Paper "capital exhausted" is deliberately cash-only (ignores open-position mark value —
    // see buildPaperHoldings' comment on why mark values aren't fetched here) — a sell can
    // always convert position value back into tradeable cash, so this is a conservative, cheap
    // check rather than a full mark-to-market read.
    try {
      const { quaiWei } = deps.sim.derivePaperPortfolioFromLedger(ctx.ledger);
      if (quaiWei < threshold) return { stop: true, reason: 'capital-exhausted' };
    } catch (err) {
      safeConsoleError('shouldStop: paper portfolio derivation failed (treating as not-stopped)', err);
    }
  } else if (ctx.config.vaultAddress) {
    try {
      const vault = await ctx.api.getVault(ctx.config.vaultAddress);
      if (vault?.paused) return { stop: true, reason: 'vault-paused' };
      const totalWei = buildPortfolio(vault).totalValueWei;
      if (totalWei < threshold) return { stop: true, reason: 'capital-exhausted' };
    } catch (err) {
      safeConsoleError('shouldStop: vault read failed (treating as not-stopped)', err);
    }
  }

  return { stop: false };
}

/**
 * Awaits runCycle in a loop; stops on shouldStop() or maxCycles; sleeps a jittered 20-60s
 * (default; override with `intervalMs` for a fixed pause) between cycles. Also stops on a max
 * session duration or too many consecutive cycle failures (see the module-level DEFAULT_* consts
 * for the exact thresholds, all overridable via opts).
 * @param {object} ctx RunnerCtx
 * @param {{ intervalMs?: number, maxCycles?: number, minIntervalMs?: number, maxIntervalMs?: number, maxSessionMs?: number, maxConsecutiveFailures?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function runLoop(ctx, opts = {}) {
  const deps = resolveDeps(ctx);
  const {
    maxCycles = Infinity,
    intervalMs,
    minIntervalMs = DEFAULT_PAUSE_MIN_MS,
    maxIntervalMs = DEFAULT_PAUSE_MAX_MS,
    maxSessionMs = DEFAULT_MAX_SESSION_MS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  } = opts;

  const sessionStartMs = deps.now();
  let cycles = 0;
  let consecutiveFailures = 0;

  while (cycles < maxCycles) {
    const result = await runCycle(ctx);
    cycles += 1;
    consecutiveFailures = result.error ? consecutiveFailures + 1 : 0;

    if (result.stopped) return;

    if (consecutiveFailures >= maxConsecutiveFailures) {
      await safeReportBlocked(ctx.reporter, `session stopped: ${consecutiveFailures} consecutive cycle failures`);
      return;
    }
    if (deps.now() - sessionStartMs >= maxSessionMs) {
      await safeReportBlocked(ctx.reporter, 'session stopped: max session duration reached');
      return;
    }
    const stop = await shouldStop(ctx);
    if (stop.stop) {
      await safeReportBlocked(ctx.reporter, `session stopped: ${stop.reason}`);
      return;
    }
    if (cycles >= maxCycles) return;

    const pauseMs = intervalMs != null ? intervalMs : jitteredPause(minIntervalMs, maxIntervalMs, deps.randomFn);
    await deps.sleepFn(pauseMs);
  }
}

/** @returns {Promise<void>} */
export async function writeStatus(filePath, status, writeImpl) {
  const impl =
    writeImpl ||
    (async (p, content) => {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    });
  await impl(filePath, JSON.stringify(status, null, 2));
}

/** @returns {Promise<object | null>} Status */
export async function readStatus(filePath, readImpl) {
  const impl = readImpl || ((p) => readFile(p, 'utf8'));
  try {
    const raw = await impl(filePath);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // A malformed or otherwise unreadable status.json is never load-bearing state — it's a
    // best-effort convenience file — so treat it the same as "absent" rather than throwing.
    return null;
  }
}

// Exported for tests and for bin/status.mjs-style callers that want the same defaults this
// module uses internally.
export { buildMarketCandidates, buildTradeRecord, buildPortfolio, buildSnapshot, jitteredPause };
