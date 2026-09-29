import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, ZeroAddress } from 'quais';
import * as chain from '../src/chain/index.mjs';

// No network: every get*/send* export takes provider/wallet explicitly and every test below
// injects a fake. Expected encoded call data / return data is built with the same `quais`
// Interface class the module itself uses, so these tests independently re-derive the expected
// bytes rather than hardcoding magic hex strings copied from the implementation.

const AGENT_VAULT_IFACE = new Interface([
  'function execute(address target, uint256 value, bytes data)',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function maxPerTx() view returns (uint256)',
  'function maxPerDay() view returns (uint256)',
  'function paused() view returns (bool)',
  'function remainingToday() view returns (uint256)',
]);
const TOKEN_FACTORY_IFACE = new Interface(['function curveOf(address token) view returns (address)']);
const V1_CURVE_IFACE = new Interface([
  'function buy(uint256 minTokensOut) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuaiOut) returns (uint256 quaiOut)',
]);
const V3_CURVE_IFACE = new Interface([
  'function buy(uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuaiOut, uint256 deadline) returns (uint256 quaiOut)',
]);
const ERC20_IFACE = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const VAULT = getAddress('0x006c2be96d6ca90d0105a2bfa7ac2187f40e899d');
const TOKEN_FACTORY = getAddress(chain.TOKEN_FACTORY_V1_ADDRESS.toLowerCase());
const CURVE = getAddress('0x0040de25f71855d74bd22099e18d85dbc842ae97');
const TOKEN = getAddress('0x00381c300bc7c4c9002590e5b9c7c05eeb0193dd');
const OWNER = getAddress('0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const AGENT = getAddress('0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

function selectorOf(data) {
  return data.slice(0, 10);
}

test('chain: known public contract addresses are exported', () => {
  assert.equal(chain.TOKEN_FACTORY_V1_ADDRESS, '0x001AF1BbB40807fcb99C9Eeaa49dF5E91e7Efd42');
  assert.match(chain.WQUAI_ADDRESS, /^0x00/);
  assert.match(chain.HARTIISWAP_ROUTER_ADDRESS, /^0x00/);
  assert.match(chain.AGENT_VAULT_FACTORY_ADDRESS, /^0x00/);
});

test('chain: getProvider builds a JsonRpcProvider with usePathing:false (no network call made)', () => {
  const provider = chain.getProvider('https://rpc.quai.network/cyprus1');
  assert.equal(provider.constructor.name, 'JsonRpcProvider');
});

test('chain: checksum normalizes a lowercase address', () => {
  assert.equal(chain.checksum('0x001af1bbb40807fcb99c9eeaa49df5e91e7efd42'), chain.TOKEN_FACTORY_V1_ADDRESS);
});

test('chain: checksum throws on a malformed address', () => {
  assert.throws(() => chain.checksum('0xnotanaddress'));
});

test('chain: getQuaiBalanceWei delegates to provider.getBalance with a checksummed address', async () => {
  let seen;
  const provider = { getBalance: async (addr) => { seen = addr; return 123n; } };
  const result = await chain.getQuaiBalanceWei(provider, OWNER.toLowerCase());
  assert.equal(result, 123n);
  assert.equal(seen, OWNER);
});

test('chain: getTokenBalanceWei encodes balanceOf and decodes the result', async () => {
  let seenTx;
  const provider = {
    call: async (tx) => {
      seenTx = tx;
      return ERC20_IFACE.encodeFunctionResult('balanceOf', [777n]);
    },
  };
  const result = await chain.getTokenBalanceWei(provider, TOKEN, OWNER);
  assert.equal(result, 777n);
  assert.equal(seenTx.to, TOKEN);
  assert.equal(selectorOf(seenTx.data), selectorOf(ERC20_IFACE.encodeFunctionData('balanceOf', [OWNER])));
});

test('chain: getAllowanceWei encodes allowance(owner,spender) and decodes the result', async () => {
  const provider = {
    call: async () => ERC20_IFACE.encodeFunctionResult('allowance', [42n]),
  };
  const result = await chain.getAllowanceWei(provider, TOKEN, OWNER, AGENT);
  assert.equal(result, 42n);
});

test('chain: curveOf returns null (not the zero address) when unregistered', async () => {
  const provider = { call: async () => TOKEN_FACTORY_IFACE.encodeFunctionResult('curveOf', [ZeroAddress]) };
  const result = await chain.curveOf(provider, TOKEN_FACTORY, TOKEN);
  assert.equal(result, null);
});

test('chain: curveOf returns the checksummed curve address when registered', async () => {
  let seenTx;
  const provider = {
    call: async (tx) => {
      seenTx = tx;
      return TOKEN_FACTORY_IFACE.encodeFunctionResult('curveOf', [CURVE]);
    },
  };
  const result = await chain.curveOf(provider, TOKEN_FACTORY, TOKEN.toLowerCase());
  assert.equal(result, CURVE);
  assert.equal(seenTx.to, TOKEN_FACTORY);
});

test('chain: getVaultCaps reads every getter and derives spentTodayWei from maxPerDay - remainingToday', async () => {
  const responses = {
    owner: AGENT_VAULT_IFACE.encodeFunctionResult('owner', [OWNER]),
    agent: AGENT_VAULT_IFACE.encodeFunctionResult('agent', [AGENT]),
    maxPerTx: AGENT_VAULT_IFACE.encodeFunctionResult('maxPerTx', [5000000000000000000n]),
    maxPerDay: AGENT_VAULT_IFACE.encodeFunctionResult('maxPerDay', [50000000000000000000n]),
    paused: AGENT_VAULT_IFACE.encodeFunctionResult('paused', [false]),
    remainingToday: AGENT_VAULT_IFACE.encodeFunctionResult('remainingToday', [30000000000000000000n]),
  };
  const selectorMap = new Map();
  for (const fn of ['owner', 'agent', 'maxPerTx', 'maxPerDay', 'paused', 'remainingToday']) {
    selectorMap.set(selectorOf(AGENT_VAULT_IFACE.encodeFunctionData(fn, [])), responses[fn]);
  }
  const provider = {
    call: async (tx) => {
      const enc = selectorMap.get(selectorOf(tx.data));
      if (!enc) throw new Error(`unexpected selector ${selectorOf(tx.data)}`);
      return enc;
    },
  };
  const caps = await chain.getVaultCaps(provider, VAULT);
  assert.equal(caps.owner, OWNER);
  assert.equal(caps.agent, AGENT);
  assert.equal(caps.maxPerTxWei, 5000000000000000000n);
  assert.equal(caps.maxPerDayWei, 50000000000000000000n);
  assert.equal(caps.paused, false);
  assert.equal(caps.spentTodayWei, 20000000000000000000n);
});

test('chain: buildErc20ApproveCalldata is pure and encodes approve(spender, amount)', () => {
  const result = chain.buildErc20ApproveCalldata(TOKEN.toLowerCase(), AGENT.toLowerCase(), 1000n);
  assert.equal(result.to, TOKEN);
  assert.equal(result.value, 0n);
  assert.equal(result.data, ERC20_IFACE.encodeFunctionData('approve', [AGENT, 1000n]));
});

test('chain: buildV1BuyCalldata sends amountInWei as msg.value and encodes buy(minTokensOut)', () => {
  const result = chain.buildV1BuyCalldata(CURVE.toLowerCase(), { amountInWei: 1000000000000000000n, minTokensOutWei: 5n });
  assert.equal(result.to, CURVE);
  assert.equal(result.value, 1000000000000000000n);
  assert.equal(result.data, V1_CURVE_IFACE.encodeFunctionData('buy', [5n]));
});

test('chain: buildV1SellCalldata has zero value and encodes sell(tokensIn, minQuaiOut)', () => {
  const result = chain.buildV1SellCalldata(CURVE.toLowerCase(), { tokensInWei: 10n, minQuaiOutWei: 1n });
  assert.equal(result.to, CURVE);
  assert.equal(result.value, 0n);
  assert.equal(result.data, V1_CURVE_IFACE.encodeFunctionData('sell', [10n, 1n]));
});

test('chain: buildV3BuyCalldata encodes buy(minTokensOut, deadline) and forwards amountInWei as value', () => {
  const result = chain.buildV3BuyCalldata(CURVE.toLowerCase(), { amountInWei: 2n, minTokensOutWei: 3n, deadline: 999 });
  assert.equal(result.value, 2n);
  assert.equal(result.data, V3_CURVE_IFACE.encodeFunctionData('buy', [3n, 999n]));
});

test('chain: buildV3SellCalldata encodes sell(tokensIn, minQuaiOut, deadline) with zero value', () => {
  const result = chain.buildV3SellCalldata(CURVE.toLowerCase(), { tokensInWei: 3n, minQuaiOutWei: 4n, deadline: 111 });
  assert.equal(result.value, 0n);
  assert.equal(result.data, V3_CURVE_IFACE.encodeFunctionData('sell', [3n, 4n, 111n]));
});

test('chain: buildVaultExecuteCalldata wraps the inner call, outer value is always 0n', () => {
  const inner = { to: CURVE.toLowerCase(), value: 777n, data: '0xabcd' };
  const result = chain.buildVaultExecuteCalldata(VAULT.toLowerCase(), inner);
  assert.equal(result.to, VAULT);
  assert.equal(result.value, 0n);
  assert.equal(result.data, AGENT_VAULT_IFACE.encodeFunctionData('execute', [CURVE, 777n, '0xabcd']));
});

test('chain: estimateGasWei checksums to/from and returns the provider result', async () => {
  let seenTx;
  const provider = { estimateGas: async (tx) => { seenTx = tx; return 123456n; } };
  const result = await chain.estimateGasWei(provider, { to: CURVE.toLowerCase(), from: OWNER.toLowerCase(), value: 0n, data: '0x' });
  assert.equal(result, 123456n);
  assert.equal(seenTx.to, CURVE);
  assert.equal(seenTx.from, OWNER);
});

test('chain: decodeReceipt normalizes a successful receipt', () => {
  const decoded = chain.decodeReceipt({
    status: 1,
    gasUsed: 21000n,
    hash: '0xdeadbeef',
    logs: [{ address: TOKEN, topics: ['0x01'], data: '0x02' }],
  });
  assert.equal(decoded.status, true);
  assert.equal(decoded.gasUsedWei, 21000n);
  assert.equal(decoded.txHash, '0xdeadbeef');
  assert.deepEqual(decoded.logs, [{ address: TOKEN, topics: ['0x01'], data: '0x02' }]);
});

test('chain: decodeReceipt reports status:false for a reverted tx instead of throwing', () => {
  const decoded = chain.decodeReceipt({ status: 0, gasUsed: 21000n, hash: '0xdead', logs: [] });
  assert.equal(decoded.status, false);
});

test('chain: decodeReceipt never throws on a malformed/missing receipt', () => {
  assert.doesNotThrow(() => chain.decodeReceipt(null));
  assert.doesNotThrow(() => chain.decodeReceipt(undefined));
  assert.doesNotThrow(() => chain.decodeReceipt({}));
  const decoded = chain.decodeReceipt(undefined);
  assert.equal(decoded.status, false);
});

test('chain: sendVaultExecute throws without a live wallet (paper-mode belt-and-braces)', async () => {
  await assert.rejects(() => chain.sendVaultExecute(null, VAULT, { to: CURVE, value: 0n, data: '0x' }), /paper mode/);
  await assert.rejects(() => chain.sendVaultExecute({}, VAULT, { to: CURVE, value: 0n, data: '0x' }), /paper mode/);
});

test('chain: sendVaultExecute passes an explicit checksummed from and wraps the receipt', async () => {
  let sentTx;
  const fakeReceipt = { status: 1, gasUsed: 50000n, hash: '0xtxhash', logs: [] };
  const wallet = {
    getAddress: async () => AGENT.toLowerCase(),
    sendTransaction: async (tx) => {
      sentTx = tx;
      return { hash: '0xtxhash', wait: async () => fakeReceipt };
    },
  };
  const result = await chain.sendVaultExecute(wallet, VAULT.toLowerCase(), { to: CURVE.toLowerCase(), value: 1n, data: '0x1234' });
  assert.equal(sentTx.from, AGENT);
  assert.equal(sentTx.to, VAULT);
  assert.equal(sentTx.value, 0n); // outer envelope value is always 0n — see buildVaultExecuteCalldata
  assert.equal(result.txHash, '0xtxhash');
  assert.equal(result.receipt.status, true);
  assert.equal(result.receipt.gasUsedWei, 50000n);
});
