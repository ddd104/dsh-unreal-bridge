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
const { ToolRuntime } = runtimeRequire('@deepseek-ai/dsh-tools');
const { scopeTarget } = runtimeRequire('@deepseek-ai/dsh-scope');
const { SystemPrompt } = runtimeRequire('@deepseek-ai/dsh-system-prompt');
const { createUserMessage } = runtimeRequire('@deepseek-ai/dsh-llm');
const { snapshotJsonValue } = runtimeRequire('@deepseek-ai/dsh-util-values');
const versions = Object.fromEntries(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope'].map(name => [
  name, JSON.parse(fs.readFileSync(join(sourceRoot, 'node_modules', name, 'package.json'), 'utf8')).version,
]));
const context = new Context();
let guard;
try {
  new SystemPrompt(context,{});
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
  for (const name of ['unreal_fixture_activate', 'unreal_fixture_read', 'unreal_fixture_other', 'unreal_fixture_write_error', 'unreal_fixture_rollback_failed', 'unreal_fixture_write_locked', 'unreal_state', 'unreal_request_status', 'pwsh']) {
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
        if(name==='unreal_fixture_write_error')return {ok:false,error:{code:'MCP_TOOL_ERROR',message:'Synthetic UE failure: preserve existing array entries before appending',details:{rollback:'not_available',retryable:true,recovery:'verify_before_retry'}}};
        if(name==='unreal_fixture_rollback_failed')return {ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED',message:'Synthetic rollback could not be verified',details:{rollback:'failed',retryable:false}}};
        if(name==='unreal_fixture_write_locked')return {ok:false,error:{code:'EDITOR_WRITE_LOCKED',message:'Synthetic editor write lock',details:{rollback:'failed',retryable:false}}};
        return {ok:true,fixture:name};
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
    const step = (stepNumber,next=()=>Promise.resolve({kind:'enter',messages:[]})) => context.waterfall(scopeTarget(context, agent), 'agent/pre-step', {
      agent, signal, step: stepNumber, messages: [],
    }, next);
    const assemble=()=>context.systemPrompt.assemble({agent,scope:agent,signal});
    return { session, agent, signal, cancellations, event, start, execute, step, assemble };
  };
  const count = name => bodyCounts.get(name) ?? 0;
  const denied=result=>{
    assert.equal(result.isError,true,JSON.stringify(result));
    assert.equal(result.error.info.code,'EXECUTION_BUDGET_EXHAUSTED',JSON.stringify(result));
    assert.match(result.error.message,/总结已完成、未完成/);
    assert.notEqual(snapshotJsonValue(result.error.info),undefined);
  };
  const notice=decision=>{
    const message=decision.messages.at(-1);
    assert.equal(message.role,'user');assert.equal(message.source.kind,'unreal-execution-budget');
    assert.notEqual(snapshotJsonValue(message),undefined);
    const official=createUserMessage({content:message.content,source:message.source});
    assert.deepEqual({...message,id:'same'},{...official,id:'same'},'budget notice must match the real DSH message constructor');
    return message.content[0].text;
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
  denied(await budget.execute('unreal_fixture_other', { requestId: randomUUID() }));
  assert.equal(count('unreal_fixture_other'), otherBefore, 'over-budget body must not run');
  const shellBefore = count('pwsh');
  denied(await budget.execute('pwsh', { command: 'Get-Content Source/ReadOnly.cpp', requestId: randomUUID() }));
  assert.equal(count('pwsh'), shellBefore, 'changing the tool and UUID must not clear the halt');
  assert.equal(budget.cancellations.length, 0);
  assert.equal(guard.status(budget.session.id).toolCalls, 3);
  assert.equal(guard.status(budget.session.id).budgetExhausted, true);
  assert.equal(guard.status(budget.session.id).errors,0,'budget denials must not trigger the failure budget');
  checks.push({ name: 'tool-budget-and-identity-changes', result: 'PASS', limit: 3, countedCalls: 3, cancellations: 0, denialCode:'EXECUTION_BUDGET_EXHAUSTED', overLimitBodyExecutions: 0, ordinarySourceSearchAllowed: true });

  const recoveryAssembly=await budget.assemble();
  assert.deepEqual(recoveryAssembly.tools.map(tool=>tool.name).sort(),['unreal_request_status','unreal_state']);
  assert.equal((await budget.step(2,()=>Promise.resolve({kind:'reject'}))).kind,'reject');
  assert.match(notice(await budget.step(2)),/最多两次/,'a downstream rejection must not consume the recovery sample');
  assert.equal((await budget.execute('unreal_state')).isError,false);
  assert.equal((await budget.execute('unreal_request_status',{requestId:randomUUID()})).isError,false);
  denied(await budget.execute('unreal_state'));
  assert.deepEqual((await budget.assemble()).tools,[],'the final summary must advertise no tool schema');
  assert.equal((await budget.step(3,()=>Promise.resolve({kind:'reject'}))).kind,'reject');
  assert.match(notice(await budget.step(3)),/不得再调用工具/,'a downstream rejection must not consume the final summary sample');
  assert.equal((await budget.step(4)).kind,'reject');
  assert.equal(budget.cancellations.length,0);
  checks.push({name:'bounded-recovery-and-tool-free-summary',result:'PASS',recoveryCalls:2,extraSamples:2,finalToolSchemas:0,cancellations:0,downstreamRejectDoesNotConsumeSamples:true});

  // A new host-emitted turn boundary releases the latch, independently of the
  // old tool call IDs and without manufacturing a new agent/session identity.
  budget.start(2);
  assert.equal((await budget.execute('unreal_fixture_other')).isError, false);
  assert.equal(guard.status(budget.session.id).halted, false);
  assert.equal(guard.status(budget.session.id).toolCalls, 1);
  checks.push({ name: 'host-turn-boundary-resets-budget', result: 'PASS', turn: 2, countedCalls: 1 });

  const correction = fixture('offline-write-safety-inner-error');
  correction.start(1);
  const innerFailure = await correction.execute('unreal_fixture_write_error');
  assert.equal(innerFailure.isError, false, 'runtime treats the valid JSON body as a successful result');
  assert.equal(innerFailure.value.ok, false);
  assert.equal(innerFailure.value.error.code, 'MCP_TOOL_ERROR');
  assert.equal(correction.cancellations.length,0,'post-execute must return the failure without cancelling the turn');
  const correctionState=guard.status(correction.session.id);
  assert.equal(correctionState.halted,false);assert.equal(correctionState.budgetExhausted,false);
  assert.equal(correctionState.errors,1);assert.equal(correctionState.lastError.code,'MCP_TOOL_ERROR');
  assert.equal(correctionState.lastError.rollback,'not_available');
  assert.equal(correctionState.lastError.recovery,'verify_before_retry');
  assert.match(notice(await correction.step(2)),/MCP_TOOL_ERROR/);
  assert.equal((await correction.execute('unreal_fixture_read')).isError,false,'the model must be able to inspect the current result before correcting');
  const afterReadback=await correction.step(3);
  assert.equal(afterReadback.messages.some(message=>message.content?.some(block=>block.type==='text'&&block.text.includes('MCP_TOOL_ERROR'))),false,'the same failure must not inject its correction notice twice');
  const correctionBefore=count('unreal_fixture_other');
  assert.equal((await correction.execute('unreal_fixture_other')).isError,false);
  assert.equal(count('unreal_fixture_other'),correctionBefore+1);
  assert.equal(guard.status(correction.session.id).errors,1,'successful verification and correction do not reset the accumulated failures');
  checks.push({name:'inner-mcp-error-readback-and-corrected-call',result:'PASS',runtimeIsError:innerFailure.isError,innerCode:innerFailure.value.error.code,cancellations:0,readbackBodyExecutions:1,correctedBodyExecutions:1,correctionNotices:1});

  for(const [toolName,code] of [['unreal_fixture_rollback_failed','DATA_TABLE_ROLLBACK_FAILED'],['unreal_fixture_write_locked','EDITOR_WRITE_LOCKED']]){
    const unsafe=fixture(`offline-write-safety-${code.toLowerCase()}`);unsafe.start(1);
    const failure=await unsafe.execute(toolName);
    assert.equal(failure.value.error.code,code);
    assert.equal(unsafe.cancellations.length,0);
    assert.equal(guard.status(unsafe.session.id).halted,false);
    assert.equal(guard.status(unsafe.session.id).exhaustedBy,'unsafe_state');
    const beforeUnsafeFollowup=count('unreal_fixture_other');
    denied(await unsafe.execute('unreal_fixture_other'));
    assert.equal(count('unreal_fixture_other'),beforeUnsafeFollowup);
    assert.match(notice(await unsafe.step(2)),/不得再修改资产|停止.*修改/);
    assert.equal((await unsafe.execute('unreal_state')).isError,false);
    assert.deepEqual((await unsafe.assemble()).tools,[]);
    assert.match(notice(await unsafe.step(3)),/不得再调用工具/);
    assert.equal(unsafe.cancellations.length,0);
    checks.push({name:`${code.toLowerCase()}-blocks-writes-and-preserves-summary`,result:'PASS',exhaustedBy:'unsafe_state',cancellations:0,followupBodyExecutions:0,finalToolSchemas:0});
  }

  const desktop = fixture('offline-write-safety-desktop-input');
  desktop.start(1);
  assert.equal((await desktop.execute('unreal_fixture_activate')).isError, false);
  const desktopBodyBefore = count('pwsh');
  const desktopDenied=await desktop.execute('pwsh', {
    command: 'Add-Type -TypeDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);\'; [Native]::SetCursorPos(10,20)',
  });
  assert.equal(desktopDenied.isError,true);
  assert.equal(desktopDenied.error.info.code,'MCP_POLICY_BLOCKED');
  assert.equal(count('pwsh'), desktopBodyBefore, 'user32 fixture must be stopped before its fake shell body');
  assert.equal(desktop.cancellations.length,0);
  assert.equal(guard.status(desktop.session.id).halted,false);
  assert.equal((await desktop.execute('unreal_fixture_other')).isError,false,'a permitted native operation remains available after the denied route');
  checks.push({name:'terminal-desktop-input-denied-with-native-correction-available',result:'PASS',code:'MCP_POLICY_BLOCKED',cancellations:0,prohibitedBodyExecutions:0,correctedBodyExecutions:1});

  const steps = fixture('offline-write-safety-step-budget');
  steps.start(1);
  assert.equal((await steps.execute('unreal_fixture_activate')).isError, false);
  assert.equal((await steps.step(2)).kind, 'enter');
  assert.equal((await steps.step(3)).kind, 'enter');
  assert.deepEqual((await steps.assemble()).tools,[]);
  assert.match(notice(await steps.step(4)),/不得再调用工具/);
  denied(await steps.execute('unreal_state'));
  assert.equal((await steps.step(5)).kind, 'reject');
  assert.equal(steps.cancellations.length, 0);
  checks.push({ name: 'real-agent-pre-step-waterfall-enforces-budget', result: 'PASS', limit: 3, summaryStep:4,rejectedStep: 5, finalToolSchemas:0,cancellations: 0 });

  guard.dispose();guard=registerExecutionGuard(context);
  const defaults=fixture('offline-write-safety-default-budget');defaults.start(1);
  assert.deepEqual(guard.status(defaults.session.id).limits,{guardMaxToolCalls:300,guardMaxSteps:200,guardMaxErrors:50,guardTimeoutMs:1800000});
  for(let call=1;call<=300;call++){
    assert.equal((await defaults.execute('unreal_fixture_read')).isError,false);
    if(call===41)assert.equal(guard.status(defaults.session.id).budgetExhausted,false);
    if(call===240){assert.match(notice(await defaults.step(2)),/预算接近上限.*剩余工具调用 60 次/);assert.equal(guard.status(defaults.session.id).phase,'warning');}
  }
  denied(await defaults.execute('unreal_fixture_read'));
  assert.equal(defaults.cancellations.length,0);
  checks.push({name:'default-300-calls-with-200-steps-50-errors-and-30-minutes',result:'PASS',allowedCalls:300,firstDeniedCall:301,modelStepBudget:200,errorBudget:50,timeoutMs:1800000,modelVisibleWarning:true,cancellations:0});

  const failureBudget=fixture('offline-write-safety-default-error-budget');failureBudget.start(1);
  for(let attempt=1;attempt<=50;attempt++){
    const failure=await failureBudget.execute('unreal_fixture_write_error');
    assert.equal(failure.value.error.code,'MCP_TOOL_ERROR');
    assert.equal(guard.status(failureBudget.session.id).errors,attempt);
    assert.equal(failureBudget.cancellations.length,0);
    if(attempt<50)assert.equal(guard.status(failureBudget.session.id).budgetExhausted,false);
  }
  assert.equal(guard.status(failureBudget.session.id).exhaustedBy,'errors');
  denied(await failureBudget.execute('unreal_fixture_other'));
  assert.match(notice(await failureBudget.step(2)),/50 次/);
  assert.equal((await failureBudget.execute('unreal_state')).isError,false);
  assert.match(notice(await failureBudget.step(3)),/不得再调用工具/);
  checks.push({name:'default-50-accumulated-failures-retain-readback-and-summary',result:'PASS',countedFailures:50,exhaustedBy:'errors',cancellations:0});

  guard.dispose();guard=registerExecutionGuard(context,{guardMaxToolCalls:1,guardTimeoutMs:25});
  const timeout=fixture('offline-write-safety-timeout-after-budget');timeout.start(1);
  assert.equal((await timeout.execute('unreal_fixture_activate')).isError,false);
  denied(await timeout.execute('unreal_fixture_read'));
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(timeout.cancellations.length,1);assert.equal(guard.status(timeout.session.id).halted,true);
  checks.push({name:'timeout-remains-fatal-after-soft-budget',result:'PASS',cancellations:1});

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
