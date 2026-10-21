import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {apply} from '../src/index.mjs';
import {BridgeError} from '../src/protocol.mjs';

async function fixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-tool-execution-'));
  const tools=new Map(),services=new Map(),hooks=new Map(),disposers=[],cancellations=[];
  const controller=new AbortController();
  const ctx={
    tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},
    provide:(name,value)=>services.set(name,value),get:()=>undefined,
    on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);},
    effect(callback){disposers.push(callback());},
  };
  await apply(ctx,{port:0,stateDir,requireApproval:false,...config});
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose?.();await rm(stateDir,{recursive:true,force:true});});
  const agent={session:{id:'chat'},cancel(...args){cancellations.push(args);controller.abort();}};
  hooks.get('session/event')(agent.session,{type:'turn/start',seq:1,data:{turn:1}});
  const execute=(name,args)=>tools.get(name).execute(args,{agent,name,arguments:args,callId:randomUUID(),signal:controller.signal});
  return {bridge:services.get('unrealBridge').bridge,execute,controller,cancellations};
}
const callArgs=()=>({toolsetName:'editor_toolset.toolsets.data_table.DataTableTools',toolName:'get_schema',arguments:{},requestId:randomUUID()});

test('invalid advertised MCP parameters return a corrective error without dispatch or cancellation',async t=>{
  const f=await fixture(t);let dispatched=0;
  f.bridge.mcpCallToolset=async()=>{dispatched++;return {found:true};};
  const invalid=await f.execute('unreal_mcp_call_toolset',{...callArgs(),requestId:'invalid-id'});
  assert.equal(invalid.error.code,'MCP_INVALID_ARGUMENTS');
  assert.equal(invalid.error.details.execution,'not_started');
  assert.equal(invalid.error.details.retryable,true);
  assert.deepEqual(invalid.error.details.issues[0].path,['requestId']);
  assert.equal(dispatched,0);assert.equal(f.controller.signal.aborted,false);
  const corrected=await f.execute('unreal_mcp_call_toolset',callArgs());
  assert.equal(corrected.ok,true);assert.equal(corrected.found,true);assert.equal(dispatched,1);
});

test('read failures preserve their UE error through the tool wrapper and allow a corrected call',async t=>{
  const f=await fixture(t);let attempts=0;
  const original='DataTable not found: /Game/Missing';
  f.bridge.mcpCallToolset=async()=>{
    if(++attempts===1)throw new BridgeError('MCP_READ_ERROR',original,{readOnly:true,rollback:'not_needed',retryable:true,content:[{type:'text',text:original}]});
    return {schema:{type:'object'}};
  };
  const failure=await f.execute('unreal_mcp_call_toolset',callArgs());
  assert.equal(failure.error.code,'MCP_READ_ERROR');assert.equal(failure.error.message,original);
  assert.equal(failure.error.details.content[0].text,original);
  assert.equal(f.controller.signal.aborted,false);assert.equal(f.cancellations.length,0);
  assert.equal((await f.execute('unreal_mcp_call_toolset',callArgs())).ok,true);
  const state=await f.execute('unreal_state',{});
  assert.equal(state.executionSafety.errors,1);
});

test('ObjectTools write failure reaches the model, then read-back and corrected append can succeed',async t=>{
  const f=await fixture(t),toolsetName='editor_toolset.toolsets.object.ObjectTools';
  const original='ArrayAdd: elements changed alongside the size change; insertion points are ambiguous.';
  const old=Array.from({length:25},(_,index)=>`/Game/Handlers/BP_Handler${index}.BP_Handler${index}_C`);
  const added=Array.from({length:7},(_,index)=>`/Game/Handlers/BP_Added${index}.BP_Added${index}_C`);
  let live=structuredClone(old);const calls=[];
  const instance={refPath:'/Game/BP_Manager.Default__BP_Manager_C'};
  const schemas=[
    {name:'set_properties',inputSchema:{type:'object',required:['instance','values'],properties:{instance:{type:'object'},values:{type:'string'}}}},
    {name:'get_properties',inputSchema:{type:'object',required:['instance','properties'],properties:{instance:{type:'object'},properties:{type:'array',items:{type:'string'}}}}},
  ];
  const socket=new WebSocket(f.bridge.descriptor.url,{headers:{Authorization:`Bearer ${f.bridge.token}`}});
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId:'editor',project:'fixture',projectPath:'/tmp/fixture',engineVersion:'5.8',pid:42,capabilities:['mcp_tools','mcp_target_validation','mcp_operation_context']}));
  await ack;f.bridge.bind('chat','editor');
  socket.on('message',raw=>{
    const request=JSON.parse(raw);if(request.type!=='request')return;
    let result;
    if(request.method==='mcp_discover')result={content:[{type:'text',text:JSON.stringify({tools:schemas})}]};
    else if(request.method==='mcp_operation_context')result={verified:true,toolName:`${toolsetName}.${request.params.arguments.tool_name}`,blueprintOwners:[{path:'/Game/BP_Manager.BP_Manager',classPath:'/Script/Engine.Blueprint'}],token:randomUUID()};
    else{
      const {tool_name,arguments:args}=request.params.arguments;
      calls.push({name:tool_name,args});
      if(tool_name==='get_properties')result={content:[{type:'text',text:JSON.stringify({AutoRegisteredEventHandlers:live})}]};
      else{
        const requested=JSON.parse(args.values).AutoRegisteredEventHandlers;
        if(JSON.stringify(requested.slice(0,old.length))!==JSON.stringify(old))result={isError:true,content:[{type:'text',text:original}]};
        else{live=structuredClone(requested);result={content:[{type:'text',text:'true'}]};}
      }
    }
    socket.send(JSON.stringify({type:'response',id:request.id,ok:true,result}));
  });
  const write=values=>({toolsetName,toolName:'set_properties',arguments:{instance,values:JSON.stringify({AutoRegisteredEventHandlers:values})},requestId:randomUUID()});
  const malformed=[{refPath:old[0]},...old.slice(1),...added];
  const failure=await f.execute('unreal_mcp_call_toolset',write(malformed));
  assert.equal(failure.ok,false);assert.equal(failure.error.code,'MCP_TOOL_ERROR');
  assert.equal(failure.error.message,original);
  assert.equal(failure.error.details.ueResult.content[0].text,original);
  assert.equal(failure.error.details.rollback,'not_available');
  assert.equal(failure.error.details.retryable,true);
  assert.equal(failure.error.details.recovery,'verify_before_retry');
  assert.equal(f.controller.signal.aborted,false);assert.equal(f.cancellations.length,0);
  const read=await f.execute('unreal_mcp_call_toolset',{toolsetName,toolName:'get_properties',arguments:{instance,properties:['AutoRegisteredEventHandlers']},requestId:randomUUID()});
  assert.equal(read.ok,true);
  const verified=JSON.parse(read.content[0].text).AutoRegisteredEventHandlers;
  assert.deepEqual(verified,old);
  const corrected=await f.execute('unreal_mcp_call_toolset',write([...verified,...added]));
  assert.equal(corrected.ok,true);assert.deepEqual(live,[...old,...added]);
  assert.deepEqual(calls.map(call=>call.name),['set_properties','get_properties','set_properties']);
  const state=await f.execute('unreal_state',{});
  assert.equal(state.executionSafety.errors,1);
  assert.equal(state.executionSafety.budgetExhausted,false);
  const {problem,...lastError}=state.executionSafety.lastError;
  assert.deepEqual(lastError,{code:'MCP_TOOL_ERROR',message:original,rollback:'not_available',recovery:'verify_before_retry'});
  assert.equal(problem.family,'blueprint_edit');
  assert.equal(problem.target,'/game/bp_manager.bp_manager');
  assert.equal(state.executionSafety.repairs.issues[0].status,'resolved');
  assert.equal(f.cancellations.length,0);
});
