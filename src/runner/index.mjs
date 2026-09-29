// src/runner — cycle orchestration, loop, stop conditions, status.json, the paper/live
// switch. The only module allowed to decide whether src/chain's sending functions ever run.
// Contract: see INTERFACES.md#src-runner.

function notImplemented(fn) {
  throw new Error(`src/runner: ${fn} not implemented — see INTERFACES.md`);
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
  return notImplemented('runCycle');
}

/**
 * Awaits runCycle in a loop; stops on shouldStop() or maxCycles; sleeps intervalMs between.
 * @param {object} ctx RunnerCtx
 * @param {{ intervalMs?: number, maxCycles?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function runLoop(ctx, opts = {}) {
  return notImplemented('runLoop');
}

/**
 * Kill-switch file present, OR vault gas below configured threshold, OR vault paused=true.
 * @returns {Promise<{ stop: boolean, reason?: string }>}
 */
export async function shouldStop(ctx) {
  return notImplemented('shouldStop');
}

/** @returns {Promise<void>} */
export async function writeStatus(filePath, status, writeImpl) {
  return notImplemented('writeStatus');
}

/** @returns {Promise<object | null>} Status */
export async function readStatus(filePath, readImpl) {
  return notImplemented('readStatus');
}
