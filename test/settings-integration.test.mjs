import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {apply,Config} from '../src/index.mjs';
import {BridgeError} from '../src/protocol.mjs';
import {TYPERT} from '../src/remote.mjs';

async function fixture(t,extra={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-live-config-')),tools=new Map(),hooks=new Map(),services=new Map(),disposers=[];
  const config=Config({port:0,stateDir,requireApproval:false,...extra});
  const ctx={tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},
    provide:(key,value)=>services.set(key,value),get:()=>undefined,
    on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);},effect:fn=>disposers.push(fn())};
  await apply(ctx,config);
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose?.();await rm(stateDir,{recursive:true,force:true});});
  const remote=services.get('unrealBridge'),bridge=remote.bridge,session={id:'settings-chat'},agent={session,cancel(){throw Error('Unexpected cancel');}};
  hooks.get('session/event')(session,{type:'turn/start',seq:1,data:{turn:1}});
  const execute=(name,args={})=>tools.get(name).execute(args,{name,arguments:args,agent,callId:randomUUID(),signal:new AbortController().signal});
  const set=(key,value)=>{config[key][Symbol.for('cosmokit.volatile.write')](value);hooks.get('loader/volatile-update')?.();};
  return{config,remote,bridge,agent,session,hooks,execute,set};
}

test('live settings preserve bridge identity, pending leases and write locks; current budgets are frozen until next turn',async t=>{
  const f=await fixture(t),token=f.bridge.token,server=f.bridge.server;
  f.bridge.sessions.set(f.session.id,'editor');
  const lease=f.bridge.editorWrites.acquire({editorId:'editor',sessionId:f.session.id,requestId:randomUUID(),method:'save'});
  f.bridge.editorWrites.markUncertain(lease);
  f.bridge.writeLocks.set('editor',{code:'ROLLBACK_FAILED'});
  const before=await f.execute('unreal_state');
  f.set('guardMaxToolCalls',20);f.set('guardMaxRepairAttempts',1);f.set('requestTimeoutMs',7000);f.set('allowWrites',false);
  const state=f.remote.state(f.agent);
  assert.equal(f.bridge.token,token);assert.equal(f.bridge.server,server);
  assert.equal(f.bridge.editorWrites.get('editor'),lease);assert.equal(f.bridge.writeLocks.get('editor').code,'ROLLBACK_FAILED');
  assert.equal(f.bridge.config.requestTimeoutMs,7000);assert.equal(state.allowWrites,false);
  assert.equal(state.executionSafety.limits.guardMaxToolCalls,before.executionSafety.limits.guardMaxToolCalls);
  assert.equal(state.settings.nextTurnPending,true);
  const toolState=await f.execute('unreal_state');
  assert.deepEqual(toolState.settings,state.settings);
  assert.equal(toolState.executionSafety.repairs.total,state.executionSafety.repairs.total);
  f.hooks.get('session/event')(f.session,{type:'turn/end',seq:2,data:{turn:1}});
  assert.equal(f.remote.state(f.agent).executionSafety.phase,'completed');
  const remaining=f.remote.state(f.agent).executionSafety.remaining.timeMs;
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.remote.state(f.agent).executionSafety.remaining.timeMs,remaining);
  f.hooks.get('session/event')(f.session,{type:'turn/start',seq:3,data:{turn:2}});
  const next=await f.execute('unreal_state');
  assert.equal(next.executionSafety.limits.guardMaxToolCalls,20);
  assert.equal(next.executionSafety.limits.guardMaxRepairAttempts,1);
  assert.equal(next.settings.nextTurnPending,false);
  assert.equal(next.writeLock.code,'ROLLBACK_FAILED');
});

test('tool wrappers stop one exhausted issue while diagnostic reads and independent targets continue',async t=>{
  const f=await fixture(t,{guardMaxRepairAttempts:1,guardMaxRepeatedErrors:50});
  f.bridge.sessions.set(f.session.id,'editor');
  let writes=0;
  f.bridge.mcpCallToolset=async(_s,args)=>{
    if(args.toolName==='get_properties')return {value:1};
    writes++;throw new BridgeError('MCP_TOOL_ERROR',`Synthetic edit failure ${writes}`,{rollback:'not_available'});
  };
  const call=(toolName,path)=>({toolsetName:'editor_toolset.toolsets.object.ObjectTools',toolName,arguments:{instance:{refPath:path}},requestId:randomUUID()});
  assert.equal((await f.execute('unreal_mcp_call_toolset',call('set_properties','/Game/A.A'))).error.code,'MCP_TOOL_ERROR');
  assert.equal((await f.execute('unreal_mcp_call_toolset',call('set_properties','/Game/A.A'))).error.code,'MCP_TOOL_ERROR');
  const stopped=await f.execute('unreal_mcp_call_toolset',call('set_properties','/Game/A.A'));
  assert.equal(stopped.error.code,'REPAIR_BUDGET_EXHAUSTED');assert.equal(writes,2);
  assert.equal((await f.execute('unreal_mcp_call_toolset',call('get_properties','/Game/A.A'))).ok,true);
  assert.equal((await f.execute('unreal_mcp_call_toolset',call('set_properties','/Game/B.B'))).error.code,'MCP_TOOL_ERROR');
  const state=f.remote.state(f.agent);
  assert.equal(state.executionSafety.errors,3);
  assert.equal(state.executionSafety.repairs.blockedCount,1);
  assert.equal(state.executionSafety.halted,false);
});

test('knowledge queries and writes use live timeout snapshots, and cache endpoints are global and JSON-safe',async t=>{
  const f=await fixture(t);
  f.bridge.sessions.set(f.session.id,'editor');
  f.bridge.editors.set('editor',{editorId:'editor',capabilities:['project_knowledge'],selection:[]});
  const timeouts=[];
  f.bridge.request=async(_editor,_method,_params,options)=>{timeouts.push(options.timeoutMs);return {};};
  await f.bridge.knowledge(f.session.id,{tool:'project_status',arguments:{}});
  f.set('knowledgeTimeoutMs',9000);
  await f.bridge.knowledge(f.session.id,{tool:'project_status',arguments:{}});
  f.bridge.mutate=async(_s,_m,_p,_id,_sig,options)=>{timeouts.push(options.timeoutMs);return {};};
  await f.bridge.knowledgeRecord(f.session.id,{tool:'experience_feedback',arguments:{},requestId:randomUUID()});
  assert.deepEqual(timeouts,[120000,9000,9000]);
  const cache=await f.remote.cacheStatus();
  assert.deepEqual(JSON.parse(JSON.stringify(cache)),cache);
  assert.equal(cache.visual.bytes,0);
  for(const method of ['cacheStatus','cacheCleanup']){
    const descriptor=TYPERT.invocations.find(item=>item.method===method);
    assert.ok(descriptor);assert.equal(descriptor.scope,undefined);
    assert.equal(descriptor.parameters.some(item=>item.source==='lookup'),false);
  }
});

test('repeated malformed write calls share the same issue instead of escaping through new request IDs',async t=>{
  const f=await fixture(t,{guardMaxRepeatedErrors:2});
  f.bridge.sessions.set(f.session.id,'editor');
  let dispatched=0;f.bridge.mcpCallToolset=async()=>{dispatched++;return {};};
  const args={toolsetName:'editor_toolset.toolsets.object.ObjectTools',toolName:'set_properties',arguments:{instance:{refPath:'/Game/A.A'}},requestId:'not-a-uuid'};
  for(let i=0;i<2;i++)assert.equal((await f.execute('unreal_mcp_call_toolset',{...args,requestId:`invalid-${i}`})).error.code,'MCP_INVALID_ARGUMENTS');
  assert.equal((await f.execute('unreal_mcp_call_toolset',{...args,requestId:randomUUID()})).error.code,'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(dispatched,0);
  assert.equal((await f.execute('unreal_state')).executionSafety.errors,2);
});
