import { BridgeError } from './protocol.mjs';

// Match identifiers, not arbitrary substrings in tool arguments or Blueprint
// node names. UE exposes both Python-qualified names and reflected C++ names.
const identifier = words => new RegExp(`(?:^|[^a-z0-9])${words.join('[^a-z0-9]*')}(?=$|[^a-z0-9])`, 'i');
const method = words => new RegExp(`(?:^|[^a-z0-9])${words.join('[^a-z0-9]*')}$`, 'i');
const compact = value => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
const DATA_TABLE = identifier(['data', 'table', 'tools']);
const PROGRAMMATIC = identifier(['programmatic', 'toolset']);
const SLATE = identifier(['slate', 'inspector', 'toolset']);
const EXECUTE_SCRIPT = method(['execute', 'tool', 'script']);
const LOSSY_DATA_TABLE_METHODS = ['set', 'add', 'rename'].flatMap(verb => [method([verb, 'row']), method([verb, 'rows'])]);
const SLATE_READ_PATTERNS = [['snapshot'], ['observe'], ['unobserve'], ['screenshot'], ['wait', 'for'], ['list', 'observers']].map(method);
// These names cover the bridge's public wrapper and UE's actual call_tool
// envelope. Separators and case are normalized only for tool identifiers.
const DISPATCHERS = new Set(['calltool', 'calltoolset', 'unrealmcpcall', 'unrealmcpcalltoolset']);

function blocked(reason, message, recommendedTool) {
  throw new BridgeError('MCP_POLICY_BLOCKED', message, {
    retryable: false,
    reason,
    ...(recommendedTool ? { recommendedTool } : {}),
  });
}

function fieldValues(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  return Object.entries(object).filter(([name]) => compact(name) === key).map(([, value]) => value);
}

function checkTarget(name, args, allowDesktopInput) {
  if (PROGRAMMATIC.test(name) || EXECUTE_SCRIPT.test(name)) {
    blocked('script_execution', 'MCP script execution is disabled. Do not retry; use a native Unreal operation.');
  }
  // data_table.py add_rows, rename_rows and set_rows all call _write_table,
  // which rebuilds the entire asset via an asymmetric JSON round trip.
  // remove_rows is a native row removal; create/import_file do not take this
  // lossy path, so these methods remain available.
  if (DATA_TABLE.test(name) && LOSSY_DATA_TABLE_METHODS.some(pattern => pattern.test(name))) {
    blocked('lossy_json_roundtrip', 'This DataTable tool can lose unrelated data. Do not retry; use native data_table_copy_property.', 'data_table_copy_property');
  }
  if (!SLATE.test(name) || allowDesktopInput) return;
  if (method(['windows']).test(name)) {
    // Windows is observational only for its default/list action. select and
    // close change the user's desktop even though they share the same tool.
    const actions = fieldValues(args, 'action');
    if (actions.every(action => typeof action === 'string' && action.trim().toLowerCase() === 'list')) return;
  } else if (SLATE_READ_PATTERNS.some(pattern => pattern.test(name))) {
    return;
  }
  blocked('desktop_input', 'MCP desktop input is disabled. Do not retry; use a native Unreal operation.');
}

/**
 * Reject unsafe MCP dispatch before sending it to an editor. This is a pure
 * policy check: it neither changes the input nor inspects script/shell bodies.
 * Desktop input can be enabled only by an explicit host-owned option; DataTable
 * JSON mutators and MCP script execution remain disabled in either mode.
 * Returns undefined when allowed; throws BridgeError/MCP_POLICY_BLOCKED when
 * blocked, with details.retryable=false and a stable details.reason.
 */
export function assertSafeMcpCall(call, options = {}) {
  const allowDesktopInput = options.allowDesktopInput === true;
  let current = call;
  for (let depth = 0; depth < 8; depth++) {
    const name = typeof current?.name === 'string' ? current.name : '';
    const args = current?.arguments ?? {};
    checkTarget(name, args, allowDesktopInput);
    if (!DISPATCHERS.has(compact(name))) return;
    const toolsets = fieldValues(args, 'toolsetname');
    const tools = fieldValues(args, 'toolname');
    // unreal_mcp_call carries a nested {name, arguments}; call_tool carries
    // {toolset_name, tool_name, arguments}. Do not silently overlook an alias
    // or conflicting duplicate casing of either dispatch field.
    if (compact(name) === 'unrealmcpcall' && !toolsets.length && !tools.length) {
      const names = fieldValues(args, 'name');
      if (names.length === 1 && typeof names[0] === 'string') {
        current = { name: names[0], arguments: args.arguments };
        continue;
      }
    }
    if (toolsets.length !== 1 || tools.length !== 1 || typeof toolsets[0] !== 'string' || typeof tools[0] !== 'string') {
      blocked('invalid_tool_dispatch', 'MCP tool dispatch is ambiguous or incomplete. Do not retry; use exact discovered tool names.');
    }
    const target = `${toolsets[0]}.${tools[0]}`;
    const toolArgs = args.arguments ?? {};
    checkTarget(target, toolArgs, allowDesktopInput);
    current = { name: tools[0], arguments: toolArgs };
  }
  blocked('invalid_tool_dispatch', 'MCP tool dispatch nesting is unsupported. Do not retry; call the native Unreal operation directly.');
}
