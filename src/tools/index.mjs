// src/tools — the MCP server(s): read-only intelligence tools for analysts, guarded trade
// tools for the decider, and the per-role tool-name allowlist builder.
// Contract: see INTERFACES.md#src-tools.

function notImplemented(fn) {
  throw new Error(`src/tools: ${fn} not implemented — see INTERFACES.md`);
}

/**
 * Tool-name allowlists per agent role — the literal --allowedTools list passed to each
 * sandboxed `claude -p` invocation. '+hartii_launch_token' is appended to decider's list only
 * when launches are enabled (see src/config). There is no NFT-deploy tool, ever.
 */
export const TOOL_ALLOWLISTS = Object.freeze({
  momentumScout: Object.freeze(['hartii_market']),
  riskAnalyst: Object.freeze(['hartii_market', 'hartii_token_detail']),
  portfolioManager: Object.freeze(['hartii_market', 'hartii_status']),
  decider: Object.freeze(['hartii_market', 'hartii_status', 'hartii_quote', 'hartii_buy', 'hartii_sell']),
});

/**
 * Read-only tools: market snapshot, vault status, quote. No key use, no writes.
 * @param {object} ctx ToolCtx
 * @returns {Array<{ name: string, description: string, inputSchema: object, handler: Function }>}
 */
export function buildReadOnlyTools(ctx) {
  return notImplemented('buildReadOnlyTools');
}

/**
 * Guarded trade tools: hartii_buy / hartii_sell run every proposed size through src/guard
 * before src/chain ever builds calldata. hartii_launch_token is included only when
 * ctx.config.launchesEnabled is true.
 * @param {object} ctx ToolCtx
 * @returns {Array<{ name: string, description: string, inputSchema: object, handler: Function }>}
 */
export function buildTradeTools(ctx) {
  return notImplemented('buildTradeTools');
}

/**
 * @param {Array<{ name: string, description: string, inputSchema: object, handler: Function }>} tools
 * @param {{ name: string, version?: string }} opts
 */
export function createMcpServer(tools, opts) {
  return notImplemented('createMcpServer');
}
