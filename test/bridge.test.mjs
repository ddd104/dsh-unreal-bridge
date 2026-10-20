import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {patchSchema,selectionSchema} from '../src/protocol.mjs';
import {apply} from '../src/index.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,config={}){const stateDir=await mkdtemp(join(tmpdir(),'dsh-bridge-'));const b=await new UnrealBridge({port:0,stateDir,heartbeatMs:1000,...config}).start();t.after(async()=>{await b.close();await rm(stateDir,{recursive:true,force:true});});return b;}
async function editor(b,editorId='UE1',handler=msg=>({echo:msg.method}),capabilities=['read_blueprint','apply_patch']){
  const ws=new WebSocket(b.descriptor.url,{headers:{Authorization:`Bearer ${b.token}`}});await once(ws,'open');const ack=once(ws,'message');ws.send(JSON.stringify({type:'hello',protocol:1,editorId,project:editorId,projectPath:`/tmp/${editorId}`,engineVersion:'5.8',pid:123,capabilities}));await ack;
  ws.on('message',async raw=>{const m=JSON.parse(raw);if(m.type!=='request')return;const result=await handler(m);if(result!==undefined)ws.send(JSON.stringify({type:'response',id:m.id,ok:true,result}));});return ws;
}
const patch=()=>({assetPath:'/Game/Test/BP_Test',graph:'EventGraph',baseRevision:'v1',operations:[{op:'add_node',nodeId:'temp1',kind:'call_function',functionPath:'/Script/Engine.KismetSystemLibrary:PrintString'}]});

test('authentication rejects missing token and browser origins',async t=>{const b=await fixture(t);for(const headers of [{},{Origin:'http://127.0.0.1'},{Authorization:`Bearer ${b.token}`,Origin:'https://evil.test'}]){const ws=new WebSocket(b.descriptor.url,{headers});const [e]=await once(ws,'error');assert.match(e.message,/401/);}assert.equal(b.list().length,0);});
test('authenticated native UE loopback origin is accepted',async t=>{const b=await fixture(t);const ws=new WebSocket(b.descriptor.url,{headers:{Authorization:`Bearer ${b.token}`,Origin:'http://127.0.0.1'}});await once(ws,'open');ws.close();});
test('two conversations keep independent instance and selection state',async t=>{const b=await fixture(t);const a=await editor(b,'A'),c=await editor(b,'B');b.bind('one','A');b.bind('two','B');a.send(JSON.stringify({type:'event',sequence:1,event:'selection_changed',data:{assets:[{path:'/Game/A.A',class:'Blueprint'}]}}));await pause(20);assert.equal(b.state('one').selection[0].path,'/Game/A.A');assert.deepEqual(b.state('two').selection,[]);assert.equal((await b.read('two',{assetPath:'/Game/B'})).echo,'read_blueprint');const closed=once(b.editors.get('B').ws,'close');c.close();await closed;assert.equal(b.state('two').editorId,'B');assert.equal(b.state('two').connected,false);});
test('out-of-order events cannot restore stale selections',async t=>{const b=await fixture(t);const ws=await editor(b);b.bind('s','UE1');for(const sequence of [2,1])ws.send(JSON.stringify({type:'event',sequence,event:'selection_changed',data:{assets:[{path:`/Game/N${sequence}`,class:'Blueprint'}]}}));await pause(20);assert.equal(b.state('s').selection[0].path,'/Game/N2');});

test('level selection preserves instance and Blueprint paths, replaces assets and clears independently per editor',async t=>{
  const b=await fixture(t);const ws=await editor(b,'A');await editor(b,'B');b.bind('s','A');b.bind('other','B');
  let sequence=0;
  const send=async assets=>{const changed=once(b,'change');ws.send(JSON.stringify({type:'event',sequence:++sequence,event:'selection_changed',data:{assets}}));await changed;};
  await send([{path:'/Game/BP_Car.BP_Car',class:'Blueprint'}]);
  const actor={kind:'actor',path:'/Game/Maps/City.City:PersistentLevel.BP_Car_C_1',class:'/Game/BP_Car.BP_Car_C',name:'BP_Car_C_1',label:'测试车辆',worldPath:'/Game/Maps/City.City',blueprintPath:'/Game/BP_Car.BP_Car'};
  await send([actor]);assert.deepEqual(b.state('s').selection,[actor]);
  const component={kind:'component',path:actor.path+'.Mesh',class:'/Script/Engine.StaticMeshComponent',name:'Mesh',label:'Mesh',worldPath:actor.worldPath,ownerPath:actor.path,ownerLabel:actor.label,ownerBlueprintPath:actor.blueprintPath};
  await send([component]);assert.deepEqual(b.state('s').selection,[component]);assert.deepEqual(b.state('other').selection,[]);
  // A delayed actor event cannot overwrite a newer component selection.
  ws.send(JSON.stringify({type:'event',sequence:sequence-1,event:'selection_changed',data:{assets:[actor]}}));
  await send([]);assert.deepEqual(b.state('s').selection,[]);
  await send([{path:'/Game/Another.Another',class:'Material'}]);assert.equal(b.state('s').selection[0].class,'Material');
});
test('patch schema rejects unknown ops, path escape and unknown fields',()=>{for(const p of [{...patch(),assetPath:'/Game/../Engine/X'},{...patch(),operations:[{op:'execute_shell',command:'x'}]},{...patch(),save:true}])assert.equal(patchSchema.safeParse(p).success,false);});

test('Blueprint component selection retains template context without scene instance fields',async t=>{
  const b=await fixture(t);const ws=await editor(b);b.bind('s','UE1');
  const component={kind:'component',source:'blueprint_editor',path:'/Game/BP_Car.BP_Car_C:Sensor_GEN_VARIABLE',class:'/Script/Engine.SceneComponent',name:'Sensor_GEN_VARIABLE',label:'Sensor',componentVariableName:'Sensor',ownerLabel:'BP_Car',ownerBlueprintPath:'/Game/BP_Car.BP_Car',isInherited:false};
  const changed=once(b,'change');ws.send(JSON.stringify({type:'event',sequence:1,event:'selection_changed',data:{assets:[component]}}));await changed;
  assert.deepEqual(b.state('s').selection,[component]);
  assert.equal(selectionSchema.safeParse({assets:[{...component,worldPath:'/Temp/Preview'}]}).success,false);
  assert.equal(selectionSchema.safeParse({assets:[{...component,source:undefined}]}).success,false);
  assert.equal(selectionSchema.safeParse({assets:[{...component,ownerBlueprintPath:undefined}]}).success,false);
});
test('patch schema accepts a named custom event and rejects invalid names',()=>{
  const add={op:'add_custom_event',nodeId:'timerEvent',eventName:'PrintTime'};
  assert.equal(patchSchema.safeParse({...patch(),operations:[add]}).success,true);
  for(const eventName of ['2PrintTime','Print Time','Print-Time'])assert.equal(patchSchema.safeParse({...patch(),operations:[{...add,eventName}]}).success,false);
});
test('preview ownership prevents cross-session and cross-editor execution',async t=>{const b=await fixture(t);await editor(b,'A',()=>({valid:true}));await editor(b,'B');b.bind('one','A');b.bind('two','A');const p=await b.preview('one','patch',patch());assert.throws(()=>b.previewRecord('two',p.previewId),{code:'PREVIEW_EXPIRED'});b.bind('one','B');assert.throws(()=>b.previewRecord('one',p.previewId),{code:'INSTANCE_CHANGED'});});
test('manual changes invalidate previews without triggering model calls',async t=>{const b=await fixture(t);const ws=await editor(b,'UE1',()=>({valid:true}));b.bind('s','UE1');const p=await b.preview('s','patch',patch());ws.send(JSON.stringify({type:'event',sequence:1,event:'blueprint_changed',data:{assetPath:'/Game/Test/BP_Test',revision:'v2'}}));await pause(20);assert.throws(()=>b.previewRecord('s',p.previewId),{code:'PREVIEW_EXPIRED'});});
test('duplicate writes reuse result; changed parameters cannot reuse request ID',async t=>{const b=await fixture(t);let writes=0;await editor(b,'UE1',m=>m.method==='apply_patch'?{revision:`v${++writes+1}`}:{valid:true});b.bind('s','UE1');const p=await b.preview('s','patch',patch()),requestId=randomUUID();const first=await b.apply('s',p.previewId,requestId);assert.deepEqual(await b.apply('s',p.previewId,requestId),first);assert.equal(writes,1);await assert.rejects(b.mutate('s','save',{assetPath:'/Game/Other'},requestId),{code:'IDEMPOTENCY_MISMATCH'});const log=await readFile(join(b.config.stateDir,'audit.jsonl'),'utf8');assert.equal(log.includes(b.token),false);assert.match(log,/completed/);});
test('timeout blocks new writes until request status resolves uncertainty',async t=>{const b=await fixture(t,{requestTimeoutMs:35});await editor(b,'UE1',m=>m.method==='apply_patch'?undefined:m.method==='request_status'?{status:'completed',response:{ok:true,result:{revision:'v2'}}}:{valid:true});b.bind('s','UE1');const p=await b.preview('s','patch',patch()),requestId=randomUUID();await assert.rejects(b.apply('s',p.previewId,requestId),{code:'TIMEOUT'});await assert.rejects(b.apply('s',p.previewId,randomUUID()),{code:'OUTCOME_UNKNOWN'});await b.requestStatus('s',requestId);assert.equal(b.state('s').uncertain,null);assert.deepEqual(await b.apply('s',p.previewId,requestId),{revision:'v2'});});
test('read-only configuration rejects writes',async t=>{const b=await fixture(t,{allowWrites:false});await editor(b);b.bind('s','UE1');await assert.rejects(b.mutate('s','save',{assetPath:'/Game/X'},randomUUID()),{code:'READ_ONLY'});});
test('session cannot switch editor while a write is pending',async t=>{const b=await fixture(t);await editor(b,'A',async()=>{await pause(30);return{revision:'v2'};});await editor(b,'B');b.bind('s','A');const pending=b.mutate('s','save',{assetPath:'/Game/X'},randomUUID());assert.throws(()=>b.bind('s','B'),{code:'BUSY'});await pending;});
test('DSH tools require a session and actual approval before writing',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-tools-'));const tools=new Map();const services=new Map();let approve=false;
  const ctx={tools:{register:d=>tools.set(d.name,d)},systemPrompt:{section(){}},typert:{register(){}},provide:(k,v)=>services.set(k,v),effect:f=>f(),get:k=>k==='approval'?{request:async()=>approve?'allowed-once':'rejected'}:undefined};
  await apply(ctx,{stateDir,port:0});const b=services.get('unrealBridge').bridge;t.after(async()=>{await b.close();await rm(stateDir,{recursive:true,force:true});});let writes=0;await editor(b,'UE1',m=>{if(m.method==='apply_patch')writes++;return{valid:true,revision:'v2'};});b.bind('s','UE1');
  const exec={agent:{session:{id:'s'}},name:'unreal_apply',callId:'call',signal:new AbortController().signal};const p=await b.preview('s','patch',patch());const args={previewId:p.previewId,requestId:randomUUID()};
  assert.equal((await tools.get('unreal_state').execute({},{})).error.code,'SESSION_REQUIRED');
  assert.equal((await tools.get('unreal_apply').execute(args,exec)).error.code,'PERMISSION_DENIED');assert.equal(writes,0);approve=true;assert.equal((await tools.get('unreal_apply').execute(args,exec)).ok,true);assert.equal(writes,1);
  assert.equal(services.get('unrealBridge').typertRemote.service,services.get('unrealBridge'));assert.equal(tools.size,24);
});

test('bridge writes use the configured approval policy',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-no-approval-'));const tools=new Map();const services=new Map();let approvalRequests=0;let writes=0;
  const ctx={tools:{register:d=>tools.set(d.name,d)},systemPrompt:{section(){}},typert:{register(){}},provide:(k,v)=>services.set(k,v),effect:f=>f(),get:k=>k==='approval'?{request:async()=>{approvalRequests++;return 'rejected';}}:undefined};
  await apply(ctx,{stateDir,port:0,requireApproval:false});const b=services.get('unrealBridge').bridge;t.after(async()=>{await b.close();await rm(stateDir,{recursive:true,force:true});});
  await editor(b,'UE1',m=>{if(m.method==='apply_patch')writes++;return{valid:true,revision:'v2'};});b.bind('s','UE1');
  assert.equal(b.state('s').requireApproval,false);
  const exec={agent:{session:{id:'s'}},name:'unreal_apply',callId:'call',signal:new AbortController().signal};const p=await b.preview('s','patch',patch());
  assert.equal((await tools.get('unreal_apply').execute({previewId:p.previewId,requestId:randomUUID()},exec)).ok,true);
  assert.equal(writes,1);assert.equal(approvalRequests,0);
});

test('asset focus stays in the bound editor and rejects older plugins',async t=>{
  const b=await fixture(t);const calls=[];
  await editor(b,'A',m=>{calls.push({editor:'A',method:m.method,params:m.params});return{queued:true};},['focus_asset','safe_asset_presentation']);
  await editor(b,'B',m=>{calls.push({editor:'B',method:m.method});return{queued:true};});
  b.bind('chat','A');
  assert.deepEqual(await b.focus('chat',{assetPath:'/Game/BP_Test',graph:'EventGraph',nodeIds:['node-1']}),{queued:true});
  assert.deepEqual(calls,[{editor:'A',method:'focus_asset',params:{assetPath:'/Game/BP_Test',graph:'EventGraph',nodeIds:['node-1']}}]);
  const level='/Game/Maps/Map_Test.Map_Test:PersistentLevel.Map_Test';
  assert.deepEqual(await b.focus('chat',{assetPath:level}),{queued:true});
  assert.equal(calls.at(-1).params.assetPath,level,'focus preserves the exact level Blueprint reference');
  await editor(b,'old',()=>({queued:true}),['focus_asset']);b.bind('chat','old');
  await assert.rejects(b.focus('chat',{assetPath:'/Game/BP_Test'}),{code:'FOCUS_SAFETY_UNAVAILABLE'});
  b.bind('chat','B');
  await assert.rejects(b.focus('chat',{assetPath:'/Game/BP_Test'}),{code:'FOCUS_UNAVAILABLE'});
});

test('UE MCP calls run without approval and stay in the bound editor with request IDs',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-mcp-'));
  const tools=new Map(),services=new Map(),calls=[];
  let approvalRequests=0;
  const ctx={tools:{register:d=>tools.set(d.name,d)},systemPrompt:{section(){}},typert:{register(){}},provide:(k,v)=>services.set(k,v),effect:f=>f(),get:k=>k==='approval'?{request:async()=>{approvalRequests++;return 'rejected';}}:undefined};
  await apply(ctx,{stateDir,port:0});
  const bridge=services.get('unrealBridge').bridge;
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  await editor(bridge,'A',message=>{
    calls.push(['A',message]);
    const inputSchema={type:'object',properties:{}};
    if(message.method==='mcp_discover'&&message.params.name==='describe_toolset')return {content:[{type:'text',text:JSON.stringify({name:'EditorToolset',tools:[{name:'EditorToolset.GetSelectedAssets',inputSchema}]})}]};
    if(message.method==='mcp_list_tools')return {tools:[{name:'list_toolsets',inputSchema}]};
    return{content:[{type:'text',text:message.method}]};
  },['mcp_tools','mcp_target_validation']);
  await editor(bridge,'B',message=>{calls.push(['B',message]);return{content:[{type:'text',text:message.method}]};},['mcp_tools','mcp_target_validation']);
  bridge.bind('chat','A');
  const exec={agent:{session:{id:'chat'}},name:'unreal_mcp_call_toolset',callId:'call',signal:new AbortController().signal};
  assert.equal((await tools.get('unreal_mcp_toolsets').execute({},exec)).ok,true);
  assert.equal(calls.at(-1)[0],'A');
  assert.equal(calls.at(-1)[1].params.name,'list_toolsets');
  assert.equal((await tools.get('unreal_mcp_describe').execute({toolsetName:'EditorToolset'},exec)).ok,true);
  assert.equal(calls.at(-1)[1].params.name,'describe_toolset');
  const args={toolsetName:'EditorToolset',toolName:'GetSelectedAssets',arguments:{},requestId:randomUUID()};
  const first=await tools.get('unreal_mcp_call_toolset').execute(args,exec);
  assert.equal(first.ok,true);
  assert.equal(calls.at(-1)[1].method,'mcp_call_tool');
  assert.deepEqual(calls.at(-1)[1].params,{name:'call_tool',arguments:{toolset_name:'EditorToolset',tool_name:'GetSelectedAssets',arguments:{}}});
  const count=calls.length;
  assert.deepEqual(await tools.get('unreal_mcp_call_toolset').execute(args,exec),first);
  assert.equal(calls.length,count);
  assert.equal((await tools.get('unreal_mcp_call').execute({name:'list_toolsets',arguments:{},requestId:randomUUID()},exec)).ok,true);
  assert.equal(calls.at(-1)[1].params.name,'list_toolsets');
  assert.equal(approvalRequests,0);
  bridge.bind('chat','B');
  assert.equal((await tools.get('unreal_mcp_toolsets').execute({},exec)).ok,true);
  assert.equal(calls.at(-1)[0],'B');
});

test('UE MCP calls reject editors without the capability',async t=>{
  const bridge=await fixture(t);await editor(bridge);bridge.bind('chat','UE1');
  await assert.rejects(bridge.mcpTools('chat'),{code:'MCP_UNAVAILABLE'});
});
test('UE MCP toolset descriptions can be filtered before reaching the model',async t=>{
  const bridge=await fixture(t);
  const description={name:'BlueprintTools',tools:[
    {name:'BlueprintTools.add_event',description:'Add an event.\nLong explanation.',inputSchema:{properties:{event_name:{type:'string'}}}},
    {name:'BlueprintTools.find_nodes',description:'Find nodes.\nLong explanation.',inputSchema:{properties:{graph:{type:'object'}}}}
  ]};
  await editor(bridge,'UE1',message=>({content:[{type:'text',text:JSON.stringify(description)}]}),['mcp_tools']);
  bridge.bind('chat','UE1');
  const compact=await bridge.mcpDescribe('chat',{toolsetName:'BlueprintTools',query:'add_event',includeSchema:false});
  assert.deepEqual(JSON.parse(compact.content[0].text).tools,[{name:'add_event',fullName:'BlueprintTools.add_event',toolsetName:'BlueprintTools',description:'Add an event.'}]);
  const exact=await bridge.mcpDescribe('chat',{toolsetName:'BlueprintTools',query:'add_event'});
  assert.deepEqual(JSON.parse(exact.content[0].text).tools,[{...description.tools[0],name:'add_event',fullName:'BlueprintTools.add_event',toolsetName:'BlueprintTools'}]);
});

test('project knowledge queries stay on the bound editor and require its capability',async t=>{
  const bridge=await fixture(t);const calls=[];
  await editor(bridge,'A',message=>{calls.push(['A',message]);return {status:'ready'};},['project_knowledge']);
  await editor(bridge,'B',message=>{calls.push(['B',message]);return {status:'wrong'};},[]);
  bridge.bind('chat','A');
  assert.deepEqual(await bridge.knowledge('chat',{tool:'project_status',arguments:{}}),{status:'ready'});
  assert.equal(calls.at(-1)[0],'A');assert.equal(calls.at(-1)[1].method,'knowledge_call');
  bridge.bind('chat','B');await assert.rejects(bridge.knowledge('chat',{tool:'project_status',arguments:{}}),{code:'KNOWLEDGE_UNAVAILABLE'});
  assert.equal(calls.length,1);
});

test('project knowledge records keep the same request ID when retried',async t=>{
  const bridge=await fixture(t);let writes=0;
  await editor(bridge,'UE1',message=>{if(message.method==='knowledge_call')writes++;return {saved:true};},['project_knowledge']);
  bridge.bind('chat','UE1');
  const args={tool:'remember_evidence',arguments:{summary:'Evidence',sources:[{path:'Source/A.cpp',hash:'a'.repeat(64)}]},requestId:randomUUID()};
  assert.deepEqual(await bridge.knowledgeRecord('chat',args),{saved:true});
  assert.deepEqual(await bridge.knowledgeRecord('chat',args),{saved:true});
  assert.equal(writes,1);
});
