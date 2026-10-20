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
  const assemble=async(names=['unreal_state','unreal_request_status','unreal_apply','read','run_code'])=>{
    const assembly={tools:names.map(name=>({name,description:name,parameters:{type:'object'}})),sections:[],contexts:[],variables:{}};
    return hooks.get('system-prompt/assemble')(assembly,{agent,scope:agent},async()=>assembly);
  };
  event('turn/start',{turn:1},1);
  return {ctx,hooks,session,agent,guard,event,exec,pre,post,step,assemble,cancellations};
}

test('the first Unreal call activates the guard and all later root tools share its budget',async t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  assert.deepEqual(await f.pre(f.exec('pwsh',{command:'Get-Content file.txt'})),{kind:'allow'});
  assert.equal(f.guard.status(f.session.id).active,false);
  assert.deepEqual(await f.pre(f.exec()),{kind:'allow'});
  assert.deepEqual(await f.pre(f.exec('read',{path:'a.txt'})),{kind:'allow'});
  const denied=await f.pre(f.exec('pwsh',{command:'Get-Content file.txt'}));
  assert.equal(denied.kind,'deny');assert.equal(denied.info.code,'EXECUTION_BUDGET_EXHAUSTED');
  assert.match(denied.reason,/总结已完成、未完成/);
  assert.equal((await f.pre(f.exec('read'))).kind,'deny');
  assert.equal(f.cancellations.length,0);
  assert.equal(f.guard.status(f.session.id).budgetExhausted,true);
});

test('changing request UUIDs, tool names and arguments cannot reset the budget',t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  f.guard.before(f.exec('unreal_mcp_call',{requestId:randomUUID(),name:'read_a'}));
  f.guard.before(f.exec('unreal_mcp_call_toolset',{requestId:randomUUID(),toolName:'read_b'}));
  assert.throws(()=>f.guard.before(f.exec('unreal_read_blueprint',{requestId:randomUUID()})),error=>error.code==='EXECUTION_BUDGET_EXHAUSTED'&&error.details.retryable===false);
  assert.equal(f.guard.status(f.session.id).calls,2);
});

test('default calls continue past the old limits and stop at 300 with a model-visible budget result',async t=>{
  const f=fixture(t);
  for(let count=1;count<=300;count++){
    assert.equal((await f.pre(f.exec('unreal_read_blueprint'))).kind,'allow');
    if([39,40,41,119,120,121].includes(count))assert.equal(f.guard.status(f.session.id).budgetExhausted,false);
    if(count===240){const state=f.guard.status(f.session.id);assert.equal(state.phase,'warning');assert.ok(state.warning);assert.equal(state.remaining.toolCalls,60);}
  }
  const denied=await f.pre(f.exec('unreal_apply'));
  assert.equal(denied.kind,'deny');assert.equal(denied.info.code,'EXECUTION_BUDGET_EXHAUSTED');
  const state=f.guard.status(f.session.id);
  assert.equal(state.toolCalls,300);assert.equal(state.remaining.toolCalls,0);assert.equal(state.phase,'summary');
  assert.deepEqual(state.limits,{guardMaxToolCalls:300,guardMaxSteps:200,guardMaxErrors:50,guardTimeoutMs:1800000});
  assert.equal(f.cancellations.length,0);
});

test('warning notices reach model pre-step even after ordinary read and search tools',async t=>{
  const f=fixture(t,{guardMaxToolCalls:10});
  for(let index=0;index<8;index++)await f.pre(f.exec(index?'read':'unreal_read_blueprint'));
  const entered=await f.step(2);
  assert.equal(entered.kind,'enter');assert.equal(entered.messages.at(-1).role,'user');
  assert.match(entered.messages.at(-1).content[0].text,/预算接近上限.*剩余工具调用 2 次/);
  assert.deepEqual(entered.messages,JSON.parse(JSON.stringify(entered.messages)));
});

test('soft exhaustion reserves exactly two recovery executions and one final tool-free summary',async t=>{
  const f=fixture(t,{guardMaxToolCalls:1});await f.pre(f.exec('unreal_read_blueprint'));
  assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
  assert.deepEqual((await f.assemble()).tools.map(tool=>tool.name),['unreal_state','unreal_request_status']);
  const recoveryStep=await f.step(2);assert.equal(recoveryStep.kind,'enter');
  assert.equal(f.guard.status(f.session.id).summaryOnly,false);
  const read=f.exec('unreal_state');assert.equal((await f.pre(read)).kind,'allow');
  f.guard.before(read);assert.equal(f.guard.status(f.session.id).recoveryCallsUsed,1);
  assert.equal((await f.pre(f.exec('unreal_request_status'))).kind,'allow');
  assert.equal(f.guard.status(f.session.id).remaining.recoveryCalls,0);
  const denied=await f.pre(f.exec('unreal_state'));assert.equal(denied.info.code,'EXECUTION_BUDGET_EXHAUSTED');
  f.guard.after(f.exec('unreal_apply'),{isError:true,error:{info:denied.info,message:denied.reason}});
  assert.equal(f.guard.status(f.session.id).errors,0,'budget denials must not consume the failure budget');
  assert.deepEqual((await f.assemble()).tools,[]);
  const summary=await f.step(3);assert.equal(summary.kind,'enter');assert.equal(f.guard.status(f.session.id).summaryOnly,true);
  assert.match(summary.messages.at(-1).content[0].text,/不得再调用工具/);
  assert.equal((await f.pre(f.exec('unreal_state'))).kind,'deny');
  assert.equal((await f.step(4)).kind,'reject');assert.equal((await f.step(5)).kind,'reject');
  assert.equal(f.cancellations.length,0);
});

test('every budget path emits user-role notices for the pre-step persistence contract',async t=>{
  for(const path of ['tool_calls','model_steps','errors']){
    const f=fixture(t,{guardMaxToolCalls:2,guardMaxSteps:path==='model_steps'?2:80,guardMaxErrors:1});
    const call=f.exec('unreal_read_blueprint');await f.pre(call);
    if(path==='errors')f.guard.after(call,{ok:false,error:{code:'MCP_INVALID_ARGUMENTS',details:{execution:'not_started'}}});
    if(path==='tool_calls'){await f.pre(f.exec('read'));await f.pre(f.exec('read'));}
    const decision=await f.step(path==='model_steps'?3:2);
    assert.equal(decision.kind,'enter',path);
    const message=decision.messages.at(-1);
    assert.equal(message.role,'user',path);assert.equal(message.source.form,'notice');
    assert.equal(message.source.kind,'unreal-execution-budget');
    assert.equal(f.guard.status(f.session.id).exhaustedBy,path);
    assert.deepEqual(message,JSON.parse(JSON.stringify(message)));
    if(path!=='model_steps'){
      const final=await f.step(3);
      assert.equal(final.messages.at(-1).role,'user',`${path} final sample`);
      assert.match(final.messages.at(-1).content[0].text,/不得再调用工具/);
    }
    assert.equal(f.cancellations.length,0,path);
  }
});

test('downstream pre-step rejection does not consume recovery or final summary samples',async t=>{
  const f=fixture(t,{guardMaxToolCalls:1});await f.pre(f.exec('unreal_read_blueprint'));
  await f.pre(f.exec('unreal_apply'));
  const hook=f.hooks.get('agent/pre-step'),payload=step=>({agent:f.agent,step});
  assert.deepEqual(await hook(payload(2),async()=>({kind:'reject'})),{kind:'reject'});
  assert.deepEqual((await f.assemble()).tools.map(tool=>tool.name),['unreal_state','unreal_request_status']);
  assert.equal((await f.step(2)).kind,'enter');
  assert.deepEqual((await f.assemble()).tools,[]);
  assert.deepEqual(await hook(payload(3),async()=>({kind:'reject'})),{kind:'reject'});
  assert.equal((await f.step(3)).kind,'enter');
  assert.equal((await f.step(4)).kind,'reject');
  assert.equal(f.cancellations.length,0);
});

test('notices preserve cancelled steps and downstream suppression of offered messages',async t=>{
  for(const phase of ['warning','summary']){
    const f=fixture(t,{guardMaxToolCalls:phase==='warning'?5:1});
    for(let i=0;i<(phase==='warning'?4:2);i++)await f.pre(f.exec('unreal_read_blueprint'));
    const hook=f.hooks.get('agent/pre-step');
    for(const reason of ['cancelled','suppressed','empty-first-step']){
      const controller=new AbortController();if(reason==='cancelled')controller.abort();
      const payload={agent:f.agent,step:reason==='empty-first-step'?1:2,signal:controller.signal,messages:reason==='suppressed'?[{role:'user',content:[]}]:[]};
      const cleared={kind:'enter',messages:[]};
      assert.equal(await hook(payload,async()=>cleared),cleared,`${phase}: ${reason}`);
    }
    // No cancelled or suppressed sample consumed the reserved recovery stage.
    const entered=await f.step(2);
    assert.equal(entered.messages.at(-1).role,'user');
    if(phase==='summary')assert.match(entered.messages.at(-1).content[0].text,/最多两次/);
  }
});

test('assembly removes tools before the one extra model-step summary sample',async t=>{
  const f=fixture(t,{guardMaxSteps:2});await f.step(1);await f.pre(f.exec('unreal_read_blueprint'));
  assert.equal((await f.step(2)).kind,'enter');
  assert.deepEqual((await f.assemble()).tools,[]);
  assert.equal(f.guard.status(f.session.id).summaryOnly,true);
  assert.equal((await f.step(3)).kind,'enter');
  assert.equal((await f.step(4)).kind,'reject');
});

test('reserve calls cannot be multiplied through shared SDK roots or a changed request UUID',async t=>{
  const f=fixture(t,{guardMaxToolCalls:1});const root=f.exec('unreal_read_blueprint');await f.pre(root);
  assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
  for(let index=0;index<2;index++)assert.equal((await f.pre(f.exec('unreal_state',{requestId:randomUUID()},{rootCallId:root.callId}))).kind,'allow');
  assert.equal((await f.pre(f.exec('unreal_request_status',{requestId:randomUUID()},{rootCallId:root.callId}))).kind,'deny');
  assert.equal((await f.pre(root)).kind,'deny','an old admitted root cannot reopen ordinary tools');
  assert.equal(f.cancellations.length,0);
});

test('warning and remaining counters are lossless JSON at the time threshold and after step exhaustion',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t,{guardTimeoutMs:100,guardMaxSteps:2});f.guard.before(f.exec('unreal_read_blueprint'));
  t.mock.timers.tick(80);let state=f.guard.status(f.session.id);
  assert.equal(state.phase,'warning');assert.equal(state.remaining.timeMs,20);
  await f.step(3);state=f.guard.status(f.session.id);
  assert.equal(state.remaining.steps,0);assert.equal(state.remaining.recoveryCalls,0);
  assert.deepEqual(state,JSON.parse(JSON.stringify(state)));
  const check=value=>{if(typeof value==='number'){assert.equal(Number.isSafeInteger(value),true);assert.equal(Object.is(value,-0),false);}else if(value&&typeof value==='object')Object.values(value).forEach(check);};check(state);
});

test('ordinary errors preserve a soft budget stop while its deadline can still cancel',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const f=fixture(t,{guardMaxToolCalls:1,guardTimeoutMs:50});const call=f.exec('unreal_read_blueprint');await f.pre(call);
  assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
  f.guard.after(call,{ok:false,error:{code:'MCP_TOOL_ERROR',message:'Write outcome unknown',details:{rollback:'not_available'}}});
  assert.equal(f.cancellations.length,0);assert.equal(f.guard.status(f.session.id).halted,false);
  assert.equal(f.guard.status(f.session.id).exhaustedBy,'tool_calls');
  assert.equal((await f.step(2)).kind,'enter');
  const timed=fixture(t,{guardMaxToolCalls:1,guardTimeoutMs:50});await timed.pre(timed.exec('unreal_read_blueprint'));
  await timed.pre(timed.exec('unreal_apply'));t.mock.timers.tick(50);
  assert.equal(timed.cancellations.length,1);assert.equal(timed.guard.status(timed.session.id).halted,true);
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
  assert.equal(f.cancellations.length,0);
  assert.equal(f.guard.status(f.session.id).exhaustedBy,'errors');
  assert.match(f.guard.status(f.session.id).reason,/累计 3 次工具错误/);
});

test('host-level thrown-tool results count as errors',async t=>{
  const f=fixture(t,{guardMaxErrors:1});const call=f.exec();await f.pre(call);
  await f.post(call,{isError:true,error:{message:'failure',info:{code:'ERROR'}},content:[]});
  assert.equal(f.guard.status(f.session.id).errors,1);
  assert.equal(f.cancellations.length,0);
  assert.equal(f.guard.status(f.session.id).budgetExhausted,true);
});

test('confirmed read and preflight MCP errors can be corrected within the shared error budget',async t=>{
  const codes=['MCP_READ_ERROR','MCP_INVALID_TOOL_NAME','MCP_TOOL_NOT_FOUND','MCP_INVALID_ARGUMENTS','MCP_SCHEMA_UNAVAILABLE','MCP_DESCRIPTION_UNPARSEABLE','MCP_TARGET_TYPE_MISMATCH','MCP_TARGET_VALIDATION_UNAVAILABLE'];
  const f=fixture(t,{guardMaxErrors:codes.length});
  for(const [index,code] of codes.entries()){
    const call=f.exec('unreal_mcp_call_toolset');await f.pre(call);
    const details=code==='MCP_READ_ERROR'?{readOnly:true,rollback:'not_needed',retryable:true}:{execution:'not_started',retryable:true};
    f.guard.after(call,{ok:false,error:{code,message:'Correct the requested read',details}});
    assert.equal(f.guard.status(f.session.id).errors,index+1);
    if(index<codes.length-1){
      assert.equal(f.guard.status(f.session.id).halted,false,code);
      assert.equal(f.cancellations.length,0,code);
      const corrected=f.exec('unreal_state');assert.equal((await f.pre(corrected)).kind,'allow');
      f.guard.after(corrected,{ok:true});
    }
  }
  assert.equal(f.guard.status(f.session.id).budgetExhausted,true);
  assert.equal(f.cancellations.length,0);
  assert.match(f.guard.status(f.session.id).reason,new RegExp(`累计 ${codes.length} 次工具错误`));
});

test('write, policy, unavailable capability and restored verification errors permit a corrected route',async t=>{
  for(const code of ['MCP_POLICY_BLOCKED','MCP_TOOL_ERROR','DATA_TABLE_COPY_UNAVAILABLE','DATA_TABLE_VERIFICATION_FAILED']){
    const f=fixture(t);const call=f.exec();f.guard.before(call);
    f.guard.after(call,{ok:false,error:{code,details:{rollback:'restored'}}});
    assert.equal(f.guard.status(f.session.id).halted,false,code);
    assert.equal(f.guard.status(f.session.id).budgetExhausted,false,code);
    assert.equal(f.guard.status(f.session.id).errors,1,code);
    assert.equal(f.cancellations.length,0,code);
    const corrected=f.exec('unreal_read_blueprint');
    assert.equal((await f.pre(corrected)).kind,'allow',code);
    f.guard.after(corrected,{ok:true});
    assert.equal(f.guard.status(f.session.id).errors,1,'success must not reset cumulative errors');
  }
});

test('the original write error remains intact and produces one model-visible correction notice',async t=>{
  const f=fixture(t);const call=f.exec('unreal_mcp_call_toolset');await f.pre(call);
  const message='ObjectTools.set_properties: insertion points are ambiguous\n'+('x'.repeat(600));
  const result={ok:false,error:{code:'MCP_TOOL_ERROR',message,details:{rollback:'not_available',recovery:'verify_before_retry'}}};
  assert.equal(f.guard.after(call,result),result);
  await f.post(call,{isError:false,value:result});
  assert.deepEqual(f.guard.status(f.session.id).lastError,{code:'MCP_TOOL_ERROR',message,rollback:'not_available',recovery:'verify_before_retry'});
  const first=await f.step(2),notice=first.messages.at(-1);
  assert.equal(first.kind,'enter');assert.equal(notice.role,'user');assert.equal(notice.source.form,'notice');
  assert.ok(notice.content[0].text.includes('insertion points are ambiguous'));
  assert.match(notice.content[0].text,/纠正|修正|更正/);
  assert.match(notice.content[0].text,/读回|回读|核实|验证/);
  const read=f.exec('unreal_read_blueprint');assert.equal((await f.pre(read)).kind,'allow');
  f.guard.after(read,{ok:true});
  assert.deepEqual((await f.step(3)).messages,[]);
  assert.deepEqual((await f.step(4)).messages,[]);
  const next=f.exec('unreal_mcp_call_toolset');await f.pre(next);
  f.guard.after(next,{ok:false,error:{code:'MCP_INVALID_ARGUMENTS',message:'second corrective error',details:{execution:'not_started'}}});
  assert.ok((await f.step(5)).messages.some(item=>item.content.some(part=>part.text?.includes('second corrective error'))));
  assert.equal(f.cancellations.length,0);
});

test('49 default failures still permit correction and the 50th starts bounded recovery',async t=>{
  const f=fixture(t);
  for(let count=1;count<=49;count++){
    const call=f.exec('unreal_mcp_call_toolset');await f.pre(call);f.guard.before(call);
    const failure={ok:false,error:{code:'MCP_TOOL_ERROR',message:`failure ${count}`,details:{rollback:'not_available',recovery:'verify_before_retry'}}};
    f.guard.after(call,failure);await f.post(call,{isError:false,value:failure});
    const state=f.guard.status(f.session.id);
    assert.equal(state.errors,count);assert.equal(state.budgetExhausted,false);
    if(count===40){
      assert.equal(state.phase,'warning');assert.equal(state.remaining.errors,10);
      const entered=await f.step(2);
      assert.ok(entered.messages.some(item=>item.content.some(part=>/错误|失败/.test(part.text)&&/10/.test(part.text))));
    }
  }
  const corrected=f.exec('unreal_mcp_call_toolset');assert.equal((await f.pre(corrected)).kind,'allow');
  f.guard.after(corrected,{ok:true,verified:true});
  assert.equal(f.guard.status(f.session.id).errors,49);
  const final=f.exec('unreal_mcp_call_toolset');await f.pre(final);
  f.guard.after(final,{ok:false,error:{code:'MCP_TOOL_ERROR',message:'failure 50'}});
  const state=f.guard.status(f.session.id);
  assert.equal(state.errors,50);assert.equal(state.remaining.errors,0);
  assert.equal(state.exhaustedBy,'errors');assert.equal(state.halted,false);
  assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
  assert.deepEqual((await f.assemble()).tools.map(tool=>tool.name),['unreal_state','unreal_request_status']);
  assert.equal((await f.step(3)).kind,'enter');
  assert.equal(f.cancellations.length,0);
});

test('failed rollback and write locks reserve status queries and a summary without cancellation',async t=>{
  for(const [code,details] of [
    ['UNEXPECTED_ERROR',{rollback:'failed'}],
    ['MCP_READ_ERROR',{readOnly:true,rollback:'failed'}],
    ['DATA_TABLE_ROLLBACK_FAILED',{}],
    ['EDITOR_WRITE_LOCKED',{}],
  ]){
    const f=fixture(t);const call=f.exec();await f.pre(call);
    f.guard.after(call,{ok:false,error:{code,message:'Unsafe editor state',details}});
    const state=f.guard.status(f.session.id);
    assert.equal(state.halted,false,code);assert.equal(state.exhaustedBy,'unsafe_state',code);
    assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
    assert.deepEqual((await f.assemble()).tools.map(tool=>tool.name),['unreal_state','unreal_request_status']);
    assert.equal((await f.step(2)).kind,'enter');
    assert.equal((await f.pre(f.exec('unreal_state'))).kind,'allow');
    assert.equal((await f.pre(f.exec('unreal_request_status'))).kind,'allow');
    assert.equal((await f.pre(f.exec('unreal_state'))).kind,'deny');
    assert.deepEqual((await f.assemble()).tools,[]);
    const summary=await f.step(3);assert.equal(summary.kind,'enter');
    assert.match(summary.messages.at(-1).content[0].text,/不得再调用工具/);
    assert.equal((await f.step(4)).kind,'reject');
    assert.equal(f.cancellations.length,0,code);
  }
});

test('unknown outcomes, timeout and disconnect require the original request status before retry',async t=>{
  for(const code of ['OUTCOME_UNKNOWN','TIMEOUT','DISCONNECTED','CANCELLED']){
    const f=fixture(t),call=f.exec('unreal_mcp_call_toolset');await f.pre(call);
    f.guard.after(call,{ok:false,error:{code,message:`Unresolved write: ${code}`,details:{rollback:'not_available',requestId:'original-request'}}});
    const state=f.guard.status(f.session.id);
    assert.equal(state.lastError.recovery,'check_request_status',code);
    assert.equal(state.budgetExhausted,false,code);assert.equal(state.halted,false,code);
    const entered=await f.step(2),instruction=entered.messages.at(-1).content[0].text;
    assert.match(instruction,/原 requestId.*unreal_request_status/);
    assert.match(instruction,/不要用新编号重复/);
    assert.equal((await f.pre(f.exec('unreal_request_status',{requestId:'original-request'}))).kind,'allow');
    assert.equal(f.cancellations.length,0,code);
  }
});

test('a late admitted parallel rollback failure upgrades exhausted errors and preserves the summary',async t=>{
  const f=fixture(t,{guardMaxErrors:1});
  const ordinary=f.exec('unreal_mcp_call_toolset'),parallel=f.exec('unreal_mcp_call_toolset');
  await f.pre(ordinary);await f.pre(parallel);
  f.guard.after(ordinary,{ok:false,error:{code:'MCP_INVALID_ARGUMENTS',message:'Correct parameters',details:{execution:'not_started'}}});
  assert.equal(f.guard.status(f.session.id).exhaustedBy,'errors');
  assert.equal((await f.step(2)).kind,'enter');
  assert.equal((await f.pre(f.exec('unreal_state'))).kind,'allow');
  f.guard.after(parallel,{ok:false,error:{code:'MCP_TOOL_ERROR',message:'Rollback could not restore the array',details:{rollback:'failed'}}});
  const state=f.guard.status(f.session.id);
  assert.equal(state.errors,2);assert.equal(state.exhaustedBy,'unsafe_state');
  assert.equal(state.lastError.recovery,'stop_writes');
  assert.match(state.reason,/回滚失败|写入锁定/);
  assert.equal(state.halted,false);assert.equal(state.recoveryCallsUsed,1);
  assert.equal((await f.pre(f.exec('unreal_apply'))).kind,'deny');
  assert.deepEqual((await f.assemble()).tools,[]);
  const summary=await f.step(3);
  assert.equal(summary.kind,'enter');
  assert.match(summary.messages.at(-1).content[0].text,/不得再调用工具/);
  assert.match(summary.messages.at(-1).content[0].text,/回滚失败|写入锁定/);
  assert.equal((await f.step(4)).kind,'reject');
  assert.equal(f.cancellations.length,0);
});

test('an actual new turn resets unsafe state while late old results cannot poison it',t=>{
  const f=fixture(t,{guardMaxErrors:1});const old=f.exec();f.guard.before(old);f.guard.after(old,{ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED'}});
  assert.equal(f.guard.status(f.session.id).exhaustedBy,'unsafe_state');
  f.event('turn/end',{turn:1},3);f.event('turn/start',{turn:2},4);
  assert.equal(f.guard.status(f.session.id).halted,false);
  f.guard.after(old,{ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED'}});
  assert.equal(f.guard.status(f.session.id).errors,0);
  f.guard.before(f.exec());assert.equal(f.guard.status(f.session.id).calls,1);
});

test('late post results from policy or unsafe-state precheck rejections cannot charge a new turn',async t=>{
  for(const rejectedBy of ['policy','unsafe_state']){
    const f=fixture(t);const initial=f.exec('unreal_read_blueprint');await f.pre(initial);
    if(rejectedBy==='unsafe_state')f.guard.after(initial,{ok:false,error:{code:'EDITOR_WRITE_LOCKED',message:'Old write failed'}});
    const rejected=f.exec(rejectedBy==='policy'?'pwsh':'unreal_apply',rejectedBy==='policy'?{command:'Get-Clipboard'}:{});
    const denial=await f.pre(rejected);
    assert.equal(denial.kind,'deny');
    assert.equal(denial.info.code,rejectedBy==='policy'?'MCP_POLICY_BLOCKED':'EXECUTION_BUDGET_EXHAUSTED');
    assert.equal(f.guard.status(f.session.id).halted,false);
    f.event('turn/end',{turn:1},3);f.event('turn/start',{turn:2},4);
    await f.pre(f.exec('unreal_read_blueprint'));
    await f.post(rejected,{isError:true,error:{message:'Late previous-turn rejection',info:denial.info},content:[]});
    const current=f.guard.status(f.session.id);
    assert.equal(current.turn,2);assert.equal(current.errors,0,rejectedBy);
    assert.equal(current.halted,false,rejectedBy);assert.equal(current.budgetExhausted,false,rejectedBy);
    assert.equal(current.calls,1,rejectedBy);
  }
});

test('model-step budget includes the activation step and ignores earlier steps',async t=>{
  const f=fixture(t,{guardMaxSteps:2});
  await f.step(17);await f.pre(f.exec());
  assert.equal((await f.step(18)).kind,'enter');
  const summary=await f.step(19);
  assert.equal(summary.kind,'enter');assert.match(summary.messages.at(-1).content[0].text,/不得再调用工具/);
  assert.equal(f.guard.status(f.session.id).summaryOnly,true);
  assert.equal((await f.pre(f.exec('unreal_state'))).info.code,'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal((await f.step(20)).kind,'reject');
  assert.equal(f.cancellations.length,0);
  assert.match(f.guard.status(f.session.id).reason,/模型步骤/);
});

test('parallel prechecks cannot all pass an exhausted shared budget',async t=>{
  const f=fixture(t,{guardMaxToolCalls:2});
  const results=await Promise.all(Array.from({length:8},()=>f.pre(f.exec('unreal_read_blueprint'))));
  assert.equal(results.filter(result=>result.kind==='allow').length,2);
  assert.equal(results.filter(result=>result.kind==='deny').length,6);
  assert.equal(f.cancellations.length,0);
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
  assert.throws(()=>f.guard.before(f.exec('unreal_read_blueprint',{requestId:randomUUID()})),{code:'EXECUTION_BUDGET_EXHAUSTED'});
  assert.equal(f.cancellations.length,0);
  assert.equal(f.guard.status(f.session.id).boundarySource,'unavailable');
});

test('no-hook wrapper fallback can follow official turn-boundary projections',t=>{
  const projection={openTurnStartSeq:1,lastTurn:1};
  const f=fixture(t,{guardMaxToolCalls:1},{noHooks:true,projection});
  f.guard.before(f.exec());assert.throws(()=>f.guard.before(f.exec('unreal_read_blueprint')),{code:'EXECUTION_BUDGET_EXHAUSTED'});
  projection.openTurnStartSeq=7;projection.lastTurn=2;
  f.guard.before(f.exec());
  assert.equal(f.guard.status(f.session.id).turn,2);
  assert.equal(f.guard.status(f.session.id).halted,false);
  assert.equal(f.guard.status(f.session.id).calls,1);
});

test('explicit real-input APIs reject only that call after Unreal activation and permit safe alternatives',async t=>{
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
    const denied=await f.pre(f.exec('pwsh',{command}));
    assert.equal(denied.kind,'deny',command);assert.equal(denied.info.code,'MCP_POLICY_BLOCKED');
    assert.equal(denied.info.details.execution,'not_started');assert.equal(denied.info.details.retryable,false);
    assert.match(denied.reason,/真实鼠标或剪贴板/);
    assert.equal((await f.pre(f.exec('unreal_read_blueprint'))).kind,'allow');
    assert.equal(f.cancellations.length,0);
  }
});

test('ordinary source reads and searches mentioning API names remain allowed',async t=>{
  const f=fixture(t);await f.pre(f.exec());
  for(const command of ['Get-Content src/clipboard.mjs',"rg -n 'user32|SendInput|Get-Clipboard' src",'grep SetCursorPos source.cpp | head -20']){
    assert.equal((await f.pre(f.exec('pwsh',{command}))).kind,'allow',command);
  }
  assert.equal((await f.pre(f.exec('read',{path:'user32.dll.txt'}))).kind,'allow');
  assert.equal((await f.pre(f.exec('pwsh',{command:'Get-Content text.txt | Set-Clipboard'}))).kind,'deny');
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
