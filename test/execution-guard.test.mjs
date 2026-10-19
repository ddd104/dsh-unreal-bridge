import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerExecutionGuard} from '../src/execution-guard.mjs';

function fixture(t,config={},options={}){
  const hooks=new Map(),cancellations=[];
  const session={id:'conversation'};
  const agent={session,cancel:(...args)=>cancellations.push(args)};
  const ctx=options.noHooks?{}:{on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);}};
  if(options.projection)ctx.sessionProjections={stateOf:()=>options.projection};
  const guard=registerExecutionGuard(ctx,config);t.after(()=>guard.dispose());
  const event=(type,data,seq)=>hooks.get('session/event')?.(session,{type,data,seq});
  const exec=(name='unreal_state',arguments_={},extra={})=>({agent,name,arguments:arguments_,callId:randomUUID(),token:Symbol('execution'),signal:new AbortController().signal,...extra});
  const pre=call=>hooks.get('tools/pre-execute')(call,async()=>({kind:'allow'}));
  const post=(call,result)=>hooks.get('tools/post-execute')(call,result,async()=>({kind:'accept'}));
  const step=step=>hooks.get('agent/pre-step')({agent,turn:1,step,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}));
  event('turn/start',{turn:1},1);
  return {ctx,hooks,session,agent,guard,event,exec,pre,post,step,cancellations};
}

test('the first Unreal call activates the guard and all later root tools share its budget',async t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  assert.deepEqual(await f.pre(f.exec('pwsh',{command:'Get-Content file.txt'})),{kind:'allow'});
  assert.equal(f.guard.status(f.session.id).active,false);
  assert.deepEqual(await f.pre(f.exec()),{kind:'allow'});
  assert.deepEqual(await f.pre(f.exec('read',{path:'a.txt'})),{kind:'allow'});
  assert.deepEqual(await f.pre(f.exec('pwsh',{command:'Get-Content file.txt'})),{kind:'cancel'});
  assert.equal(f.cancellations.length,1);
  assert.equal(f.cancellations[0][0].kind,'hook');
  assert.match(f.cancellations[0][0].reason,/工具调用上限/);
  assert.deepEqual(f.cancellations[0][1],{keepInbox:true});
  assert.deepEqual(await f.pre(f.exec('read')),{kind:'cancel'});
  assert.equal(f.cancellations.length,1);
});

test('changing request UUIDs, tool names and arguments cannot reset the budget',t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  f.guard.before(f.exec('unreal_mcp_call',{requestId:randomUUID(),name:'read_a'}));
  f.guard.before(f.exec('unreal_mcp_call_toolset',{requestId:randomUUID(),toolName:'read_b'}));
  assert.throws(()=>f.guard.before(f.exec('unreal_state',{requestId:randomUUID()})),error=>error.code==='EXECUTION_HALTED'&&error.details.retryable===false);
  assert.equal(f.guard.status(f.session.id).calls,3);
});

test('hooks and wrapper callbacks count the same root execution only once',async t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  const call=f.exec();
  await f.pre(call);f.guard.before(call);
  f.guard.before({...call,token:Symbol('same root copy')});
  assert.equal(f.guard.status(f.session.id).calls,1);
  const error={ok:false,error:{code:'EDITOR_ERROR',message:'bad value'}};
  f.guard.after(call,error);await f.post(call,{isError:false,value:error});
  assert.equal(f.guard.status(f.session.id).errors,1);
});

test('nested Unreal SDK dispatch activates and counts its transport root once',async t=>{
  const f=fixture(t);
  const root=f.exec('run_code',{code:'await tools.unreal_state({})'});
  await f.pre(root);
  const inner=f.exec('unreal_state',{}, {parent:root.token,rootCallId:root.callId});
  await f.pre(inner);f.guard.before(inner);
  await f.pre(f.exec('unreal_read_blueprint',{}, {parent:root.token,rootCallId:root.callId}));
  f.guard.before(root);
  assert.equal(f.guard.status(f.session.id).calls,1);
});

test('nested calls without rootCallId resolve their registered parent token',async t=>{
  const f=fixture(t);
  const root=f.exec('run_code');await f.pre(root);
  const inner=f.exec('unreal_state',{}, {parent:root.token});await f.pre(inner);
  await f.pre(f.exec('unreal_read_blueprint',{}, {parent:inner.token}));
  assert.equal(f.guard.status(f.session.id).calls,1);
});

test('body errors accumulate despite successful ordinary runtime results between errors',async t=>{
  const f=fixture(t,{guardMaxErrors:3});
  for(let index=0;index<3;index++){
    const call=f.exec(index?'pwsh':'unreal_state');await f.pre(call);
    const body={ok:false,error:{code:'EDITOR_ERROR',message:'read failed'}};
    f.guard.after(call,body);await f.post(call,{isError:false,value:body});
    if(index<2){const good=f.exec('read');await f.pre(good);await f.post(good,{isError:false,value:{ok:true}});}
  }
  assert.equal(f.guard.status(f.session.id).errors,3);
  assert.equal(f.cancellations.length,1);
  assert.match(f.cancellations[0][0].reason,/累计 3 次工具错误/);
});

test('host-level thrown-tool results count as errors',async t=>{
  const f=fixture(t,{guardMaxErrors:1});const call=f.exec();await f.pre(call);
  await f.post(call,{isError:true,error:{message:'failure',info:{code:'ERROR'}},content:[]});
  assert.equal(f.guard.status(f.session.id).errors,1);
  assert.equal(f.cancellations.length,1);
});

test('fatal write or policy errors halt immediately even when rollback restored the values',t=>{
  for(const code of ['MCP_POLICY_BLOCKED','MCP_TOOL_ERROR','DATA_TABLE_COPY_UNAVAILABLE','DATA_TABLE_VERIFICATION_FAILED','DATA_TABLE_ROLLBACK_FAILED','EDITOR_WRITE_LOCKED']){
    const f=fixture(t);const call=f.exec();f.guard.before(call);
    f.guard.after(call,{ok:false,error:{code,details:{rollback:'restored'}}});
    assert.equal(f.guard.status(f.session.id).halted,true,code);
    assert.equal(f.cancellations.length,1,code);
  }
});

test('rollback failed is fatal independently of its error code',t=>{
  const f=fixture(t);const call=f.exec();f.guard.before(call);
  f.guard.after(call,{ok:false,error:{code:'UNEXPECTED_ERROR',details:{rollback:'failed'}}});
  assert.equal(f.cancellations.length,1);
});

test('an actual new turn resets a halted guard while late old results cannot poison it',t=>{
  const f=fixture(t,{guardMaxErrors:1});const old=f.exec();f.guard.before(old);f.guard.after(old,{ok:false});
  assert.equal(f.guard.status(f.session.id).halted,true);
  f.event('turn/end',{turn:1},3);f.event('turn/start',{turn:2},4);
  assert.equal(f.guard.status(f.session.id).halted,false);
  f.guard.after(old,{ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED'}});
  assert.equal(f.guard.status(f.session.id).errors,0);
  f.guard.before(f.exec());assert.equal(f.guard.status(f.session.id).calls,1);
});

test('model-step budget includes the activation step and ignores earlier steps',async t=>{
  const f=fixture(t,{guardMaxSteps:2});
  await f.step(17);await f.pre(f.exec());
  assert.equal((await f.step(18)).kind,'enter');
  assert.equal((await f.step(19)).kind,'reject');
  assert.equal(f.cancellations.length,1);
  assert.match(f.cancellations[0][0].reason,/模型步骤/);
});

test('parallel prechecks cannot all pass an exhausted shared budget',async t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  const results=await Promise.all(Array.from({length:8},()=>f.pre(f.exec())));
  assert.equal(results.filter(result=>result.kind==='allow').length,2);
  assert.equal(results.filter(result=>result.kind==='cancel').length,6);
  assert.equal(f.cancellations.length,1);
});

test('the active-turn timeout really cancels its agent',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t,{guardTimeoutMs:50});f.guard.before(f.exec());
  t.mock.timers.tick(49);assert.equal(f.cancellations.length,0);
  t.mock.timers.tick(1);assert.equal(f.cancellations.length,1);
  assert.match(f.cancellations[0][0].reason,/超过/);
});

test('turn end, a new turn and disposal clear old timeout callbacks',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t,{guardTimeoutMs:50});f.guard.before(f.exec());
  t.mock.timers.tick(20);f.event('turn/end',{turn:1},3);f.event('turn/start',{turn:2},4);
  t.mock.timers.tick(50);assert.equal(f.cancellations.length,0);
  f.guard.before(f.exec());f.guard.dispose();f.guard.dispose();
  t.mock.timers.tick(50);assert.equal(f.cancellations.length,0);
  assert.equal(f.hooks.size,0);assert.equal(f.guard.status(f.session.id),null);
});

test('no-hook wrapper fallback enforces and latches its budget',t=>{
  const f=fixture(t,{guardMaxToolCalls:1},{noHooks:true});
  f.guard.before(f.exec());
  assert.throws(()=>f.guard.before(f.exec('unreal_state',{requestId:randomUUID()})),{code:'EXECUTION_HALTED'});
  assert.equal(f.cancellations.length,1);
  assert.equal(f.guard.status(f.session.id).boundarySource,'unavailable');
});

test('no-hook wrapper fallback can follow official turn-boundary projections',t=>{
  const projection={openTurnStartSeq:1,lastTurn:1};
  const f=fixture(t,{guardMaxToolCalls:1},{noHooks:true,projection});
  f.guard.before(f.exec());assert.throws(()=>f.guard.before(f.exec()),{code:'EXECUTION_HALTED'});
  projection.openTurnStartSeq=7;projection.lastTurn=2;
  f.guard.before(f.exec());
  assert.equal(f.guard.status(f.session.id).turn,2);
  assert.equal(f.guard.status(f.session.id).halted,false);
  assert.equal(f.guard.status(f.session.id).calls,1);
});

test('explicit real-input APIs in shell calls are stopped only after Unreal activation',async t=>{
  for(const command of [
    'Get-Clipboard','Set-Clipboard -Value text',
    '[System.Windows.Forms.Clipboard]::SetText("x")',
    'Add-Type \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);\'',
    '[Native]::mouse_event(2,0,0,0,0)','[Native]::SendInput(1,$input,40)',
    'python -c "import ctypes; ctypes.windll.user32.SetCursorPos(1,2)"',
    'python -c "import pyautogui; pyautogui.click(1,2)"',
  ]){
    const f=fixture(t);
    assert.equal((await f.pre(f.exec('pwsh',{command}))).kind,'allow');
    await f.pre(f.exec());
    assert.equal((await f.pre(f.exec('pwsh',{command}))).kind,'cancel',command);
    assert.match(f.cancellations[0][0].reason,/真实鼠标或剪贴板/);
  }
});

test('ordinary source reads and searches mentioning API names remain allowed',async t=>{
  const f=fixture(t);await f.pre(f.exec());
  for(const command of ['Get-Content src/clipboard.mjs',"rg -n 'user32|SendInput|Get-Clipboard' src",'grep SetCursorPos source.cpp | head -20']){
    assert.equal((await f.pre(f.exec('pwsh',{command}))).kind,'allow',command);
  }
  assert.equal((await f.pre(f.exec('read',{path:'user32.dll.txt'}))).kind,'allow');
  assert.equal((await f.pre(f.exec('pwsh',{command:'Get-Content text.txt | Set-Clipboard'}))).kind,'cancel');
});

test('sessions have independent budgets and pre-Unreal failures do not activate them',t=>{
  const f=fixture(t,{guardMaxErrors:1,guardMaxToolCalls:1});
  const ordinary=f.exec('pwsh');f.guard.before(ordinary);f.guard.after(ordinary,{ok:false});
  assert.equal(f.guard.status(f.session.id).active,false);
  f.guard.before(f.exec());
  const other={session:{id:'another'},cancel(){throw new Error('unexpected cancellation');}};
  f.guard.before(f.exec('unreal_state',{}, {agent:other}));
  assert.equal(f.guard.status('another').calls,1);
  assert.equal(f.guard.status(f.session.id).calls,1);
});

test('invalid guard limits fail clearly',()=>{
  for(const value of [0,-1,1.5,Infinity,'40'])assert.throws(()=>registerExecutionGuard({}, {guardMaxToolCalls:value}),/positive safe integer/);
});
