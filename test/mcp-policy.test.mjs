import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeMcpCall } from '../src/mcp-policy.mjs';
import { BridgeError } from '../src/protocol.mjs';

const dataTable = 'editor_toolset.toolsets.data_table.DataTableTools';
const slate = 'SlateInspectorToolset.SlateInspectorToolset';
const programmatic = 'editor_toolset.toolsets.programmatic.ProgrammaticToolset';
const callTool = (toolset, tool, args = {}) => ({ name: 'call_tool', arguments: { toolset_name: toolset, tool_name: tool, arguments: args } });
const denied = (call, reason, options) => assert.throws(() => assertSafeMcpCall(call, options), error => {
  assert.ok(error instanceof BridgeError);
  assert.equal(error.code, 'MCP_POLICY_BLOCKED');
  assert.equal(error.details.reason, reason);
  assert.equal(error.details.retryable, false);
  assert.match(error.message, /Do not retry/);
  return true;
});

test('blocks the actual DataTable JSON writers, their singular aliases and qualified direct calls', () => {
  for (const tool of ['set_rows', 'add_rows', 'rename_rows', 'set_row', 'add_row', 'rename_row']) {
    denied(callTool(dataTable, tool), 'lossy_json_roundtrip');
    denied(callTool(dataTable, `${dataTable}.${tool}`), 'lossy_json_roundtrip');
    denied({ name: `${dataTable}.${tool}`, arguments: {} }, 'lossy_json_roundtrip');
  }
  try { assertSafeMcpCall(callTool(dataTable, 'set_rows')); }
  catch (error) { assert.equal(error.details.recommendedTool, 'data_table_copy_property'); }
});

test('recognizes case, punctuation and camelCase variants of qualified identifiers', () => {
  for (const name of [
    'EDITOR_TOOLSET.TOOLSETS.DATA_TABLE.DATATABLETOOLS.SET_ROWS',
    'DataTableTools::setRows',
    'data-table-tools/set-rows',
    'mcp__unreal__DataTableTools__Set_Rows',
    'SlateInspectorToolset::Press_Key',
    'slate-inspector-toolset/double-click',
  ]) denied({ name }, name.toLowerCase().includes('slate') ? 'desktop_input' : 'lossy_json_roundtrip');
  denied({ name: 'CALL-TOOL', arguments: { TOOLSET_NAME: 'DataTableTools', TOOL_NAME: 'SetRows', arguments: {} } }, 'lossy_json_roundtrip');
});

test('allows DataTable reads and operations which do not use the lossy JSON write path', () => {
  for (const tool of ['search_row_structs', 'get_schema', 'list_rows', 'get_rows', 'read_rows', 'remove_rows', 'create', 'import_file']) {
    assert.equal(assertSafeMcpCall(callTool(dataTable, tool)), undefined);
    assert.equal(assertSafeMcpCall({ name: `${dataTable}.${tool}` }), undefined);
  }
  assert.equal(assertSafeMcpCall({ name: 'data_table_copy_property' }), undefined);
});

test('blocks ProgrammaticToolset and script execution aliases even under an unknown toolset', () => {
  for (const call of [
    callTool(programmatic, 'execute_tool_script'),
    callTool(programmatic, 'list_supported_modules'),
    callTool('UnknownToolset', 'execute_tool_script'),
    callTool('UnknownToolset', 'ExecuteToolScript'),
    { name: `${programmatic}.execute_tool_script` },
    { name: 'unknown-toolset/Execute-Tool-Script' },
    { name: 'execute_tool_script' },
  ]) denied(call, 'script_execution');
});

test('blocks all Slate desktop actions while preserving observational tools', () => {
  for (const tool of ['Click', 'DoubleClick', 'PressKey', 'Type', 'Hover', 'Drag', 'SelectOption', 'FillForm', 'Scroll']) {
    denied(callTool(slate, tool), 'desktop_input');
    denied({ name: `${slate}.${tool}`, arguments: {} }, 'desktop_input');
  }
  for (const tool of ['Snapshot', 'Observe', 'Unobserve', 'ListObservers', 'Screenshot', 'WaitFor', 'Wait_For', 'List_Observers']) {
    assert.equal(assertSafeMcpCall(callTool(slate, tool)), undefined);
    assert.equal(assertSafeMcpCall({ name: `${slate}.${tool}` }), undefined);
  }
});

test('Windows permits only its default/list action, including direct qualified calls', () => {
  for (const args of [{}, { action: 'list' }, { Action: 'LIST' }]) {
    assert.equal(assertSafeMcpCall(callTool(slate, 'Windows', args)), undefined);
    assert.equal(assertSafeMcpCall({ name: `${slate}.Windows`, arguments: args }), undefined);
  }
  for (const args of [{ action: 'select' }, { Action: 'close' }, { action: 'list', Action: 'close' }, { action: null }, { action: '' }]) {
    denied(callTool(slate, 'Windows', args), 'desktop_input');
  }
});

test('only an explicit host option enables desktop input; scripts and lossy writers stay blocked', () => {
  assert.equal(assertSafeMcpCall(callTool(slate, 'Click'), { allowDesktopInput: true }), undefined);
  assert.equal(assertSafeMcpCall(callTool(slate, 'Windows', { action: 'close' }), { allowDesktopInput: true }), undefined);
  denied(callTool(slate, 'Click', { allowDesktopInput: true }), 'desktop_input');
  denied(callTool(slate, 'Click'), 'desktop_input', { allowDesktopInput: 'true' });
  denied(callTool(dataTable, 'set_rows'), 'lossy_json_roundtrip', { allowDesktopInput: true });
  denied(callTool(programmatic, 'execute_tool_script'), 'script_execution', { allowDesktopInput: true });
});

test('covers public camelCase wrappers and nested top-level dispatch', () => {
  denied({ name: 'unreal_mcp_call_toolset', arguments: { toolsetName: dataTable, toolName: 'set_rows', arguments: {} } }, 'lossy_json_roundtrip');
  denied({ name: 'call_toolset', arguments: { toolsetName: slate, toolName: 'Click', arguments: {} } }, 'desktop_input');
  denied({ name: 'unreal_mcp_call', arguments: callTool('UnknownToolset', 'execute_tool_script') }, 'script_execution');
  denied(callTool('UnknownToolset', 'call_tool', { toolset_name: dataTable, tool_name: 'set_rows', arguments: {} }), 'lossy_json_roundtrip');
  assert.equal(assertSafeMcpCall({ name: 'unreal_mcp_call', arguments: callTool(dataTable, 'get_rows') }), undefined);
});

test('ambiguous dispatcher fields cannot bypass policy checks', () => {
  for (const args of [
    {},
    { toolset_name: dataTable },
    { toolset_name: 'Safe', toolsetName: dataTable, tool_name: 'set_rows' },
    { toolset_name: 'Safe', tool_name: 'get_rows', toolName: 'execute_tool_script' },
  ]) denied({ name: 'call_tool', arguments: args }, 'invalid_tool_dispatch');
});

test('does not confuse ordinary Blueprint names or argument text with executable MCP tools', () => {
  for (const tool of ['Click', 'OnClicked', 'AddOnClickNode', 'set_rows', 'DataTableToolsInfo']) {
    assert.equal(assertSafeMcpCall(callTool('editor_toolset.toolsets.blueprint.BlueprintTools', tool, { name: 'SlateInspectorToolset.Click', script: 'execute_tool_script' })), undefined);
  }
  const call = callTool(dataTable, 'get_rows', { row_names: ['Click', 'execute_tool_script'], nested: { tool_name: 'set_rows' } });
  const before = structuredClone(call);
  Object.freeze(call.arguments.arguments);
  assertSafeMcpCall(call);
  assert.deepEqual(call, before);
  assert.equal(assertSafeMcpCall({ name: 'describe_toolset', arguments: { toolset_name: programmatic } }), undefined);
});
