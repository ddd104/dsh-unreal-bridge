import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerExecutionGuard,EXECUTION_LIMIT_DEFAULTS} from '../src/execution-guard.mjs';
import {DEFAULTS} from '../src/settings-spec.mjs';

function fixture(t,config={},options={}){
  const hooks=new Map(),changes=[];
  const agent={session:{id:'chat'},cancel(){}};
  const ctx={on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);}};
  const guard=registerExecutionGuard(ctx,config,{onChange:(sessionId,status)=>changes.push({sessionId,status}),...options});
  t.after(()=>guard.dispose());
  const event=(type,turn,seq)=>hooks.get('session/event')(agent.session,{type,seq,data:{turn}});
  event('turn/start',1,1);
  const exec=(name='unreal_apply',arguments_={})=>({agent,name,arguments:arguments_,callId:randomUUID(),token:Symbol('exec')});
  const attach=(call,extra={})=>guard.setOperation(call,{editorId:'UE',target:'/Game/BP_Test',family:'blueprint_edit',kind:'write',...extra});
  const fail=(call,message='Same graph error')=>guard.after(call,{ok:false,error:{code:'MCP_TOOL_ERROR',message,details:{rollback:'not_available'}}});
  return {guard,hooks,agent,event,exec,attach,fail,changes};
}

test('global hooks and wrapper rechecks count each corrective write once',async t=>{
  const f=fixture(t,{guardMaxRepeatedErrors:10});
  const first=f.exec();f.guard.before(first);f.attach(first);f.guard.before(first);f.fail(first);
  const retry=f.exec('unreal_mcp_call_toolset',{requestId:randomUUID()});
  await f.hooks.get('tools/pre-execute')(retry,async()=>({kind:'allow'}));
  f.attach(retry);f.guard.before(retry);f.guard.before(retry);f.fail(retry,'Second error');
  await f.hooks.get('tools/post-execute')(retry,{ok:false,error:{code:'MCP_TOOL_ERROR',message:'Second error'}},async()=>({kind:'accept'}));
  const state=f.guard.status('chat');
  assert.equal(state.calls,2);assert.equal(state.errors,2);assert.equal(state.repairs.attemptsUsed,1);assert.equal(state.repairs.failures,2);
  assert.equal(f.changes.at(-1).status.repairs.attemptsUsed,1);
});

test('nested SDK leaves sharing one root cannot hide multiple corrective writes',t=>{
  const f=fixture(t,{guardMaxRepairAttempts:1,guardMaxRepeatedErrors:10});
  const root=Symbol('SDK root');
  const first=f.exec();first.rootCallId=root;f.attach(first);f.guard.before(first);f.fail(first);
  const retry=f.exec();retry.rootCallId=root;f.attach(retry);f.guard.before(retry);f.fail(retry,'Another error');
  const denied=f.exec();denied.rootCallId=root;f.attach(denied);
  assert.throws(()=>f.guard.before(denied),{code:'REPAIR_BUDGET_EXHAUSTED'});
  assert.equal(f.guard.status('chat').calls,1);
  assert.equal(f.guard.status('chat').repairs.attemptsUsed,1);
});

test('single-problem denial preserves global error allowance and independent work',async t=>{
  const f=fixture(t,{guardMaxRepairAttempts:0});
  const first=f.exec();f.attach(first);f.guard.before(first);f.fail(first);
  const denied=f.exec();f.attach(denied);
  const decision=await f.hooks.get('tools/pre-execute')(denied,async()=>({kind:'allow'}));
  assert.equal(decision.kind,'deny');assert.equal(decision.info.code,'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(decision.info.details.recovery,'stop_problem');
  assert.equal(decision.info.details.recoveryConstraints.independentWork,'already_requested_unrelated_work');
  f.guard.after(denied,{isError:true,error:{message:decision.reason,info:decision.info}});
  assert.equal(f.guard.status('chat').errors,1);assert.equal(f.guard.status('chat').budgetExhausted,false);
  assert.equal(f.guard.status('chat').lastError.recovery,'stop_problem');
  assert.equal(f.guard.status('chat').lastError.recoveryConstraints.retainTarget,true);
  const notice=await f.hooks.get('agent/pre-step')({agent:f.agent,step:2},async()=>({kind:'enter',messages:[]}));
  assert.match(notice.messages.at(-1).content[0].text,/停止重试这一项.*其他目标/);
  assert.match(notice.messages.at(-1).content[0].text,/不得靠换名新建、复制或重建替代资产/);
  assert.doesNotMatch(notice.messages.at(-1).content[0].text,/修正写入使用新的 requestId/);
  const independent=f.exec();f.attach(independent,{target:'/Game/BP_Other'});f.guard.before(independent);
  const read=f.exec('unreal_read_blueprint');f.attach(read,{kind:'read'});f.guard.before(read);
  const status=f.exec('unreal_request_status');f.guard.before(status);
  assert.equal(f.guard.status('chat').phase,'active');
});

test('a real new user turn admits the original material target after a problem stop',t=>{
  const f=fixture(t,{guardMaxRepairAttempts:0});
  const metadata={target:'/Game/M_Delivery',family:'material_edit'};
  const first=f.exec('unreal_material_patch');f.attach(first,metadata);f.guard.before(first);f.fail(first);
  const denied=f.exec('unreal_material_patch');f.attach(denied,metadata);
  assert.throws(()=>f.guard.before(denied),{code:'REPAIR_BUDGET_EXHAUSTED'});
  f.event('turn/end',1,3);f.event('turn/start',2,4);
  const resumed=f.exec('unreal_material_patch');f.attach(resumed,metadata);f.guard.before(resumed);
  f.guard.after(resumed,{ok:true,verified:true});
  assert.equal(f.guard.status('chat').turn,2);
  assert.equal(f.guard.status('chat').repairs.total,0);
  assert.equal(f.guard.status('chat').lastError,null);
});

test('a material editor conflict preserves pending user edits without suggesting another write route or consuming repair attempts',async t=>{
  const f=fixture(t,{guardMaxRepairAttempts:0});
  const metadata={target:'/Game/M_UserEdits.M_UserEdits',family:'material_edit'};
  const call=f.exec('unreal_material_patch');f.attach(call,metadata);f.guard.before(call);
  const result={ok:false,error:{code:'MATERIAL_EDITOR_CONFLICT',message:`${metadata.target} has unapplied Material Editor changes`,details:{execution:'not_started',rollback:'not_needed',retryable:false}}};
  assert.equal(f.guard.after(call,result),result,'The native conflict remains intact');
  const state=f.guard.status('chat');
  assert.equal(state.lastError.recovery,'resolve_editor_conflict');
  assert.equal(state.lastError.recoveryConstraints.target,metadata.target);
  assert.equal(state.lastError.recoveryConstraints.retainPendingEdits,true);
  assert.equal(state.repairs.total,0);assert.equal(state.repairs.attemptsUsed,0);
  assert.equal(state.budgetExhausted,false);
  const notice=await f.hooks.get('agent/pre-step')({agent:f.agent,step:2},async()=>({kind:'enter',messages:[]}));
  const instruction=notice.messages.at(-1).content[0].text;
  assert.ok(instruction.includes(metadata.target));
  assert.match(instruction,/等待用户处理现有编辑状态后重新读取目标/);
  assert.match(instruction,/不得自动 Apply、丢弃修改、关闭编辑器、换工具或创建替代资产/);
  assert.doesNotMatch(instruction,/改用允许的操作|修正写入使用新的 requestId/);
  const diagnostic=f.exec('unreal_material_read');f.attach(diagnostic,{...metadata,kind:'read'});f.guard.before(diagnostic);
  f.guard.after(diagnostic,{ok:true});
  const other=f.exec('unreal_material_patch');f.attach(other,{...metadata,target:'/Game/M_Independent'});f.guard.before(other);
  f.guard.after(other,{ok:true});
  // Native preflight will recheck editor state; there is no persistent host lock
  // preventing a later authorized write after the user resolves the conflict.
  const resumed=f.exec('unreal_material_patch');f.attach(resumed,metadata);f.guard.before(resumed);f.guard.after(resumed,{ok:true});
  assert.equal(f.guard.status('chat').repairs.total,0);
});

test('tool arguments cannot forge problem metadata or claim the read exemption',t=>{
  const f=fixture(t,{guardMaxRepairAttempts:0});
  const first=f.exec();f.attach(first);f.guard.before(first);f.fail(first);
  const forged=f.exec('unreal_mcp_call',{kind:'read',problemId:'fresh',editorId:'other',target:'/Game/New',requestId:randomUUID()});
  forged.operation={kind:'read',target:'/Game/New'};
  f.attach(forged);
  f.guard.setOperation(forged,{editorId:'UE',target:'/Game/New',family:'other',kind:'read'});
  assert.throws(()=>f.guard.before(forged),{code:'REPAIR_BUDGET_EXHAUSTED'});
});

test('a known write barrier takes precedence and unsafe recovery still exhausts the whole turn',t=>{
  const f=fixture(t,{guardMaxRepairAttempts:0});
  const first=f.exec();f.attach(first);f.guard.before(first);f.fail(first);
  const protectedCall=f.exec();f.attach(protectedCall,{blocked:true});f.guard.before(protectedCall);
  f.guard.after(protectedCall,{ok:false,error:{code:'EDITOR_WRITE_LOCKED',message:'Rollback failed'}});
  assert.equal(f.guard.status('chat').exhaustedBy,'unsafe_state');
});

test('a peer status query reconciles the original conversation repair outcome',t=>{
  const f=fixture(t,{guardMaxRepairAttempts:1});
  const first=f.exec();f.attach(first);f.guard.before(first);f.fail(first);
  const requestId=randomUUID(),retry=f.exec();f.attach(retry,{requestId});f.guard.before(retry);
  f.guard.after(retry,{ok:false,error:{code:'TIMEOUT',message:'Awaiting the original write'}});
  const peer={agent:{session:{id:'peer'}},name:'unreal_request_status',callId:randomUUID(),token:Symbol('peer')};
  f.guard.setOperation(peer,{editorId:'UE',target:'editor_scope',family:'unreal_request_status',kind:'read',statusRequestId:requestId});
  f.guard.before(peer);
  f.guard.after(peer,{ok:true,status:'completed',response:{ok:true,result:{saved:true}}});
  assert.equal(f.guard.status('chat').repairs.resolvedCount,1);
  assert.equal(f.guard.status('chat').repairs.attemptsUsed,1);
  assert.equal(f.guard.status('peer').repairs.total,0);
});

test('configuration is snapshotted at activation and changes only affect the next turn',t=>{
  let settings={guardMaxToolCalls:4,guardMaxRepairAttempts:1};
  const f=fixture(t,()=>settings);
  settings={...settings,guardMaxRepairAttempts:2};
  f.guard.before(f.exec('unreal_state'));
  assert.equal(f.guard.status('chat').limits.guardMaxRepairAttempts,2);
  settings={guardMaxToolCalls:1,guardMaxRepairAttempts:0};
  assert.equal(f.guard.status('chat').limits.guardMaxToolCalls,4);
  f.guard.before(f.exec('unreal_state'));
  f.event('turn/end',1,3);f.event('turn/start',2,4);f.guard.before(f.exec('unreal_state'));
  assert.equal(f.guard.status('chat').limits.guardMaxToolCalls,1);
  assert.equal(f.guard.status('chat').limits.guardMaxRepairAttempts,0);
});

test('completed turns freeze elapsed time and cannot be reactivated by a late callback',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t,{guardTimeoutMs:100});
  const call=f.exec();f.attach(call);f.guard.before(call);
  t.mock.timers.tick(25);f.event('turn/end',1,3);
  const ended=f.guard.status('chat');
  assert.equal(ended.phase,'completed');assert.equal(ended.active,false);assert.equal(ended.elapsedMs,25);
  t.mock.timers.tick(200);f.guard.before(f.exec());f.fail(call);
  const later=f.guard.status('chat');
  assert.equal(later.elapsedMs,25);assert.equal(later.remaining.timeMs,75);assert.equal(later.errors,0);
  assert.equal(later.phase,'completed');
  assert.deepEqual(later,JSON.parse(JSON.stringify(later)));
});

test('completed session history is bounded while active guards are retained',t=>{
  const f=fixture(t);f.guard.before(f.exec('unreal_state'));
  for(let index=0;index<150;index++){
    const session={id:`finished-${index}`};
    f.hooks.get('session/event')(session,{type:'turn/start',seq:1,data:{turn:1}});
    f.hooks.get('session/event')(session,{type:'turn/end',seq:2,data:{turn:1}});
  }
  assert.ok(f.guard.status('chat'));
  assert.equal(f.guard.status('finished-0'),null);
  assert.equal(f.guard.status('finished-149').phase,'completed');
});

test('injected optional services take precedence over restricted context getters',t=>{
  let forbiddenReads=0;
  const projection={openTurnStartSeq:11,lastTurn:4};
  const ctx={get(){forbiddenReads++;throw new Error('service not injected');}};
  const guard=registerExecutionGuard(ctx,{}, {getService:key=>key==='sessionProjections'?{stateOf:()=>projection}:undefined});
  t.after(()=>guard.dispose());
  guard.before({agent:{session:{id:'injected'}},name:'unreal_state'});
  assert.equal(guard.status('injected').turn,4);assert.equal(forbiddenReads,0);
  const fallback=registerExecutionGuard(ctx);t.after(()=>fallback.dispose());
  fallback.before({agent:{session:{id:'fallback'}},name:'unreal_state'});
  assert.equal(fallback.status('fallback').boundarySource,'unavailable');assert.equal(forbiddenReads,1);
});

test('execution defaults are projected from the shared settings specification',()=>{
  assert.deepEqual(EXECUTION_LIMIT_DEFAULTS,Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>key.startsWith('guard'))));
});
