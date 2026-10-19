// Run with installed DSH Electron in Node mode (ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" scripts/write-safety-runtime-check.mjs
//     [--runtime <dsh directory>] [--output <verification.json>]
// PowerShell: append `2>&1 | Out-String` to wait and collect the PASS record.
// The actual installed ToolRuntime dispatches synthetic tool bodies and agents.
// No model/provider, real profile, editor, UI or shell command is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { registerExecutionGuard } from '../src/execution-guard.mjs';

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--runtime', '--output'].includes(key) || !process.argv[index + 1]) throw new Error('Expected --runtime or --output followed by a path');
  args[key] = resolve(process.argv[index + 1]);
}
const sourceRoot = args['--runtime'] ?? join(dirname(process.execPath), 'resources', 'app.asar', 'dsh');
const runtimeRequire = createRequire(join(sourceRoot, 'package.json'));
const { Context } = runtimeRequire('@deepseek-ai/cordis');
const { ToolRuntime, TOOL_ABORTED_BEFORE_DISPATCH } = runtimeRequire('@deepseek-ai/dsh-tools');
const { scopeTarget } = runtimeRequire('@deepseek-ai/dsh-scope');
const versions = Object.fromEntries(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope'].map(name => [
  name, JSON.parse(fs.readFileSync(join(sourceRoot, 'node_modules', name, 'package.json'), 'utf8')).version,
]));
const context = new Context();
let guard;
try {
  context.provide('systemPrompt', { tools() {} });
  // Only this projection seam is synthetic. Its values are driven exclusively
  // by host turn events, never tool arguments, call UUIDs or tool names.
  const boundaries = new Map();
  context.provide('sessionProjections', {
    stateOf(session, projection) {
      assert.equal(projection, 'turnBoundary');
      return boundaries.get(session.id);
    },
  });
  const tools = new ToolRuntime(context);
  guard = registerExecutionGuard(context, { guardMaxToolCalls: 3, guardMaxSteps: 3, guardMaxErrors: 3, guardTimeoutMs: 30000 });
  const bodyCounts = new Map();
  for (const name of ['unreal_fixture_activate', 'unreal_fixture_read', 'unreal_fixture_other', 'unreal_fixture_fatal', 'pwsh']) {
    tools.register({
      name,
      description: 'Offline write safety fixture; never executes shell or editor code',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        bodyCounts.set(name, (bodyCounts.get(name) ?? 0) + 1);
        return name === 'unreal_fixture_fatal'
          ? { ok: false, error: { code: 'MCP_TOOL_ERROR', message: 'Synthetic UE failure' } }
          : { ok: true, fixture: name };
      },
    });
  }
  let sequence = 0;
  const fixture = id => {
    const session = { id };
    const cancellations = [];
    const agent = {
      session,
      cancel(source, options) { cancellations.push({ source, options }); },
    };
    const signal = new AbortController().signal;
    const event = (type, data) => {
      const seq = ++sequence;
      if (type === 'turn/start') boundaries.set(id, { lastTurn: data.turn, openTurnStartSeq: seq });
      // This is Cordis's actual receiver/event/argument convention, as used by
      // the installed session service. Global guard listeners admit the scope.
      context.emit(scopeTarget(context, agent), 'session/event', session, { type, data, seq, time: Date.now() });
    };
    const start = turn => {
      event('turn/start', { turn });
      event('step/start', { turn, step: 1 });
    };
    const execute = (name, arguments_ = {}) => tools.execute({ name, arguments: arguments_, callId: randomUUID(), agent, signal });
    const step = stepNumber => context.waterfall(scopeTarget(context, agent), 'agent/pre-step', {
      agent, signal, step: stepNumber, messages: [],
    }, () => Promise.resolve({ kind: 'accept', messages: [] }));
    return { session, agent, signal, cancellations, event, start, execute, step };
  };
  const count = name => bodyCounts.get(name) ?? 0;
  const cancelled = result => {
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH, JSON.stringify(result));
  };
  const checks = [];

  const budget = fixture('offline-write-safety-budget');
  budget.start(1);
  assert.equal(guard.status(budget.session.id).boundarySource, 'event');
  assert.equal((await budget.execute('unreal_fixture_activate')).isError, false);
  assert.equal((await budget.execute('unreal_fixture_read')).isError, false);
  // This is a fake pwsh body. Source searches mentioning input APIs are useful
  // diagnostics and must not be confused with invoking those APIs.
  const search = await budget.execute('pwsh', { command: "rg -n 'SetCursorPos|mouse_event|user32.dll' Source" });
  assert.equal(search.isError, false, JSON.stringify(search));
  const otherBefore = count('unreal_fixture_other');
  cancelled(await budget.execute('unreal_fixture_other', { requestId: randomUUID() }));
  assert.equal(count('unreal_fixture_other'), otherBefore, 'over-budget body must not run');
  const shellBefore = count('pwsh');
  cancelled(await budget.execute('pwsh', { command: 'Get-Content Source/ReadOnly.cpp', requestId: randomUUID() }));
  assert.equal(count('pwsh'), shellBefore, 'changing the tool and UUID must not clear the halt');
  assert.equal(budget.cancellations.length, 1);
  assert.equal(guard.status(budget.session.id).toolCalls, 4);
  assert.equal(guard.status(budget.session.id).halted, true);
  checks.push({ name: 'tool-budget-and-identity-changes', result: 'PASS', limit: 3, countedCalls: 4, cancellations: 1, overLimitBodyExecutions: 0, ordinarySourceSearchAllowed: true });

  // A new host-emitted turn boundary releases the latch, independently of the
  // old tool call IDs and without manufacturing a new agent/session identity.
  budget.start(2);
  assert.equal((await budget.execute('unreal_fixture_other')).isError, false);
  assert.equal(guard.status(budget.session.id).halted, false);
  assert.equal(guard.status(budget.session.id).toolCalls, 1);
  checks.push({ name: 'host-turn-boundary-resets-budget', result: 'PASS', turn: 2, countedCalls: 1 });

  const fatal = fixture('offline-write-safety-inner-error');
  fatal.start(1);
  const innerFailure = await fatal.execute('unreal_fixture_fatal');
  assert.equal(innerFailure.isError, false, 'runtime treats the valid JSON body as a successful result');
  assert.equal(innerFailure.value.ok, false);
  assert.equal(innerFailure.value.error.code, 'MCP_TOOL_ERROR');
  assert.equal(fatal.cancellations.length, 1, 'post-execute must inspect the inner error envelope');
  assert.equal(guard.status(fatal.session.id).halted, true);
  const afterFatalBefore = count('unreal_fixture_other');
  cancelled(await fatal.execute('unreal_fixture_other'));
  assert.equal(count('unreal_fixture_other'), afterFatalBefore);
  checks.push({ name: 'inner-mcp-error-stops-turn', result: 'PASS', runtimeIsError: innerFailure.isError, innerCode: innerFailure.value.error.code, cancellations: 1, followupBodyExecutions: 0 });

  const desktop = fixture('offline-write-safety-desktop-input');
  desktop.start(1);
  assert.equal((await desktop.execute('unreal_fixture_activate')).isError, false);
  const desktopBodyBefore = count('pwsh');
  cancelled(await desktop.execute('pwsh', {
    command: 'Add-Type -TypeDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);\'; [Native]::SetCursorPos(10,20)',
  }));
  assert.equal(count('pwsh'), desktopBodyBefore, 'user32 fixture must be stopped before its fake shell body');
  assert.equal(desktop.cancellations.length, 1);
  assert.equal(guard.status(desktop.session.id).halted, true);
  checks.push({ name: 'terminal-desktop-input-stops-before-body', result: 'PASS', cancellations: 1, prohibitedBodyExecutions: 0 });

  const steps = fixture('offline-write-safety-step-budget');
  steps.start(1);
  assert.equal((await steps.execute('unreal_fixture_activate')).isError, false);
  assert.equal((await steps.step(2)).kind, 'accept');
  assert.equal((await steps.step(3)).kind, 'accept');
  assert.equal((await steps.step(4)).kind, 'reject');
  assert.equal(steps.cancellations.length, 1);
  checks.push({ name: 'real-agent-pre-step-waterfall-enforces-budget', result: 'PASS', limit: 3, rejectedStep: 4, cancellations: 1 });

  const record = {
    result: 'PASS', checkedAt: new Date().toISOString(), node: process.versions.node, runtime: sourceRoot, versions,
    checks, syntheticToolBodyCalls: Object.fromEntries(bodyCounts), providerRequests: 0,
    realProfileAccess: false, realEditorAccess: false, realDesktopInput: false, realShellExecution: false,
  };
  if (args['--output']) {
    fs.mkdirSync(dirname(args['--output']), { recursive: true });
    fs.writeFileSync(args['--output'], `${JSON.stringify(record, null, 2)}\n`);
  }
  console.log(JSON.stringify(record));
} finally {
  guard?.dispose();
  await context.fiber.dispose();
}
