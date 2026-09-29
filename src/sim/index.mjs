// src/sim — paper-trading engine (same tool surface as live, fills simulated from live
// quotes) and replay/eval over public trade history.
// Contract: see INTERFACES.md#src-sim.

function notImplemented(fn) {
  throw new Error(`src/sim: ${fn} not implemented — see INTERFACES.md`);
}

/**
 * @param {{ initialQuaiWei: bigint, api: object }} opts
 */
export function createPaperEngine(opts) {
  return {
    /** @returns {Promise<{ ok: boolean, filledTokensWei?: bigint, error?: string }>} */
    async buy(token, amountInWei, minTokensOutWei) {
      return notImplemented('PaperEngine#buy');
    },
    /** @returns {Promise<{ ok: boolean, filledQuaiWei?: bigint, error?: string }>} */
    async sell(token, tokensInWei, minQuaiOutWei) {
      return notImplemented('PaperEngine#sell');
    },
    /** @returns {{ quaiWei: bigint, positions: Record<string, bigint> }} */
    getState() {
      return notImplemented('PaperEngine#getState');
    },
  };
}

/**
 * @param {{ api: object, tokenAddress: string, fromMs: number, toMs: number, strategyFn: Function }} opts
 * @returns {Promise<object>} ReplayResult
 */
export async function replayHistory(opts) {
  return notImplemented('replayHistory');
}

/** @returns {{ realizedPnlWei: bigint, winRate: number, trades: number }} */
export function evalStrategy(trades) {
  return notImplemented('evalStrategy');
}
