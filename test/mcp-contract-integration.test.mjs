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

const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
const refSchema={type:'object',properties:{refPath:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},required:['refPath']};
const describe=(toolset=DATA_TABLE,tool='get_schema',inputSchema=refSchema,extra={})=>({content:[{type:'text',text:JSON.stringify({tools:[{name:`${toolset}.${tool}`,inputSchema,...extra}]})}]});
const args=(path='/Game/Found',overrides={})=>({toolsetName:DATA_TABLE,toolName:`${DATA_TABLE}.get_schema`,arguments:{refPath:{path}},requestId:randomUUID(),...overrides});
const ok=result=>({ok:true,result});
const missing={isError:true,content:[{type:'text',text:'DataTable not found: /Game/Missing'}]};

async function fixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-contract-integration-'));
  const bridge=await new UnrealBridge({port:0,stateDir,...config}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return bridge;
}
async function editor(bridge,id,handler,capabilities=['mcp_tools','mcp_target_validation','mcp_operation_context']){
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}}),calls=[];
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId:id,project:id,projectPath:`/tmp/${id}`,engineVersion:'5.8',pid:42,capabilities}));await ack;
  socket.on('message',async raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;calls.push(message);
    const response=message.method==='mcp_operation_context'?ok({verified:true,toolName:message.params.name==='call_tool'?`${message.params.arguments.toolset_name}.${message.params.arguments.tool_name}`:message.params.name,blueprintOwners:[],token:randomUUID()}):await handler(message);
    if(response!==undefined)socket.send(JSON.stringify({type:'response',id:message.id,...response}));
  });
  return calls;
}
const dispatches=calls=>calls.filter(call=>call.method==='mcp_call_tool');

test('the tool wrapper preserves a real UE read error and accepts a corrected asset without cancelling',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-contract-wrapper-'));
  const tools=new Map(),services=new Map(),hooks=new Map(),disposers=[],cancellations=[];
  const controller=new AbortController();
  const ctx={tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},provide:(name,value)=>services.set(name,value),get:()=>undefined,
    on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);},effect(callback){disposers.push(callback());}};
  await apply(ctx,{port:0,stateDir,requireApproval:false});
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose?.();await rm(stateDir,{recursive:true,force:true});});
  const bridge=services.get('unrealBridge').bridge;
  const calls=await editor(bridge,'UE',message=>ok(message.method==='mcp_discover'?describe():message.params.arguments.arguments.refPath.path==='/Game/Missing'?missing:{schema:{rowStruct:'FObstacle'}}));
  bridge.bind('chat','UE');
  const agent={session:{id:'chat'},cancel(...args){cancellations.push(args);controller.abort();}};
  hooks.get('session/event')(agent.session,{type:'turn/start',seq:1,data:{turn:1}});
  const invoke=value=>tools.get('unreal_mcp_call_toolset').execute(value,{agent,name:'unreal_mcp_call_toolset',arguments:value,callId:randomUUID(),signal:controller.signal});
  const failure=await invoke(args('/Game/Missing'));
  assert.equal(failure.error.code,'MCP_READ_ERROR');assert.equal(failure.error.message,missing.content[0].text);
  assert.deepEqual(failure.error.details.ueResult,missing);assert.equal(bridge.state('chat').uncertain,null);
  assert.equal(controller.signal.aborted,false);assert.equal(cancellations.length,0);
  const corrected=await invoke(args());assert.equal(corrected.ok,true);assert.equal(corrected.schema.rowStruct,'FObstacle');
  assert.equal(dispatches(calls).length,2);
  assert.equal(dispatches(calls)[0].params.arguments.tool_name,'get_schema');
});

test('raw call_tool and toolset calls share normalization and exact argument preflight',async t=>{
  const bridge=await fixture(t);
  const calls=await editor(bridge,'UE',message=>ok(message.method==='mcp_discover'?describe():{read:true}));bridge.bind('chat','UE');
  const requestId=randomUUID();
  const raw=value=>bridge.mcpCall('chat',{name:'call_tool',requestId,arguments:{toolset_name:DATA_TABLE,tool_name:`${DATA_TABLE}.get_schema`,arguments:value}});
  await assert.rejects(raw({data_table:'/Game/Found'}),error=>error.code==='MCP_INVALID_ARGUMENTS'&&error.details.execution==='not_started');
  assert.equal(dispatches(calls).length,0);
  assert.deepEqual(await raw({refPath:{path:'/Game/Found'}}),{read:true});
  assert.equal(dispatches(calls).length,1);assert.equal(dispatches(calls)[0].params.arguments.tool_name,'get_schema');
  await assert.rejects(bridge.mcpCallToolset('chat',args('/Game/Found',{toolName:`${DATA_TABLE}.${DATA_TABLE}.get_schema`})),{code:'MCP_INVALID_TOOL_NAME'});
  assert.equal(dispatches(calls).length,1);
});

test('raw top-level call_tool with empty or omitted toolset validates inner required parameters before dispatch',async t=>{
  for(const toolset of [{toolset_name:''},{}]){
    const bridge=await fixture(t);
    const calls=await editor(bridge,'UE',message=>ok(message.method==='mcp_list_tools'?{tools:[{name:'inspect_asset',inputSchema:refSchema}]}:{inspected:true}));bridge.bind('chat','UE');
    const requestId=randomUUID();
    const raw=value=>bridge.mcpCall('chat',{name:'call_tool',requestId,arguments:{...toolset,tool_name:'inspect_asset',arguments:value}});
    await assert.rejects(raw({path:'/Game/Found'}),error=>error.code==='MCP_INVALID_ARGUMENTS'&&error.details.execution==='not_started');
    assert.equal(dispatches(calls).length,0);
    assert.deepEqual(await raw({refPath:{path:'/Game/Found'}}),{inspected:true});
    assert.equal(dispatches(calls).length,1);
    assert.deepEqual(dispatches(calls)[0].params,{name:'inspect_asset',arguments:{refPath:{path:'/Game/Found'}}});
  }
});

test('normalizing a qualified nested dispatcher cannot hide a prohibited DataTable write',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,'UE',()=>ok({unexpected:true}));bridge.bind('chat','UE');
  await assert.rejects(bridge.mcpCallToolset('chat',{
    toolsetName:'UnknownToolset',toolName:'UnknownToolset.call_tool',requestId:randomUUID(),
    arguments:{toolset_name:DATA_TABLE,tool_name:'set_rows',arguments:{}},
  }),error=>error.code==='MCP_POLICY_BLOCKED'&&error.details.reason==='lossy_json_roundtrip');
  assert.equal(calls.length,0);
});

test('each editor uses its current schema and a changed schema is not reused from another editor or earlier call',async t=>{
  const bridge=await fixture(t);let aRequiresCount=false;
  const schemaFor=required=>({type:'object',properties:{[required]:{type:'integer'}},required:[required]});
  const a=await editor(bridge,'A',message=>ok(message.method==='mcp_discover'?describe(DATA_TABLE,'get_schema',schemaFor(aRequiresCount?'count':'limit')):{editor:'A'}));
  const b=await editor(bridge,'B',message=>ok(message.method==='mcp_discover'?describe(DATA_TABLE,'get_schema',schemaFor('count')):{editor:'B'}));
  bridge.bind('chat','A');assert.deepEqual(await bridge.mcpCallToolset('chat',args(undefined,{arguments:{limit:1}})),{editor:'A'});
  bridge.bind('chat','B');
  await assert.rejects(bridge.mcpCallToolset('chat',args(undefined,{arguments:{limit:1}})),{code:'MCP_INVALID_ARGUMENTS'});
  assert.equal(dispatches(b).length,0);
  assert.deepEqual(await bridge.mcpCallToolset('chat',args(undefined,{arguments:{count:1}})),{editor:'B'});
  bridge.bind('chat','A');aRequiresCount=true;
  await assert.rejects(bridge.mcpCallToolset('chat',args(undefined,{arguments:{limit:1}})),{code:'MCP_INVALID_ARGUMENTS'});
  assert.equal(dispatches(a).length,1);
});

test('a binding change during schema discovery rejects the call before either editor executes it',async t=>{
  const bridge=await fixture(t);let entered,release;
  const discoveryStarted=new Promise(resolve=>entered=resolve),finishDiscovery=new Promise(resolve=>release=resolve);
  const a=await editor(bridge,'A',async message=>{if(message.method==='mcp_discover'){entered();await finishDiscovery;return ok(describe());}return ok({editor:'A'});});
  const b=await editor(bridge,'B',message=>ok(message.method==='mcp_discover'?describe():{editor:'B'}));
  bridge.bind('chat','A');const pending=bridge.mcpCallToolset('chat',args());await discoveryStarted;
  bridge.bind('chat','B');release();
  await assert.rejects(pending,error=>error.code==='INSTANCE_CHANGED'&&error.details.execution==='not_started');
  assert.equal(dispatches(a).length,0);assert.equal(dispatches(b).length,0);
  assert.deepEqual(await bridge.mcpCallToolset('chat',args()),{editor:'B'});
});

test('rebinding A to B and back to A during schema lookup still invalidates its preflight',async t=>{
  const bridge=await fixture(t);let entered,release;
  const started=new Promise(done=>entered=done),ready=new Promise(done=>release=done);
  const a=await editor(bridge,'A',async message=>{if(message.method==='mcp_discover'){entered();await ready;return ok(describe());}return ok({ran:true});});
  const b=await editor(bridge,'B',()=>ok({ran:true}));bridge.bind('chat','A');
  const pending=bridge.mcpCallToolset('chat',args());await started;
  bridge.bind('chat','B');bridge.bind('chat','A');release();
  await assert.rejects(pending,error=>error.code==='INSTANCE_CHANGED'&&error.details.execution==='not_started');
  assert.equal(dispatches(a).length,0);assert.equal(dispatches(b).length,0);
});

test('editors without native target validation can discover but cannot execute MCP calls',async t=>{
  const bridge=await fixture(t);
  const calls=await editor(bridge,'old',message=>ok(message.method==='mcp_discover'?describe():{ran:true}),['mcp_tools']);bridge.bind('chat','old');
  await assert.rejects(bridge.mcpCallToolset('chat',args()),error=>error.code==='MCP_TARGET_VALIDATION_UNAVAILABLE'&&error.details.execution==='not_started');
  assert.equal(dispatches(calls).length,0);assert.equal(bridge.state('chat').uncertain,null);
  assert.equal(bridge.state('chat').toolSafety.nativeTargetValidation,false);
});

test('native type rejection preserves its evidence and allows a corrected target with the same UUID',async t=>{
  const bridge=await fixture(t),requestId=randomUUID();let attempts=0;
  const evidence={execution:'not_started',retryable:true,argumentPath:'/data_table',expectedClass:'/Script/Engine.DataTable',actualClass:'/Script/Engine.World'};
  const calls=await editor(bridge,'new',message=>{
    if(message.method==='mcp_discover')return ok(describe());
    if(++attempts===1)return {ok:false,error:{code:'MCP_TARGET_TYPE_MISMATCH',message:'A World cannot be used as a DataTable',details:evidence}};
    return ok({found:true});
  });bridge.bind('chat','new');
  await assert.rejects(bridge.mcpCallToolset('chat',args('/Game/Map',{requestId})),error=>{
    assert.equal(error.code,'MCP_TARGET_TYPE_MISMATCH');assert.deepEqual(error.details,evidence);return true;
  });
  assert.equal(bridge.results.size,0);assert.equal(bridge.state('chat').uncertain,null);assert.equal(bridge.state('chat').writeLock,null);
  assert.deepEqual(await bridge.mcpCallToolset('chat',args('/Game/DT',{requestId})),{found:true});
  assert.equal(dispatches(calls).length,2);
  assert.deepEqual(await bridge.mcpCallToolset('chat',args('/Game/DT',{requestId})),{found:true});
  assert.equal(dispatches(calls).length,2,'successful executions remain idempotent');
});

test('unresolved nested dispatchers are rejected before target discovery or execution',async t=>{
  const bridge=await fixture(t);const calls=await editor(bridge,'UE',()=>ok({ran:true}));bridge.bind('chat','UE');
  await assert.rejects(bridge.mcpCallToolset('chat',{toolsetName:'UnknownToolset',toolName:'call_tool',arguments:{tool_name:'unknown'},requestId:randomUUID()}),error=>error.code==='MCP_TARGET_UNSUPPORTED'&&error.details.execution==='not_started');
  assert.equal(calls.length,0);
});

test('unknown get-prefixed tools remain potential writes despite readOnlyHint annotations',async t=>{
  const bridge=await fixture(t),toolset='editor_toolset.toolsets.object.ObjectTools';
  const calls=await editor(bridge,'UE',message=>ok(message.method==='mcp_discover'?describe(toolset,'get_and_mutate',{type:'object',properties:{}},{annotations:{readOnlyHint:true}}):missing));bridge.bind('chat','UE');
  await assert.rejects(bridge.mcpCallToolset('chat',{toolsetName:toolset,toolName:'get_and_mutate',arguments:{},requestId:randomUUID()}),error=>{
    assert.equal(error.code,'MCP_TOOL_ERROR');assert.equal(error.details.rollback,'not_available');assert.deepEqual(error.details.ueResult,missing);return true;
  });
  assert.equal(dispatches(calls).length,1);assert.equal(bridge.state('chat').uncertain,null);
});

test('explicit writing tool failures keep MCP_TOOL_ERROR and their UE cause',async t=>{
  const bridge=await fixture(t),toolset='editor_toolset.toolsets.object.ObjectTools';
  const failure={isError:true,content:[{type:'text',text:'Property type mismatch: EventHandles'}]};
  await editor(bridge,'UE',message=>ok(message.method==='mcp_discover'?describe(toolset,'set_properties',{type:'object',properties:{}}):failure));bridge.bind('chat','UE');
  await assert.rejects(bridge.mcpCallToolset('chat',{toolsetName:toolset,toolName:'set_properties',arguments:{},requestId:randomUUID()}),error=>error.code==='MCP_TOOL_ERROR'&&error.message===failure.content[0].text&&error.details.readOnly===false);
});

test('a known read timing out does not prevent a later corrected read or claim uncertain writes',async t=>{
  const bridge=await fixture(t,{requestTimeoutMs:40});let attempts=0;
  const calls=await editor(bridge,'UE',message=>message.method==='mcp_discover'?ok(describe()):++attempts===1?undefined:ok({found:true}));bridge.bind('chat','UE');
  await assert.rejects(bridge.mcpCallToolset('chat',args('/Game/Missing')),{code:'TIMEOUT'});
  assert.equal(bridge.state('chat').uncertain,null);
  assert.deepEqual(await bridge.mcpCallToolset('chat',args()),{found:true});assert.equal(dispatches(calls).length,2);
});
