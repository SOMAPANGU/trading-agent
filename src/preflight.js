const EXECUTION_NAME =
  /(^|_)(place|submit|create|cancel|amend|replace)_(an?_)?(order|orders)($|_)|(^|_)(open|close|reduce|flatten)_(position|positions)($|_)|(^|_)(buy|sell)_order($|_)|set_leverage|withdraw|deposit|transfer_funds|execute_order|enter_order|paper_order|live_order|(^|_)(market|limit)_order($|_)/i;

const LIQUID_SERVER = /liquid|co-?invest/i;

const QUIVER_HINT = /quiver|congress|insider|lobbying|gov_contract/i;

export function isExecutionTool(name) {
  const value = String(name || "");
  if (EXECUTION_NAME.test(value)) return true;
  const lower = value.toLowerCase();
  const side = /(buy|sell|close|order|trade)/.test(lower);
  const verb = /(place|submit|execute|create|cancel|amend)/.test(lower);
  return side && verb;
}

export function isLiquidTool(tool) {
  const server = String(tool?.server || "");
  const name = String(tool?.name || "");
  return LIQUID_SERVER.test(server) || LIQUID_SERVER.test(name);
}

export function isQuiverTool(tool) {
  const server = String(tool?.server || "");
  const name = String(tool?.name || "");
  return QUIVER_HINT.test(server) || QUIVER_HINT.test(name);
}

/**
 * Scheduled runs must pass the tool catalog they actually have.
 * New risk is allowed only when Liquid Co-Invest exposes a research tool.
 * Execution tools are recorded and never treated as permission to trade live.
 */
export function preflight(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const liquid = list.filter(isLiquidTool);
  const execution = liquid.filter((tool) => isExecutionTool(tool.name));
  const research = liquid.filter((tool) => !isExecutionTool(tool.name));
  const quiver = list.filter(isQuiverTool);
  const ok = research.length > 0;
  return {
    ok,
    code: ok ? "mcp_research_available" : "mcp_unavailable",
    liquidResearchTools: research.map(toolLabel),
    blockedExecutionTools: execution.map(toolLabel),
    quiverAvailable: quiver.length > 0,
    quiverTools: quiver.map(toolLabel),
  };
}

function toolLabel(tool) {
  const server = tool?.server ? String(tool.server) : "unknown";
  const name = tool?.name ? String(tool.name) : "unnamed";
  return `${server}/${name}`;
}
