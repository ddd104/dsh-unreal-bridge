import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {apply} from '../src/index.mjs';

async function fixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-write-safety-'));
  const bridge=await new UnrealBridge({port:0,stateDir,...config}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return bridge;
}
async function editor(bridge,handler,capabilities=['mcp_tools','mcp_target_validation','data_table_copy_property']){
  const calls=[];
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId:'editor',project:'fixture',projectPath:'/tmp/fixture',engineVersion:'5.8',pid:42,capabilities}));await ack;
  socket.on('message',raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;calls.push(message);
    const response=handler(message);
    if(response===undefined)return;
    socket.send(JSON.stringify({type:'response',id:message.id,...response}));
  });
  bridge.bind('chat','editor');return calls;
}
const copy=()=>({assetPath:'/Game/DT_Test',sourceRow:'Predestrian',propertyName:'ColorTypeMaterialParams',requestId:randomUUID()});
const copied={verified:true,targetCount:45,changedRows:45,unchangedRows:0,saved:false};

test('unsafe DataTable and desktop MCP routes are rejected before dispatch',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,message=>({ok:true,result:message.method==='mcp_discover'?{content:[{type:'text',text:JSON.stringify({tools:[{name:'DataTableTools.get_rows',inputSchema:{type:'object',properties:{}}}]})}]}:{}}));
  for(const [toolsetName,toolName] of [['DataTableTools','set_rows'],['DataTableTools','add_rows'],['DataTableTools','rename_rows'],['SlateInspectorToolset','Click'],['ProgrammaticToolset','execute_tool_script']]){
    await assert.rejects(bridge.mcpCallToolset('chat',{toolsetName,toolName,arguments:{},requestId:randomUUID()}),{code:'MCP_POLICY_BLOCKED'});
  }
  await assert.rejects(bridge.mcpCall('chat',{name:'editor_toolset.toolsets.data_table.DataTableTools.set_rows',arguments:{},requestId:randomUUID()}),{code:'MCP_POLICY_BLOCKED'});
  assert.equal(calls.length,0);
  assert.deepEqual(await bridge.mcpCallToolset('chat',{toolsetName:'DataTableTools',toolName:'get_rows',arguments:{},requestId:randomUUID()}),{});
  assert.equal(calls.filter(call=>call.method==='mcp_call_tool').length,1);
});

test('native copy dispatch is atomic, idempotent and does not request save or focus',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,()=>({ok:true,result:copied}));
  const args={...copy(),targetRows:['Cyclist','Car']};
  assert.deepEqual(await bridge.copyDataTableProperty('chat',args),copied);
  assert.deepEqual(await bridge.copyDataTableProperty('chat',args),copied);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'data_table_copy_property');
  const {requestId,...params}=args;assert.deepEqual(calls[0].params,params);assert.equal(calls[0].id,requestId);
});

test('old editors and read-only bridges cannot run native copy',async t=>{
  const old=await fixture(t);const oldCalls=await editor(old,()=>({ok:true,result:copied}),['mcp_tools']);
  await assert.rejects(old.copyDataTableProperty('chat',copy()),{code:'DATA_TABLE_COPY_UNAVAILABLE'});assert.equal(oldCalls.length,0);
  const readOnly=await fixture(t,{allowWrites:false});const calls=await editor(readOnly,()=>({ok:true,result:copied}));
  await assert.rejects(readOnly.copyDataTableProperty('chat',copy()),{code:'READ_ONLY'});assert.equal(calls.length,0);
});

test('a reported native rollback keeps error details and cannot rerun with the same request ID',async t=>{
  const bridge=await fixture(t);
  const calls=await editor(bridge,()=>({ok:false,error:{code:'DATA_TABLE_VERIFICATION_FAILED',message:'Unrelated field changed',details:{rollback:'restored',retryable:false}}}));
  const args=copy();
  for(let i=0;i<2;i++)await assert.rejects(bridge.copyDataTableProperty('chat',args),error=>error.code==='DATA_TABLE_VERIFICATION_FAILED'&&error.details.rollback==='restored');
  assert.equal(calls.length,1);assert.equal(bridge.state('chat').writeLock,null);
});

test('unverified results and failed rollbacks lock editor writes across chats and new request IDs',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,()=>({ok:true,result:{verified:false}}));
  await assert.rejects(bridge.copyDataTableProperty('chat',copy()),{code:'DATA_TABLE_ROLLBACK_FAILED'});
  assert.equal(bridge.state('chat').writeLock.rollback,'failed');
  bridge.bind('other-chat','editor');
  await assert.rejects(bridge.copyDataTableProperty('other-chat',copy()),{code:'EDITOR_WRITE_LOCKED'});
  await assert.rejects(bridge.mcpCallToolset('chat',{toolsetName:'AssetTools',toolName:'save',requestId:randomUUID()}),{code:'EDITOR_WRITE_LOCKED'});
  assert.equal(calls.length,1);
});

test('inner MCP failure is surfaced as unverified rather than reported as success',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,message=>({ok:true,result:message.method==='mcp_discover'?{content:[{type:'text',text:JSON.stringify({tools:[{name:'ObjectTools.set_properties',inputSchema:{type:'object',properties:{}}}]})}]}:{isError:true,content:[{type:'text',text:'Import failed'}]}}));
  const args={toolsetName:'ObjectTools',toolName:'set_properties',arguments:{},requestId:randomUUID()};
  for(let i=0;i<2;i++)await assert.rejects(bridge.mcpCallToolset('chat',args),error=>error.code==='MCP_TOOL_ERROR'&&error.details.rollback==='not_available'&&error.details.retryable===true&&error.details.recovery==='verify_before_retry'&&error.message==='Import failed'&&error.details.ueResult.content[0].text==='Import failed');
  assert.equal(calls.filter(call=>call.method==='mcp_call_tool').length,1);
});

test('an inner MCP rollback failure locks editor writes in every conversation',async t=>{
  const bridge=await fixture(t);
  const failure={ok:false,error:{code:'EDITOR_ERROR',message:'The original array could not be restored',details:{rollback:'failed'}}};
  const calls=await editor(bridge,message=>({ok:true,result:message.method==='mcp_discover'?{
    content:[{type:'text',text:JSON.stringify({tools:[{name:'ObjectTools.set_properties',inputSchema:{type:'object',properties:{}}}]})}],
  }:failure}));
  const args={toolsetName:'ObjectTools',toolName:'set_properties',arguments:{},requestId:randomUUID()};
  await assert.rejects(bridge.mcpCallToolset('chat',args),error=>{
    assert.equal(error.code,'MCP_TOOL_ERROR');
    assert.equal(error.details.rollback,'failed');
    assert.equal(error.details.retryable,false);
    assert.equal(error.details.recovery,'stop_writes');
    assert.deepEqual(error.details.ueResult,failure);
    return true;
  });
  assert.equal(bridge.state('chat').writeLock.rollback,'failed');
  assert.equal(bridge.state('chat').writeLock.requestId,args.requestId);
  const admittedCalls=calls.length;
  bridge.bind('other-chat','editor');
  assert.equal(bridge.state('other-chat').writeLock.rollback,'failed');
  await assert.rejects(bridge.copyDataTableProperty('other-chat',copy()),{code:'EDITOR_WRITE_LOCKED'});
  await assert.rejects(bridge.mcpCallToolset('chat',{...args,requestId:randomUUID()}),{code:'EDITOR_WRITE_LOCKED'});
  await assert.rejects(bridge.mcpCallToolset('other-chat',{...args,requestId:randomUUID()}),{code:'EDITOR_WRITE_LOCKED'});
  assert.equal(calls.length,admittedCalls,'locked writes must not reach the editor');
  assert.equal(calls.filter(call=>call.method==='mcp_call_tool').length,1);
});

test('a failed rollback recovered after timeout still locks writes and preserves the failure',async t=>{
  const bridge=await fixture(t,{requestTimeoutMs:20});
  const failure={ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED',message:'Schema changed',details:{rollback:'failed',retryable:false}}};
  const calls=await editor(bridge,message=>message.method==='request_status'?{ok:true,result:{status:'completed',response:failure}}:undefined);
  const args=copy();
  await assert.rejects(bridge.copyDataTableProperty('chat',args),{code:'TIMEOUT'});
  await assert.rejects(bridge.requestStatus('chat',args.requestId),error=>error.code==='DATA_TABLE_ROLLBACK_FAILED'&&error.details.rollback==='failed');
  assert.equal(bridge.state('chat').uncertain,null);assert.equal(bridge.state('chat').writeLock.rollback,'failed');
  bridge.bind('other-chat','editor');
  await assert.rejects(bridge.copyDataTableProperty('other-chat',copy()),{code:'EDITOR_WRITE_LOCKED'});
  await assert.rejects(bridge.copyDataTableProperty('chat',args),{code:'DATA_TABLE_ROLLBACK_FAILED'});
  assert.equal(calls.length,2);
});

test('plugin wrapper rejects a blocked route but permits its safe native alternative in the same turn',async t=>{
  const tools=new Map(),services=new Map(),cancellations=[];
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-write-guard-plugin-'));
  const ctx={tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},provide:(name,value)=>services.set(name,value),get:()=>undefined,effect:()=>{}};
  await apply(ctx,{port:0,stateDir,requireApproval:false});
  const bridge=services.get('unrealBridge').bridge;
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  const calls=await editor(bridge,()=>({ok:true,result:copied}));
  const exec={agent:{session:{id:'chat'},cancel:(...args)=>cancellations.push(args)},name:'unreal_mcp_call_toolset',callId:'first',signal:new AbortController().signal};
  const blocked=await tools.get(exec.name).execute({toolsetName:'DataTableTools',toolName:'set_rows',requestId:randomUUID()},exec);
  assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'MCP_POLICY_BLOCKED');assert.equal(cancellations.length,0);
  assert.equal(blocked.error.details.retryable,false);assert.equal(calls.length,0);
  const next=await tools.get('unreal_data_table_copy_property').execute(copy(),{...exec,name:'unreal_data_table_copy_property',callId:'second'});
  assert.equal(next.ok,true);assert.equal(next.verified,true);assert.equal(calls.length,1);
  assert.equal(calls[0].method,'data_table_copy_property');assert.equal(cancellations.length,0);
  const state=await tools.get('unreal_state').execute({},{...exec,name:'unreal_state',callId:'state'});
  assert.equal(state.executionSafety.errors,1);assert.equal(state.executionSafety.halted,false);
});
