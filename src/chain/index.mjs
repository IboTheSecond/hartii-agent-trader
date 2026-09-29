// src/chain — provider, address utils, minimal ABIs, vault-execute calldata builders, gas
// estimation, receipt decoding, balances.
// Contract: see INTERFACES.md#src-chain. Pure calldata builders take no provider and do no
// I/O; every get*/send* function takes provider/wallet explicitly so tests can inject a fake.
//
// ABI note: signatures used here MUST be verified against the public ABI JSON at
// https://quaiscan.io/api/v2/smart-contracts/<address> before this module leaves stub form —
// see INTERFACES.md's "ABI notes" section. Never guess a selector.

function notImplemented(fn) {
  throw new Error(`src/chain: ${fn} not implemented — see INTERFACES.md`);
}

// Known-good public contract addresses (Quai mainnet, Cyprus-1) — confirmed live against
// hartiilabs.com/llms.txt and /api/agent/manifest, 2026-09-29. Re-verify before relying on
// these in production.
export const TOKEN_FACTORY_V1_ADDRESS = '0x001AF1BbB40807fcb99C9Eeaa49dF5E91e7Efd42';
export const HARTIISWAP_ROUTER_ADDRESS = '0x006B3450cca780066A3A8aA8b508103d25315Ea4';
export const WQUAI_ADDRESS = '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB';
export const AGENT_VAULT_FACTORY_ADDRESS = '0x006C2be96D6Ca90d0105a2Bfa7aC2187f40e899d';

/**
 * @param {string} rpcUrl
 * @returns {import('quais').JsonRpcProvider}
 */
export function getProvider(rpcUrl) {
  return notImplemented('getProvider');
}

/**
 * Quai's RPC rejects an all-lowercase address containing letters. This is the only sanctioned
 * way to normalize an address before it touches the provider or a contract call.
 * @param {string} address
 * @returns {string}
 */
export function checksum(address) {
  return notImplemented('checksum');
}

/** @returns {Promise<bigint>} */
export async function getQuaiBalanceWei(provider, address) {
  return notImplemented('getQuaiBalanceWei');
}

/** @returns {Promise<bigint>} */
export async function getTokenBalanceWei(provider, tokenAddress, ownerAddress) {
  return notImplemented('getTokenBalanceWei');
}

/** @returns {Promise<bigint>} */
export async function getAllowanceWei(provider, tokenAddress, owner, spender) {
  return notImplemented('getAllowanceWei');
}

/**
 * Live registration check — mirrors AgentVault.execute's own reachability check. Returns null
 * (not the zero address) when the token has no curve registered with this factory (e.g. a
 * V3-only launch this vault cannot reach).
 * @returns {Promise<string | null>}
 */
export async function curveOf(provider, tokenFactoryAddress, tokenAddress) {
  return notImplemented('curveOf');
}

/**
 * @returns {Promise<{ owner: string, agent: string, maxPerTxWei: bigint, maxPerDayWei: bigint, spentTodayWei: bigint, paused: boolean }>}
 */
export async function getVaultCaps(provider, vaultAddress) {
  return notImplemented('getVaultCaps');
}

// --- pure calldata builders: no I/O, {to, value, data} ready for wallet.sendTransaction or
// to be wrapped by buildVaultExecuteCalldata. `value` is always a bigint, 0n when not payable.

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildErc20ApproveCalldata(tokenAddress, spender, amountWei) {
  return notImplemented('buildErc20ApproveCalldata');
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV1BuyCalldata(curveAddress, { amountInWei, minTokensOutWei }) {
  return notImplemented('buildV1BuyCalldata');
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV1SellCalldata(curveAddress, { tokensInWei, minQuaiOutWei }) {
  return notImplemented('buildV1SellCalldata');
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV3BuyCalldata(curveAddress, { amountInWei, minTokensOutWei, deadline }) {
  return notImplemented('buildV3BuyCalldata');
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV3SellCalldata(curveAddress, { tokensInWei, minQuaiOutWei, deadline }) {
  return notImplemented('buildV3SellCalldata');
}

/**
 * Wraps any inner {to,value,data} as an AgentVault.execute(target,value,data) call — the ONLY
 * shape the agent key is ever allowed to sign.
 * @returns {{ to: string, value: bigint, data: string }}
 */
export function buildVaultExecuteCalldata(vaultAddress, inner) {
  return notImplemented('buildVaultExecuteCalldata');
}

/** @returns {Promise<bigint>} */
export async function estimateGasWei(provider, tx) {
  return notImplemented('estimateGasWei');
}

/**
 * Never throws on a reverted tx — returns status:false instead so callers can record the
 * attempt.
 * @returns {{ status: boolean, gasUsedWei: bigint, txHash: string, logs: Array<{ address: string, topics: string[], data: string }> }}
 */
export function decodeReceipt(receipt) {
  return notImplemented('decodeReceipt');
}

/**
 * The ONLY function in this repo allowed to call wallet.sendTransaction. Always passes an
 * explicit `from`. Throws if paper mode — callers must never reach this in paper mode
 * (src/runner enforces that at the call site too, belt and braces).
 * @returns {Promise<{ txHash: string, receipt: ReturnType<typeof decodeReceipt> }>}
 */
export async function sendVaultExecute(wallet, vaultAddress, inner) {
  return notImplemented('sendVaultExecute');
}
