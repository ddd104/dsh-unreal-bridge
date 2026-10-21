import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {apply} from '../src/index.mjs';

const BLUEPRINT='editor_toolset.toolsets.blueprint.BlueprintTools';
const OBJECT='editor_toolset.toolsets.object.ObjectTools';
const BP='/Game/BP_Repair.BP_Repair',OTHER='/Game/BP_Independent.BP_Independent';
const LEVEL='/Game/Maps/RepairMap.RepairMap:PersistentLevel.ExactLevelScript';
const CAPABILITIES=['mcp_tools','mcp_target_validation','mcp_operation_context'];
const ref=refPath=>({refPath});
const graph=owner=>`${owner}${owner.includes(':')?'.':':'}EventGraph`;
const node=(owner=BP,name='A')=>`${graph(owner)}.K2Node_${name}`;
const pin=(owner=BP,name='A',direction='EGPD_Input')=>({node:ref(node(owner,name)),direction,index_id:0});
const connect=(owner=BP)=>({output_pin:pin(owner,'A','EGPD_Output'),input_pin:pin(owner,'B')});
const create=(owner=BP)=>({graph:ref(graph(owner)),node_class:ref('/Script/BlueprintGraph.K2Node_CallFunction')});
const setPin=(owner=BP)=>({pin:pin(owner),value:'5'});
const setObject=(owner=BP,name='A')=>({instance:ref(node(owner,name)),values:'{"NodeComment":"repair"}'});
const ok=result=>({ok:true,result});
const deferred=()=>Promise.withResolvers();
const error=(code,message='Preflight rejected the target')=>({ok:false,error:{code,message,details:{execution:'not_started',retryable:true}}});
const connectionFailure=()=>ok({isError:true,content:[{type:'text',text:'Cannot connect these pin types'}]});
const patch=(assetPath=BP)=>({assetPath,graph:'EventGraph',baseRevision:'rev-1',operations:[{op:'set_pin_default',nodeId:'A',pin:'Value',value:'5'}]});

const catalog=new Map([
  [BLUEPRINT,['connect_pins','create_node','set_pin_value','list_graphs','get_node_infos']],
  [OBJECT,['set_properties','get_properties']],
]);
const schemas=toolset=>catalog.get(toolset).map(name=>({name:`${toolset}.${name}`,inputSchema:{type:'object',additionalProperties:true}}));
function leaf(call){
  if(call.name.toLowerCase()==='call_tool'){
    const args=call.arguments,toolset=args.toolset_name;
    if(toolset)return {toolName:args.tool_name.startsWith(`${toolset}.`)?args.tool_name:`${toolset}.${args.tool_name}`,arguments:args.arguments};
    return leaf({name:args.tool_name,arguments:args.arguments});
  }
  return {toolName:call.name,arguments:call.arguments};
}
function ownersFor(args){
  const serialized=JSON.stringify(args);
  return [BP,OTHER,LEVEL].filter(path=>serialized.includes(path)).map(path=>({path,classPath:path===LEVEL?'/Script/Engine.LevelScriptBlueprint':'/Script/Engine.Blueprint'}));
}
function invocation(toolset,toolName,args,style='toolset',requestId=randomUUID()){
  if(style==='fullName')return ['unreal_mcp_call_toolset',{toolsetName:toolset,toolName:`${toolset}.${toolName}`,arguments:args,requestId}];
  if(style==='top')return ['unreal_mcp_call',{name:`${toolset}.${toolName}`,arguments:args,requestId}];
  if(style==='wrapper')return ['unreal_mcp_call',{name:'call_tool',arguments:{toolset_name:toolset,tool_name:toolName,arguments:args},requestId}];
  if(style==='qualified-wrapper')return ['unreal_mcp_call',{name:'call_tool',arguments:{toolset_name:toolset,tool_name:`${toolset}.${toolName}`,arguments:args},requestId}];
  if(style==='top-wrapper')return ['unreal_mcp_call',{name:'call_tool',arguments:{tool_name:`${toolset}.${toolName}`,arguments:args},requestId}];
  if(style==='uppercase-wrapper')return ['unreal_mcp_call',{name:'CALL_TOOL',arguments:{toolset_name:toolset,tool_name:toolName,arguments:args},requestId}];
  if(style==='uppercase-top-wrapper')return ['unreal_mcp_call',{name:'CALL_TOOL',arguments:{tool_name:`${toolset}.${toolName}`,arguments:args},requestId}];
  return ['unreal_mcp_call_toolset',{toolsetName:toolset,toolName,arguments:args,requestId}];
}

async function toolFixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-blueprint-repair-'));
  const tools=new Map(),services=new Map(),disposers=[],hooks=new Map();
  const ctx={
    tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},
    provide:(name,value)=>services.set(name,value),get:()=>undefined,
    on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);},
    effect(callback){disposers.push(callback());},
  };
  t.after(async()=>{
    for(const dispose of disposers.reverse())await dispose?.();
    const target=await realpath(stateDir),root=await realpath(tmpdir()),child=relative(root,target);
    assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child),'Only remove this fixture beneath the resolved temporary directory');
    await rm(target,{recursive:true,force:true});
  });
  await apply(ctx,{port:0,stateDir,requireApproval:false,guardMaxRepairAttempts:0,...config});
  const bridge=services.get('unrealBridge').bridge;
  const agent={session:{id:'chat'},cancel(){}};
  hooks.get('session/event')(agent.session,{type:'turn/start',seq:1,data:{turn:1}});
  const execute=(name,args,options={})=>tools.get(name).execute(args,{agent,name,arguments:args,callId:randomUUID(),signal:options.signal??new AbortController().signal});
  return {bridge,execute,tools};
}

async function editor(bridge,{editorId='UE',capabilities=CAPABILITIES,onContext,onDispatch,onStatus}={}){
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}}),calls=[],contexts=[];
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId,project:editorId,projectPath:`/tmp/${editorId}`,engineVersion:'5.8',pid:123,capabilities}));await ack;
  socket.on('message',async raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;calls.push(message);
    let response;
    try{
      if(message.method==='mcp_discover')response=ok({content:[{type:'text',text:JSON.stringify({tools:schemas(message.params.arguments.toolset_name)})}]});
      else if(message.method==='mcp_list_tools')response=ok({tools:[...catalog.keys()].flatMap(schemas)});
      else if(message.method==='mcp_operation_context'){
        assert.deepEqual(Object.keys(message.params).sort(),['arguments','name']);
        const lease=bridge.state('chat').editorWrite;
        assert.ok(!lease||calls.some(call=>call.id===lease.requestId&&call.method==='mcp_call_tool'),'Ownership preflight must not reserve a new editor mutation');
        const {toolName,arguments:args}=leaf(message.params);
        const context={verified:true,toolName,blueprintOwners:ownersFor(args),token:randomUUID()};
        contexts.push(context);
        response=onContext?await onContext(message,context):ok(context);
      }else if(message.method==='request_status')response=onStatus?await onStatus(message):ok({status:'unknown'});
      else if(message.method==='preview_patch')response=ok({compiled:true,revision:'rev-1',saved:false});
      else response=onDispatch?await onDispatch(message):ok({changed:true});
    }catch(cause){response={ok:false,error:{code:'MOCK_ERROR',message:cause.message}};}
    if(response!==undefined&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'response',id:message.id,...response}));
  });
  return {socket,calls,contexts,dispatches:()=>calls.filter(call=>['mcp_call_tool','apply_patch','create_blueprint'].includes(call.method))};
}

const invoke=(f,...args)=>f.execute(...invocation(...args));
async function denied(f,call,owner=BP){
  const result=await f.execute(...call);
  assert.equal(result.error?.code,'REPAIR_BUDGET_EXHAUSTED',JSON.stringify({call,result}));
  assert.equal(result.error.details.problem.family,'blueprint_edit');
  assert.equal(result.error.details.problem.target,owner.toLowerCase());
  assert.equal(result.error.details.execution,'not_started');
  return result;
}

test('one failed connection blocks dependent Blueprint and ObjectTools edits plus native preview/apply before real dispatch',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge,{onDispatch:message=>leaf(message.params).toolName===`${BLUEPRINT}.connect_pins`?connectionFailure():ok({changed:true})});
  f.bridge.bind('chat','UE');
  const preview=await f.execute('unreal_preview_patch',patch());
  assert.equal(preview.ok,true);
  const failure=await invoke(f,BLUEPRINT,'connect_pins',connect());
  assert.equal(failure.error?.code,'MCP_TOOL_ERROR',JSON.stringify(failure));
  assert.equal(ue.contexts.length,1,'Resolve the pin owners before admitting the problem');
  assert.equal(ue.dispatches()[0].params.operationToken,ue.contexts[0].token);
  for(const call of [
    invocation(BLUEPRINT,'create_node',create()),
    invocation(BLUEPRINT,'set_pin_value',setPin()),
    invocation(OBJECT,'set_properties',setObject(BP,'A')),
    invocation(OBJECT,'set_properties',setObject(BP,'B')),
    ['unreal_preview_patch',patch()],
    ['unreal_apply',{previewId:preview.previewId,requestId:randomUUID()}],
  ])await denied(f,call);
  assert.equal(ue.dispatches().length,1,'Only the original failed connection can reach a mutable native dispatcher');
  assert.equal(ue.calls.filter(call=>call.method==='preview_patch').length,1,'An exhausted edit must not create another native preview');
  assert.equal(ue.contexts.length,5,'Read-only owner checks still precede per-problem admission for each MCP edit');
});

test('top-level, qualified and call_tool wrappers share one owner and permit another Blueprint to continue',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge,{onDispatch:message=>leaf(message.params).toolName.endsWith('.connect_pins')?connectionFailure():ok({changed:true})});
  f.bridge.bind('chat','UE');
  assert.equal((await invoke(f,BLUEPRINT,'connect_pins',connect(),'top-wrapper')).error?.code,'MCP_TOOL_ERROR');
  for(const style of ['toolset','fullName','top','wrapper','qualified-wrapper','top-wrapper','uppercase-wrapper','uppercase-top-wrapper']){
    await denied(f,invocation(BLUEPRINT,'create_node',create(),style));
    await denied(f,invocation(OBJECT,'set_properties',setObject(BP,'B'),style));
  }
  assert.equal(ue.dispatches().length,1);
  assert.equal((await invoke(f,BLUEPRINT,'create_node',create(OTHER),'top')).ok,true);
  assert.equal((await invoke(f,OBJECT,'set_properties',setObject(OTHER),'wrapper')).ok,true);
  assert.equal(ue.dispatches().length,3);
  for(const call of ue.dispatches())assert.ok(ue.contexts.some(context=>context.token===call.params.operationToken));
});

test('list_graphs, get_node_infos and Object get_properties remain diagnostic and cannot reset exhausted repair usage',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge,{onDispatch:message=>leaf(message.params).toolName.endsWith('.connect_pins')?connectionFailure():ok({diagnostic:true})});
  f.bridge.bind('chat','UE');
  await invoke(f,BLUEPRINT,'connect_pins',connect());
  const before=(await f.execute('unreal_state',{})).executionSafety.repairs;
  for(const call of [
    invocation(BLUEPRINT,'list_graphs',{blueprint:ref(BP)}),
    invocation(BLUEPRINT,'get_node_infos',{nodes:[ref(node()),ref(node(OTHER))]},'top'),
    invocation(OBJECT,'get_properties',{instance:ref(node()),properties:['NodeComment']},'wrapper'),
  ])assert.equal((await f.execute(...call)).ok,true);
  const after=(await f.execute('unreal_state',{})).executionSafety.repairs;
  assert.deepEqual(after,before,'Successful reads must not resolve the failed write or clear counters');
  await denied(f,invocation(BLUEPRINT,'set_pin_value',setPin()));
  assert.equal(ue.dispatches().length,4);
  assert.equal(f.bridge.state('chat').uncertain,null);
});

test('level Blueprint repair ownership preserves the full native subobject path instead of collapsing to World',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge,{onDispatch:message=>leaf(message.params).toolName.endsWith('.connect_pins')?connectionFailure():ok({changed:true})});
  f.bridge.bind('chat','UE');
  const failure=await invoke(f,BLUEPRINT,'connect_pins',connect(LEVEL));
  assert.equal(failure.error?.code,'MCP_TOOL_ERROR');
  const state=(await f.execute('unreal_state',{})).executionSafety;
  assert.equal(state.repairs.issues[0].target,LEVEL.toLowerCase());
  assert.notEqual(state.repairs.issues[0].target,'/game/maps/repairmap.repairmap');
  await denied(f,invocation(BLUEPRINT,'create_node',create(LEVEL)),LEVEL);
  await denied(f,invocation(OBJECT,'set_properties',setObject(LEVEL,'B')),LEVEL);
  assert.equal(ue.dispatches().length,1);
  assert.equal((await invoke(f,BLUEPRINT,'create_node',create(OTHER))).ok,true);
});

test('ownership errors and missing operation-context capability fail closed before mutation',async t=>{
  for(const variant of ['missing-capability','native-rejection']){
    const f=await toolFixture(t),ue=await editor(f.bridge,variant==='missing-capability'
      ?{capabilities:CAPABILITIES.filter(name=>name!=='mcp_operation_context')}
      :{onContext:()=>error('MCP_TARGET_REFERENCE_UNRESOLVED')});
    f.bridge.bind('chat','UE');
    const result=await invoke(f,OBJECT,'set_properties',setObject());
    assert.equal(result.ok,false,variant);
    assert.equal(typeof result.error?.code,'string');
    assert.equal(result.error.details?.execution,'not_started');
    assert.equal(ue.dispatches().length,0,variant);
    assert.equal(f.bridge.state('chat').uncertain,null);
    assert.equal(f.bridge.state('chat').editorWrite,null);
    if(variant==='missing-capability')assert.equal(ue.contexts.length,0);
    else assert.equal(result.error.code,'MCP_TARGET_REFERENCE_UNRESOLVED');
  }
});

test('malformed native ownership and token evidence cannot admit a write',async t=>{
  const corruptions=[
    ['unverified',context=>({...context,verified:false})],
    ['different leaf',context=>({...context,toolName:`${OBJECT}.get_properties`})],
    ['invalid token',context=>({...context,token:'not-a-uuid'})],
    ['missing token',context=>({...context,token:undefined})],
    ['missing owners',context=>({...context,blueprintOwners:null})],
    ['null owner row',context=>({...context,blueprintOwners:[null]})],
    ['missing class',context=>({...context,blueprintOwners:[{path:BP}]})],
    ['invalid owner path',context=>({...context,blueprintOwners:[{path:'/Game/../BP_Repair',classPath:'/Script/Engine.Blueprint'}]})],
    ['non-native class path',context=>({...context,blueprintOwners:[{path:BP,classPath:'/Game/FakeClass'}]})],
    ['non-string class path',context=>({...context,blueprintOwners:[{path:BP,classPath:42}]})],
  ];
  for(const [label,corrupt] of corruptions)await t.test(label,async sub=>{
    const f=await toolFixture(sub),ue=await editor(f.bridge,{onContext:(_message,context)=>ok(corrupt(context))});
    f.bridge.bind('chat','UE');
    const result=await invoke(f,OBJECT,'set_properties',setObject());
    assert.equal(result.ok,false,`Invalid native evidence ${label} must fail`);
    assert.notEqual(result.error?.code,'MOCK_ERROR');
    assert.equal(ue.dispatches().length,0,`Invalid native evidence ${label} reached mutation`);
    assert.equal(f.bridge.state('chat').editorWrite,null);
  });
});

test('verified native ownership supports Blueprint subclasses absent from any host class-name catalog',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge,{
    onContext:(_message,context)=>ok({...context,blueprintOwners:context.blueprintOwners.map(owner=>({...owner,classPath:'/Script/ProjectExtension.SpecializedBlueprint'}))}),
    onDispatch:message=>leaf(message.params).toolName.endsWith('.connect_pins')?connectionFailure():ok({changed:true}),
  });
  f.bridge.bind('chat','UE');
  assert.equal((await invoke(f,OBJECT,'set_properties',setObject())).ok,true);
  assert.equal((await invoke(f,BLUEPRINT,'connect_pins',connect())).error?.code,'MCP_TOOL_ERROR');
  await denied(f,invocation(OBJECT,'set_properties',setObject(BP,'B')));
  assert.equal(ue.dispatches().length,2);
});

test('an A-B-A binding change during ownership preflight rejects its stale token before dispatch',{timeout:10000},async t=>{
  const f=await toolFixture(t),entered=deferred(),finish=deferred();let first=true;
  const a=await editor(f.bridge,{editorId:'A',onContext:async(_message,context)=>{
    if(first){first=false;entered.resolve();await finish.promise;}return ok(context);
  }});
  const b=await editor(f.bridge,{editorId:'B'});
  f.bridge.bind('chat','A');
  const pending=invoke(f,OBJECT,'set_properties',setObject());
  await entered.promise;
  f.bridge.bind('chat','B');f.bridge.bind('chat','A');finish.resolve();
  const rejected=await pending;
  assert.equal(rejected.error?.code,'INSTANCE_CHANGED');
  assert.equal(a.dispatches().length,0);assert.equal(b.dispatches().length,0);
  const fresh=await invoke(f,OBJECT,'set_properties',setObject());
  assert.equal(fresh.ok,true);
  assert.equal(a.dispatches().length,1);
  assert.equal(a.dispatches()[0].params.operationToken,a.contexts.at(-1).token);
  assert.notEqual(a.contexts[0].token,a.contexts.at(-1).token);
});

test('preflight is read-only and audited Blueprint/Object diagnostics work while writes are disabled',async t=>{
  const f=await toolFixture(t,{allowWrites:false}),ue=await editor(f.bridge);
  f.bridge.bind('chat','UE');
  for(const call of [
    invocation(BLUEPRINT,'list_graphs',{blueprint:ref(BP)}),
    invocation(BLUEPRINT,'get_node_infos',{nodes:[ref(node())]}),
    invocation(OBJECT,'get_properties',{instance:ref(node()),properties:['NodeComment']}),
  ])assert.equal((await f.execute(...call)).ok,true);
  const rejected=await invoke(f,OBJECT,'set_properties',setObject());
  assert.equal(rejected.error?.code,'READ_ONLY');
  assert.equal(ue.dispatches().length,3,'Only the audited diagnostic leaves may dispatch');
  assert.equal(f.bridge.state('chat').editorWrite,null);
  assert.equal(f.bridge.state('chat').uncertain,null);
});

test('the forwarded native token is fresh after a pre-dispatch rejection and successful requests remain idempotent',async t=>{
  const f=await toolFixture(t,{guardMaxRepairAttempts:3}),ue=await editor(f.bridge,{onDispatch:message=>{
    if(ue.dispatches().length===1)return error('MCP_OPERATION_CONTEXT_INVALID','Token expired before dispatch');
    return ok({changed:true});
  }});
  f.bridge.bind('chat','UE');
  const call=invocation(OBJECT,'set_properties',setObject());
  assert.equal((await f.execute(...call)).error?.code,'MCP_OPERATION_CONTEXT_INVALID');
  assert.equal(f.bridge.state('chat').uncertain,null);
  assert.equal(f.bridge.results.size,0,'A rejected token must not cache a write outcome');
  const success=await f.execute(...call);
  assert.equal(success.ok,true);
  assert.equal(ue.dispatches().length,2);
  assert.notEqual(ue.contexts[0].token,ue.contexts[1].token);
  assert.equal(ue.dispatches()[1].params.operationToken,ue.contexts[1].token);
  assert.deepEqual(await f.execute(...call),success);
  assert.equal(ue.dispatches().length,2,'A completed request cannot reuse its token to execute again');
  assert.equal(ue.contexts.length,2,'A completed request does not need another native token');
});

test('cached failures never consume another repair attempt or redispatch owner preflight, including after exhaustion',async t=>{
  const f=await toolFixture(t,{guardMaxRepairAttempts:1,guardMaxRepeatedErrors:50});
  const ue=await editor(f.bridge,{onDispatch:()=>connectionFailure()});
  f.bridge.bind('chat','UE');
  const original=invocation(BLUEPRINT,'connect_pins',connect());
  assert.equal((await f.execute(...original)).error?.code,'MCP_TOOL_ERROR');
  const first=(await f.execute('unreal_state',{})).executionSafety.repairs;
  assert.equal(first.attemptsUsed,0);assert.equal(first.failures,1);
  for(let repeat=0;repeat<3;repeat++)assert.equal((await f.execute(...original)).error?.code,'MCP_TOOL_ERROR');
  assert.deepEqual((await f.execute('unreal_state',{})).executionSafety.repairs,first);
  assert.equal(ue.contexts.length,1);assert.equal(ue.dispatches().length,1);
  const correction=invocation(BLUEPRINT,'set_pin_value',setPin());
  assert.equal((await f.execute(...correction)).error?.code,'MCP_TOOL_ERROR');
  const exhausted=(await f.execute('unreal_state',{})).executionSafety.repairs;
  assert.equal(exhausted.attemptsUsed,1);assert.equal(exhausted.failures,2);assert.equal(exhausted.blockedCount,1);
  for(const cached of [original,correction])assert.equal((await f.execute(...cached)).error?.code,'MCP_TOOL_ERROR');
  assert.deepEqual((await f.execute('unreal_state',{})).executionSafety.repairs,exhausted);
  assert.equal(ue.contexts.length,2);assert.equal(ue.dispatches().length,2);
  await denied(f,invocation(OBJECT,'set_properties',setObject()));
  assert.equal(ue.dispatches().length,2);
});

test('an uncertain token-bearing write cannot be replayed or replaced; status recovery returns its original result',async t=>{
  const f=await toolFixture(t,{requestTimeoutMs:1000,guardMaxRepairAttempts:3});
  const ue=await editor(f.bridge,{
    onDispatch:message=>leaf(message.params).toolName.endsWith('.get_properties')?ok({value:'diagnostic'}):undefined,
    onStatus:()=>ok({status:'completed',response:ok({changed:true})}),
  });
  f.bridge.bind('chat','UE');
  const call=invocation(OBJECT,'set_properties',setObject()),requestId=call[1].requestId;
  const first=await f.execute(...call);
  assert.equal(first.error?.code,'TIMEOUT');
  assert.equal(f.bridge.state('chat').uncertain.requestId,requestId);
  assert.ok(['TIMEOUT','OUTCOME_UNKNOWN'].includes((await f.execute(...call)).error?.code));
  assert.equal((await invoke(f,BLUEPRINT,'create_node',create(OTHER))).error?.code,'OUTCOME_UNKNOWN');
  assert.equal(ue.dispatches().length,1);
  assert.equal(ue.contexts.length,1,'Unknown outcomes cannot mint a replacement authorization token');
  const diagnostics=await invoke(f,OBJECT,'get_properties',{instance:ref(node()),properties:['NodeComment']});
  assert.equal(diagnostics.ok,true,JSON.stringify(diagnostics));
  assert.equal(f.bridge.state('chat').uncertain.requestId,requestId);
  const recovered=await f.execute('unreal_request_status',{requestId});
  assert.equal(recovered.status,'completed');
  assert.equal(f.bridge.state('chat').uncertain,null);
  assert.equal((await f.execute(...call)).changed,true);
  assert.equal(ue.dispatches().filter(message=>leaf(message.params).toolName.endsWith('.set_properties')).length,1);
});
