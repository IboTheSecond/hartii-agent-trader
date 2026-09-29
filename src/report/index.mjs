// src/report — Telegram (+ optional ntfy) formatting/sending/throttling. Plain text only,
// safe for underscores in token symbols (no unescaped Markdown).
// Contract: see INTERFACES.md#src-report.
//
// Design note: sendTelegram never sets Telegram's `parse_mode`, so Telegram renders the message
// as plain text — no entity parsing means `_`, `*`, `` ` ``, `[` etc. in a token symbol or an
// address can never break formatting or get silently eaten. That's the whole "safe for
// underscores" requirement; no manual escaping is needed anywhere in this module.

const WEI_PER_QUAI = 10n ** 18n;
const QUAISCAN_TX_BASE = 'https://quaiscan.io/tx/';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

function toBig(v) {
  try {
    if (typeof v === 'bigint') return v;
    if (v === null || v === undefined || v === '') return 0n;
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** @returns {string} e.g. "1.2345", "-0.5", "0" — trimmed, up to `decimals` fractional digits */
export function formatQuai(wei, { decimals = 4 } = {}) {
  const v = toBig(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WEI_PER_QUAI;
  const frac = abs % WEI_PER_QUAI;
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg && (whole !== 0n || fracStr) ? `-${out}` : out;
}

/** @returns {string} signed formatted QUAI amount, e.g. "+1.5", "-0.2", "0" */
function signedQuai(wei) {
  const v = toBig(wei);
  const s = formatQuai(v < 0n ? -v : v);
  return v < 0n ? `-${s}` : v > 0n ? `+${s}` : s;
}

/** @returns {string} e.g. "0x0035...ffc8" — unchanged if already short */
export function shortAddress(addr) {
  const a = String(addr || '');
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/** @returns {string|null} */
export function txUrl(txHash) {
  return txHash ? `${QUAISCAN_TX_BASE}${txHash}` : null;
}

function tokenLabel(t) {
  return t?.symbol ? `$${t.symbol}` : shortAddress(t?.token);
}

function balanceLines(snapshot) {
  const lines = ['Balances:', `  vault QUAI: ${formatQuai(snapshot?.quaiWei)}`];
  const holdings = snapshot?.holdings || [];
  if (holdings.length === 0) {
    lines.push('  positions: none');
  } else {
    lines.push('  positions:');
    for (const h of holdings) {
      const mark = h?.markValueQuaiWei !== undefined ? ` (mark ${formatQuai(h.markValueQuaiWei)} QUAI)` : '';
      lines.push(`    ${h?.symbol ? `$${h.symbol}` : shortAddress(h?.token)}: ${formatQuai(h?.amountWei)}${mark}`);
    }
  }
  return lines;
}

function recentTradesLines(snapshot, n = 5) {
  const trades = (snapshot?.recentTrades || []).slice(-n);
  const lines = [trades.length ? 'Last trades:' : 'Last trades: none yet'];
  for (const t of trades) {
    const paperTag = t.paper ? ' (paper)' : '';
    lines.push(`  ${String(t.side).toUpperCase()} ${tokenLabel(t)} ${formatQuai(t.amountQuaiWei)} QUAI (${t.txHash ? shortAddress(t.txHash) : 'no tx'})${paperTag}`);
  }
  return lines;
}

function pnlLines(snapshot) {
  const lines = [
    'PnL:',
    `  realized: ${signedQuai(snapshot?.realizedPnlWei)} QUAI`,
    `  unrealized: ${signedQuai(snapshot?.unrealizedPnlWei)} QUAI`,
    `  gas spent: ${formatQuai(snapshot?.gasSpentWei)} QUAI`,
  ];
  const growth = snapshot?.growthPct;
  if (typeof growth === 'number' && Number.isFinite(growth)) {
    const sign = growth > 0 ? '+' : '';
    lines.push(`  growth vs deposits: ${sign}${growth.toFixed(2)}%`);
  } else {
    lines.push('  growth vs deposits: n/a');
  }
  return lines;
}

/**
 * side, $SYMBOL + short address, QUAI in/out, tokens, price, tx link
 * https://quaiscan.io/tx/<hash> (or "(paper trade)"), one-line reason, current balances,
 * last ~5 trades, realized/unrealized PnL, gas spent, growth % vs deposits.
 * @param {object} trade TradeRecord
 * @param {object} snapshot PortfolioSnapshot
 * @returns {string}
 */
export function formatTradeMessage(trade, snapshot) {
  if (!trade || !trade.side) throw new TypeError('formatTradeMessage: trade is required');
  const label = tokenLabel(trade);
  const lines = [];
  lines.push(`TRADE: ${String(trade.side).toUpperCase()} ${label} (${shortAddress(trade.token)})`);
  lines.push(
    trade.side === 'buy'
      ? `${formatQuai(trade.amountQuaiWei)} QUAI in -> ${formatQuai(trade.amountTokenWei)} ${trade.symbol || 'tokens'} out`
      : `${formatQuai(trade.amountTokenWei)} ${trade.symbol || 'tokens'} in -> ${formatQuai(trade.amountQuaiWei)} QUAI out`,
  );
  if (trade.priceQuaiPerTokenWei !== undefined && trade.priceQuaiPerTokenWei !== null) {
    lines.push(`price: ${formatQuai(trade.priceQuaiPerTokenWei, { decimals: 8 })} QUAI/token`);
  }
  lines.push(trade.txHash ? `tx: ${txUrl(trade.txHash)}` : '(paper trade)');
  lines.push(`why: ${trade.reason || '(no reason given)'}`);
  lines.push('');
  lines.push(...balanceLines(snapshot));
  lines.push('');
  lines.push(...recentTradesLines(snapshot));
  lines.push('');
  lines.push(...pnlLines(snapshot));
  return lines.join('\n');
}

/** @returns {string} */
export function formatHourlySummary(snapshot) {
  const lines = ['HOURLY SUMMARY', ''];
  lines.push(...balanceLines(snapshot));
  lines.push('');
  lines.push(...recentTradesLines(snapshot));
  lines.push('');
  lines.push(...pnlLines(snapshot));
  return lines.join('\n');
}

/** @returns {string} */
export function formatBlockedMessage(reason) {
  return `BLOCKED / STOPPED: ${reason || '(no reason given)'}`;
}

/** @returns {Promise<void>} */
export async function sendTelegram({ botToken, chatId }, text, fetchImpl = fetch) {
  if (!botToken || !chatId) throw new Error('sendTelegram: botToken and chatId are required');
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* best-effort error body for the thrown message only */
    }
    throw new Error(`sendTelegram: Telegram API returned ${res.status}${body ? ` — ${body}` : ''}`);
  }
}

/** @returns {Promise<void>} */
export async function sendNtfy(url, text, fetchImpl = fetch) {
  if (!url) throw new Error('sendNtfy: url is required');
  const res = await fetchImpl(url, { method: 'POST', body: text });
  if (!res.ok) {
    throw new Error(`sendNtfy: ntfy returned ${res.status}`);
  }
}

/** Serializes async sends through this queue at >= minIntervalMs apart. */
function createThrottle({ minIntervalMs = 1100, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  let chain = Promise.resolve();
  let lastSentAt = null;
  return function enqueue(fn) {
    chain = chain.then(async () => {
      if (lastSentAt !== null) {
        const wait = minIntervalMs - (now() - lastSentAt);
        if (wait > 0) await sleepFn(wait);
      }
      lastSentAt = now();
      return fn();
    });
    return chain;
  };
}

/**
 * @param {object} config Config (reads config.telegram / config.ntfyUrl)
 * @param {{ sendImpl?: Function, minIntervalMs?: number, sleepFn?: Function, now?: () => number, onError?: (err: Error, context: string) => void, writeImpl?: (text: string) => void }} [opts]
 */
export function createReporter(config, opts = {}) {
  const {
    sendImpl = fetch,
    minIntervalMs = 1100,
    sleepFn,
    now,
    onError = (err, ctx) => console.error(`[report] ${ctx}: ${err?.message || err}`),
    // No Telegram/ntfy configured at all — print the report to stdout instead of silently
    // discarding it, so a paper rehearsal (or any run with TELEGRAM_*/NTFY_URL unset) still
    // surfaces every trade/hourly/blocked report somewhere a human can see it.
    writeImpl = (text) => console.log(text),
  } = opts;
  const throttle = createThrottle({ minIntervalMs, ...(sleepFn ? { sleepFn } : {}), ...(now ? { now } : {}) });

  async function deliver(text, { ntfyText = null, context } = {}) {
    const jobs = [];
    if (config?.telegram?.botToken && config?.telegram?.chatId) {
      jobs.push(
        throttle(() => sendTelegram(config.telegram, text, sendImpl)).catch((err) => onError(err, `${context}/telegram`)),
      );
    }
    if (config?.ntfyUrl) {
      jobs.push(sendNtfy(config.ntfyUrl, ntfyText ?? text, sendImpl).catch((err) => onError(err, `${context}/ntfy`)));
    }
    if (jobs.length === 0) {
      try {
        writeImpl(text);
      } catch (err) {
        onError(err, `${context}/stdout`);
      }
      return;
    }
    await Promise.all(jobs);
  }

  return {
    /** @returns {Promise<void>} */
    async reportTrade(trade, snapshot) {
      const text = formatTradeMessage(trade, snapshot);
      const ntfyText = `${String(trade?.side || '').toUpperCase()} ${tokenLabel(trade)}: ${formatQuai(trade?.amountQuaiWei)} QUAI`;
      await deliver(text, { ntfyText, context: 'reportTrade' });
    },
    /** @returns {Promise<void>} */
    async reportHourly(snapshot) {
      const text = formatHourlySummary(snapshot);
      const ntfyText = `hourly: realized ${signedQuai(snapshot?.realizedPnlWei)} QUAI, unrealized ${signedQuai(snapshot?.unrealizedPnlWei)} QUAI`;
      await deliver(text, { ntfyText, context: 'reportHourly' });
    },
    /** kill switch / paused / gas-low. @returns {Promise<void>} */
    async reportBlocked(reason) {
      const text = formatBlockedMessage(reason);
      await deliver(text, { context: 'reportBlocked' });
    },
  };
}
