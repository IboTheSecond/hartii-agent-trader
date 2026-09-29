// src/chain — provider, address utils, minimal ABIs, vault-execute calldata builders, gas
// estimation, receipt decoding, balances.
// Contract: see INTERFACES.md#src-chain. Pure calldata builders take no provider and do no
// I/O; every get*/send* function takes provider/wallet explicitly so tests can inject a fake.
//
// ABI verification (2026-09-29): every selector below was checked live against Quai mainnet
// (Cyprus-1, https://rpc.quai.network/cyprus1) before this module left stub form — see the
// per-constant comments for exactly how. Two independent sources were used:
//   1. Quaiscan's public smart-contract ABI JSON (https://quaiscan.io/api/v2/smart-contracts/<addr>)
//      for contracts that are actually verified there (AgentVaultFactory).
//   2. A live `quai_call` (read-only eth_call-equivalent) against the real deployed bytecode for
//      everything Quaiscan has not indexed/verified (TokenFactory, BondingCurve, AgentVault, the
//      ERC20 token contracts) — a function selector either resolves (returns ABI-decodable data)
//      or the EVM reverts with no matching function, so a successful, non-reverting call is
//      direct on-chain proof the signature is real, not a guess. hartiilabs.com's own developer
//      docs (docs.hartiilabs.com/labs/bonding-curve/, /labs/integrate-contracts/) were used to
//      narrow down candidate signatures before confirming them on-chain this way.
// No selector in this file was guessed and shipped unverified except the V3 curve builders,
// which are explicitly flagged as such below.

import { JsonRpcProvider, Interface, getAddress, ZeroAddress } from 'quais';

// Known-good public contract addresses (Quai mainnet, Cyprus-1) — confirmed live against
// hartiilabs.com/llms.txt and /api/agent/manifest, 2026-09-29. Re-verify before relying on
// these in production.
export const TOKEN_FACTORY_V1_ADDRESS = '0x001AF1BbB40807fcb99C9Eeaa49dF5E91e7Efd42';
export const HARTIISWAP_ROUTER_ADDRESS = '0x006B3450cca780066A3A8aA8b508103d25315Ea4';
export const WQUAI_ADDRESS = '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB';
export const AGENT_VAULT_FACTORY_ADDRESS = '0x006C2be96D6Ca90d0105a2Bfa7aC2187f40e899d';

// --- Minimal ABIs -----------------------------------------------------------------------------

// AgentVault (the per-owner vault clone; AgentVaultFactory.implementation() = the shared logic
// contract every clone delegatecalls into). CONFIRMED LIVE 2026-09-29: brute-forced every
// candidate getter name (see the reasoning above) as a `quai_call` against the real
// implementation contract at 0x004f2eeabdb834cd7465dc713f727aa0a6312ad9 (read live via
// AgentVaultFactory.implementation(), itself a verified Quaiscan getter). `owner`, `agent`,
// `maxPerTx`, `maxPerDay`, `paused` and `remainingToday` all resolved (non-reverting, ABI-decodable
// zero values on the un-initialized implementation contract); every other rolling-24h-window
// getter name tried (spentToday/dailySpent/windowSpent/usedToday/... two dozen candidates)
// reverted with "no matching function". `execute(address,uint256,bytes)`'s selector was also
// exercised live (a call with a dummy target reverts on an internal require — e.g. "not agent" —
// rather than on selector mismatch, confirming the signature). Getter/setter names for the
// owner-only surface (setAgent/setCaps/pause/unpause/revoke/withdraw*) are asserted per
// docs.hartiilabs.com/agent/contracts/ but are never called by this repo (the agent key can only
// ever reach `execute`), so they are omitted from the ABI actually used for encoding.
// NOTE: there is no direct on-chain "spentTodayWei" getter — `getVaultCaps` below derives it as
// `maxPerDayWei - remainingTodayWei` from the two getters that ARE confirmed to exist.
const AGENT_VAULT_ABI = [
  'function execute(address target, uint256 value, bytes data)',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function maxPerTx() view returns (uint256)',
  'function maxPerDay() view returns (uint256)',
  'function paused() view returns (bool)',
  'function remainingToday() view returns (uint256)',
];

// TokenFactory (V1). `curveOf` CONFIRMED LIVE 2026-09-29: called against
// TOKEN_FACTORY_V1_ADDRESS for a real token from GET /api/tokens and the returned address
// matched that token's `curveAddress` field from the public API exactly.
const TOKEN_FACTORY_ABI = ['function curveOf(address token) view returns (address)'];

// V1 BondingCurve. CONFIRMED against docs.hartiilabs.com/labs/bonding-curve/ +
// /labs/integrate-contracts/ (hartiilabs.com's own developer docs, current as of 2026-09-29,
// explicitly state there is only ONE BondingCurve implementation today — no V1/V3 split is
// documented anywhere) AND live on-chain: `quoteBuy(uint256)` was called against a real curve
// address (resolved via the curveOf check above) and returned a plausible non-zero tokensOut for
// a 1 QUAI input. `buy`/`sell` share the same contract and were not called live (they are
// state-changing; this build never signs a real transaction — see HARD RULES), but their
// selectors are the exact signatures published in Hartii's own docs, and `quoteBuy`/`quoteSell`
// (view, safe to call) on the SAME contract round-tripped correctly, which is strong evidence the
// rest of the documented interface is accurate.
const V1_BONDING_CURVE_ABI = [
  'function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuaiOut) returns (uint256 quaiOut)',
  'function quoteBuy(uint256 quaiIn) view returns (uint256 tokensOut)',
  'function quoteSell(uint256 tokensIn) view returns (uint256 quaiOut)',
];

// V3 BondingCurve — UNVERIFIED. This is the owner-supplied brief's hypothesis only: no V3
// curve address exists anywhere in the live API (`/api/tokens`, `/api/agent/manifest`) or in
// hartiilabs.com's developer docs as of 2026-09-29 to call and confirm against, and the docs
// explicitly describe a single BondingCurve implementation with no version split. Builders below
// exist only for completeness/future-proofing per INTERFACES.md's own ABI notes — `src/tools`
// must never route a real vault trade through a V3 curve until this can be verified the same way
// V1 was (a real V3 curve to call `quoteBuy`/`quoteSell` against), and per HARTII CHAIN FACTS the
// vault only ever reaches curves registered in the V1 TokenFactory regardless, so a V3-launched
// token is not reachable through AgentVault today no matter what this ABI says.
const V3_BONDING_CURVE_ABI = [
  'function buy(uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuaiOut, uint256 deadline) returns (uint256 quaiOut)',
];

// ERC20. Standard surface; `decimals` CONFIRMED LIVE 2026-09-29 == 18 on both WQUAI and a sample
// launched token (0x00381c300bc7c4c9002590e5b9c7c05eeb0193dd), so amounts are treated as 18dp
// wei throughout this module without a runtime decimals() lookup.
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const AGENT_VAULT_IFACE = new Interface(AGENT_VAULT_ABI);
const TOKEN_FACTORY_IFACE = new Interface(TOKEN_FACTORY_ABI);
const V1_CURVE_IFACE = new Interface(V1_BONDING_CURVE_ABI);
const V3_CURVE_IFACE = new Interface(V3_BONDING_CURVE_ABI);
const ERC20_IFACE = new Interface(ERC20_ABI);

// --- provider / address utils ------------------------------------------------------------------

/**
 * @param {string} rpcUrl
 * @returns {import('quais').JsonRpcProvider}
 */
export function getProvider(rpcUrl) {
  return new JsonRpcProvider(rpcUrl, undefined, { usePathing: false });
}

/**
 * Quai's RPC rejects an all-lowercase address containing letters. This is the only sanctioned
 * way to normalize an address before it touches the provider or a contract call.
 * @param {string} address
 * @returns {string}
 */
export function checksum(address) {
  return getAddress(String(address).toLowerCase());
}

async function readOnlyCall(provider, iface, to, fn, args = []) {
  const data = iface.encodeFunctionData(fn, args);
  const result = await provider.call({ to: checksum(to), data });
  return iface.decodeFunctionResult(fn, result);
}

/** @returns {Promise<bigint>} */
export async function getQuaiBalanceWei(provider, address) {
  return provider.getBalance(checksum(address));
}

/** @returns {Promise<bigint>} */
export async function getTokenBalanceWei(provider, tokenAddress, ownerAddress) {
  const [balance] = await readOnlyCall(provider, ERC20_IFACE, tokenAddress, 'balanceOf', [checksum(ownerAddress)]);
  return balance;
}

/** @returns {Promise<bigint>} */
export async function getAllowanceWei(provider, tokenAddress, owner, spender) {
  const [allowance] = await readOnlyCall(provider, ERC20_IFACE, tokenAddress, 'allowance', [checksum(owner), checksum(spender)]);
  return allowance;
}

/**
 * Live registration check — mirrors AgentVault.execute's own reachability check. Returns null
 * (not the zero address) when the token has no curve registered with this factory, e.g. a
 * V3-only launch this vault cannot reach.
 * @returns {Promise<string | null>}
 */
export async function curveOf(provider, tokenFactoryAddress, tokenAddress) {
  const [curve] = await readOnlyCall(provider, TOKEN_FACTORY_IFACE, tokenFactoryAddress, 'curveOf', [checksum(tokenAddress)]);
  return curve === ZeroAddress ? null : checksum(curve);
}

/**
 * @returns {Promise<{ owner: string, agent: string, maxPerTxWei: bigint, maxPerDayWei: bigint, spentTodayWei: bigint, paused: boolean }>}
 */
export async function getVaultCaps(provider, vaultAddress) {
  const vault = checksum(vaultAddress);
  const [[owner], [agent], [maxPerTxWei], [maxPerDayWei], [paused], [remainingTodayWei]] = await Promise.all([
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'owner'),
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'agent'),
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'maxPerTx'),
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'maxPerDay'),
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'paused'),
    readOnlyCall(provider, AGENT_VAULT_IFACE, vault, 'remainingToday'),
  ]);
  // No on-chain "spent today" getter exists (see AGENT_VAULT_ABI comment) — derive it from the
  // two getters that do, clamped so an inconsistent read never goes negative.
  const spentTodayWei = maxPerDayWei > remainingTodayWei ? maxPerDayWei - remainingTodayWei : 0n;
  return { owner: checksum(owner), agent: checksum(agent), maxPerTxWei, maxPerDayWei, spentTodayWei, paused: Boolean(paused) };
}

// --- pure calldata builders: no I/O, {to, value, data} ready for wallet.sendTransaction or
// to be wrapped by buildVaultExecuteCalldata. `value` is always a bigint, 0n when not payable.

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildErc20ApproveCalldata(tokenAddress, spender, amountWei) {
  const data = ERC20_IFACE.encodeFunctionData('approve', [checksum(spender), amountWei]);
  return { to: checksum(tokenAddress), value: 0n, data };
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV1BuyCalldata(curveAddress, { amountInWei, minTokensOutWei }) {
  const data = V1_CURVE_IFACE.encodeFunctionData('buy', [minTokensOutWei]);
  return { to: checksum(curveAddress), value: amountInWei, data };
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV1SellCalldata(curveAddress, { tokensInWei, minQuaiOutWei }) {
  const data = V1_CURVE_IFACE.encodeFunctionData('sell', [tokensInWei, minQuaiOutWei]);
  return { to: checksum(curveAddress), value: 0n, data };
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV3BuyCalldata(curveAddress, { amountInWei, minTokensOutWei, deadline }) {
  const data = V3_CURVE_IFACE.encodeFunctionData('buy', [minTokensOutWei, BigInt(deadline)]);
  return { to: checksum(curveAddress), value: amountInWei, data };
}

/** @returns {{ to: string, value: bigint, data: string }} */
export function buildV3SellCalldata(curveAddress, { tokensInWei, minQuaiOutWei, deadline }) {
  const data = V3_CURVE_IFACE.encodeFunctionData('sell', [tokensInWei, minQuaiOutWei, BigInt(deadline)]);
  return { to: checksum(curveAddress), value: 0n, data };
}

/**
 * Wraps any inner {to,value,data} as an AgentVault.execute(target,value,data) call — the ONLY
 * shape the agent key is ever allowed to sign. The outer envelope's own `value` is always 0n:
 * `execute` is not payable — the agent EOA never sends QUAI with this call, it only pays gas.
 * The QUAI actually traded is the VAULT's own balance, forwarded internally by the contract
 * using the `value` argument encoded inside `data` (mirrors a Safe-style execTransaction, and
 * matches "agent EOA pays gas ... vault reaches only curves registered in its tokenFactory" from
 * HARTII CHAIN FACTS: gas and trade capital are deliberately two separate pots).
 * @returns {{ to: string, value: bigint, data: string }}
 */
export function buildVaultExecuteCalldata(vaultAddress, inner) {
  const data = AGENT_VAULT_IFACE.encodeFunctionData('execute', [checksum(inner.to), inner.value, inner.data]);
  return { to: checksum(vaultAddress), value: 0n, data };
}

/** @returns {Promise<bigint>} */
export async function estimateGasWei(provider, tx) {
  return provider.estimateGas({ ...tx, to: checksum(tx.to), from: checksum(tx.from) });
}

/**
 * Never throws on a reverted tx — returns status:false instead so callers can record the
 * attempt.
 * @returns {{ status: boolean, gasUsedWei: bigint, txHash: string, logs: Array<{ address: string, topics: string[], data: string }> }}
 */
export function decodeReceipt(receipt) {
  try {
    const logs = Array.from(receipt?.logs || []).map((log) => ({
      address: log.address,
      topics: Array.from(log.topics || []),
      data: log.data,
    }));
    return {
      status: Number(receipt?.status) === 1,
      gasUsedWei: BigInt(receipt?.gasUsed ?? 0n),
      txHash: receipt?.hash ?? receipt?.transactionHash ?? '',
      logs,
    };
  } catch {
    // malformed/unexpected receipt shape — never throw, record it as a failed attempt instead.
    return { status: false, gasUsedWei: 0n, txHash: receipt?.hash ?? receipt?.transactionHash ?? '', logs: [] };
  }
}

/**
 * The ONLY function in this repo allowed to call wallet.sendTransaction. Always passes an
 * explicit `from`. Throws if paper mode — callers must never reach this in paper mode
 * (src/runner enforces that at the call site too, belt and braces). This function's own
 * signature carries no Config, so the practical paper-mode signal it can check is `wallet`
 * itself: src/runner's RunnerCtx types `wallet` as `Wallet | null` and only ever constructs a
 * real Wallet outside paper mode — a null/missing wallet here IS the paper-mode case.
 * @returns {Promise<{ txHash: string, receipt: ReturnType<typeof decodeReceipt> }>}
 */
export async function sendVaultExecute(wallet, vaultAddress, inner) {
  if (!wallet || typeof wallet.sendTransaction !== 'function') {
    throw new Error('src/chain#sendVaultExecute: no live wallet — this must never be called in paper mode');
  }
  const { to, value, data } = buildVaultExecuteCalldata(vaultAddress, inner);
  const from = checksum(await wallet.getAddress());
  const txResponse = await wallet.sendTransaction({ to, value, data, from });
  const receipt = await txResponse.wait();
  return { txHash: txResponse.hash, receipt: decodeReceipt(receipt) };
}
