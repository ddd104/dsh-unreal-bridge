import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {materialReadSchema,materialPatchSchema} from '../src/protocol.mjs';
import {operationContext} from '../src/operation-context.mjs';
import {apply} from '../src/index.mjs';

const assetPath='/RadarPlugin/Materials/M_Test.M_Test';
const objectPath=`${assetPath}:MaterialExpressionScalarParameter_0`;
const readResult=()=>({
  assetPath,assetClass:'/Script/Engine.Material',revision:'rev-1',nodesComplete:true,
  nodes:[{id:'node-1',objectPath,classPath:'/Script/Engine.MaterialExpressionScalarParameter',ownerPath:assetPath,inputs:[],outputs:[{index:0,name:''}],properties:{default_value:0.2}}],
});
const patch=(overrides={})=>({
  assetPath,baseRevision:'rev-1',requestId:randomUUID(),
  operations:[{op:'set',id:'node-1',properties:{default_value:0.2}}],
  ...overrides,
});
const committed=()=>({verified:true,dryRun:false,assetPath,revision:'rev-2',saved:false});
const previewed=()=>({verified:true,dryRun:true,assetPath,revision:'rev-1',saved:false});
const ok=result=>({ok:true,result});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function fixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-material-tools-'));
  const bridge=await new UnrealBridge({port:0,stateDir,...config}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return bridge;
}

async function editor(bridge,editorId='UE',handler=message=>ok(message.method==='material_read'?readResult():message.params.dryRun?previewed():committed()),capabilities=['material_graph_patch']){
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}}),calls=[];
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId,project:editorId,projectPath:`/tmp/${editorId}`,engineVersion:'5.8',pid:123,capabilities}));await ack;
  socket.on('message',async raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;calls.push(message);
    const response=await handler(message);
    if(response!==undefined&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'response',id:message.id,...response}));
  });
  return {socket,calls};
}

async function toolFixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-material-tool-wrapper-'));
  const tools=new Map(),services=new Map(),disposers=[],hooks=new Map();
  let approval='rejected',approvalRequests=0;
  const ctx={
    tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}},typert:{register(){}},
    provide:(name,value)=>services.set(name,value),get:name=>name==='approval'?{request:async()=>{approvalRequests++;return approval;}}:undefined,
    on(name,callback){hooks.set(name,callback);return ()=>hooks.delete(name);},
    effect(callback){disposers.push(callback());},
  };
  await apply(ctx,{port:0,stateDir,...config});
  const bridge=services.get('unrealBridge').bridge;
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose?.();await rm(stateDir,{recursive:true,force:true});});
  const agent={session:{id:'chat'},cancel(){}};
  hooks.get('session/event')(agent.session,{type:'turn/start',seq:1,data:{turn:1}});
  const execute=(name,args)=>tools.get(name).execute(args,{agent,name,arguments:args,callId:randomUUID(),signal:new AbortController().signal});
  return {bridge,tools,execute,allow:()=>{approval='allowed-once';},approvalRequests:()=>approvalRequests};
}

const objectOperation=(bridge,session='chat')=>operationContext(bridge,session,'unreal_mcp_call_toolset',{
  toolsetName:'editor_toolset.toolsets.object.ObjectTools',toolName:'set_properties',
  arguments:{instance:{refPath:objectPath},values:'{"default_value":0.4}'},
});

test('material contracts accept mounted assets and bound operations, pins, classes and cleanup requests',()=>{
  const parsed=materialPatchSchema.parse(patch());
  assert.equal(parsed.dryRun,true);assert.equal(parsed.layout,'none');
  for(const path of ['/Game/M_Test','/RadarPlugin/Materials/M_Test.M_Test','/Engine/Materials/DefaultMaterial']){
    assert.equal(materialReadSchema.safeParse({assetPath:path}).success,true);
    assert.equal(materialPatchSchema.safeParse(patch({assetPath:path})).success,true);
  }
  for(const path of ['/Game/../M_Test','/Game/M_Test.M_Test:Expression','C:/Materials/M_Test','/Game/M Test','/Game/M_Test;bad']){
    assert.equal(materialReadSchema.safeParse({assetPath:path}).success,false,path);
  }
  for(const args of [
    patch({operations:[]}),patch({operations:Array(257).fill(patch().operations[0])}),
    patch({operations:[{op:'connect',from:{id:'one',pin:256},to:{id:'two',pin:0}}]}),
    patch({operations:[{op:'add',id:'one',expressionClass:'/Game/BlueprintExpression.BlueprintExpression'}]}),
    patch({operations:[{op:'add',id:'one',expressionClass:'/Script/Engine.MaterialExpressionConstant',position:{x:100001,y:0}}]}),
    patch({operations:[{op:'run_script',script:'arbitrary code'}]}),
    patch({layout:'automatic'}),patch({cleanupNodeIds:Array(257).fill('one')}),patch({save:true}),
  ])assert.equal(materialPatchSchema.safeParse(args).success,false);
  for(const args of [
    {assetPath,nodeIds:[]},{assetPath,nodeIds:Array(257).fill('one')},
    {assetPath,expressionClasses:Array(33).fill('/Script/Engine.MaterialExpressionConstant')},
    {assetPath,expressionClasses:['NotAnExpressionPath']},{assetPath,readOnlyHint:true},
  ])assert.equal(materialReadSchema.safeParse(args).success,false);
});

test('older editors reject material tools before dispatch and native graph reads establish exact ownership',async t=>{
  const bridge=await fixture(t);
  const old=await editor(bridge,'old',()=>ok({}),[]);bridge.bind('chat','old');
  await assert.rejects(bridge.materialRead('chat',{assetPath}),{code:'MATERIAL_TOOLS_UNAVAILABLE'});
  await assert.rejects(bridge.materialPatch('chat',patch()),{code:'MATERIAL_TOOLS_UNAVAILABLE'});
  assert.equal(old.calls.length,0);
  const current=await editor(bridge);bridge.bind('chat','UE');
  assert.equal(objectOperation(bridge).family,'object_properties');
  assert.deepEqual(await bridge.materialRead('chat',{assetPath}),readResult());
  assert.equal(objectOperation(bridge).family,'material_edit');
  assert.equal(objectOperation(bridge).target,assetPath.toLowerCase());
  assert.equal(current.calls[0].method,'material_read');
});

test('material preview defaults to a verified transient operation and remains available in read-only mode',async t=>{
  const bridge=await fixture(t,{allowWrites:false}),ue=await editor(bridge);bridge.bind('chat','UE');
  assert.deepEqual(await bridge.materialPatch('chat',patch()),previewed());
  assert.equal(ue.calls[0].params.dryRun,true);assert.equal(ue.calls[0].params.layout,'none');
  assert.equal('requestId' in ue.calls[0].params,false);assert.equal(bridge.state('chat').editorWrite,null);
  await assert.rejects(bridge.materialPatch('chat',patch({dryRun:false})),{code:'READ_ONLY'});
  assert.equal(ue.calls.length,1);
  assert.deepEqual(await bridge.materialRead('chat',{assetPath}),readResult());
});

test('material commits use the configured approval policy while previews never request approval',async t=>{
  const f=await toolFixture(t),ue=await editor(f.bridge);f.bridge.bind('chat','UE');
  assert.equal((await f.execute('unreal_material_patch',patch())).ok,true);
  assert.equal(f.approvalRequests(),0);
  const denied=await f.execute('unreal_material_patch',patch({dryRun:false}));
  assert.equal(denied.error.code,'PERMISSION_DENIED');assert.equal(f.approvalRequests(),1);
  assert.equal(ue.calls.length,1);
  f.allow();
  assert.equal((await f.execute('unreal_material_patch',patch({dryRun:false}))).verified,true);
  assert.equal(f.approvalRequests(),2);
  assert.equal(ue.calls[1].params.dryRun,false);
});

test('verified commits are idempotent and request IDs cannot be reused for changed operations',async t=>{
  const bridge=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE');
  const args=patch({dryRun:false}),first=await bridge.materialPatch('chat',args);
  assert.deepEqual(await bridge.materialPatch('chat',args),first);
  assert.equal(ue.calls.length,1);assert.equal(ue.calls[0].id,args.requestId);
  await assert.rejects(bridge.materialPatch('chat',{...args,operations:[{op:'set',id:'node-1',properties:{default_value:0.7}}]}),{code:'IDEMPOTENCY_MISMATCH'});
  assert.equal(ue.calls.length,1);assert.equal(bridge.state('chat').editorWrite,null);
});

test('a pending material commit excludes peer writes while graph diagnostics continue',async t=>{
  const bridge=await fixture(t),started=deferred(),finish=deferred();
  const ue=await editor(bridge,'UE',async message=>{
    if(message.method==='material_read')return ok(readResult());
    started.resolve();await finish.promise;return ok(committed());
  });
  bridge.bind('owner','UE');bridge.bind('peer','UE');
  const pending=bridge.materialPatch('owner',patch({dryRun:false}));await started.promise;
  await assert.rejects(bridge.materialPatch('peer',patch({dryRun:false})),{code:'BUSY'});
  assert.deepEqual(await bridge.materialRead('peer',{assetPath}),readResult());
  assert.equal(ue.calls.filter(call=>call.method==='material_patch').length,1);
  finish.resolve();await pending;
  assert.equal(bridge.state('peer').editorWrite,null);
});

test('unknown material commit outcomes are resolved by the original request without replaying the mutation',async t=>{
  const bridge=await fixture(t,{requestTimeoutMs:80}),args=patch({dryRun:false});
  const ue=await editor(bridge,'UE',message=>{
    if(message.method==='material_patch')return undefined;
    if(message.method==='material_read')return ok(readResult());
    return ok({status:'completed',response:ok(committed())});
  });
  bridge.bind('owner','UE');bridge.bind('peer','UE');
  await assert.rejects(bridge.materialPatch('owner',args),{code:'TIMEOUT'});
  assert.equal(bridge.state('peer').uncertain.requestId,args.requestId);
  await assert.rejects(bridge.materialPatch('peer',patch({dryRun:false})),{code:'OUTCOME_UNKNOWN'});
  assert.deepEqual(await bridge.materialRead('peer',{assetPath}),readResult());
  await bridge.requestStatus('peer',args.requestId);
  assert.equal(bridge.state('owner').uncertain,null);
  assert.deepEqual(await bridge.materialPatch('owner',args),committed());
  assert.equal(ue.calls.filter(call=>call.method==='material_patch').length,1);
});

test('unverified direct and recovered material commits lock further writes without blocking graph reads',async t=>{
  for(const recovered of [false,true]){
    const bridge=await fixture(t,{requestTimeoutMs:80});
    const ue=await editor(bridge,'UE',message=>{
      if(message.method==='material_read')return ok(readResult());
      if(message.method==='request_status')return ok({status:'completed',response:ok({verified:true,dryRun:true})});
      return recovered?undefined:ok({verified:false,dryRun:false});
    });
    bridge.bind('owner','UE');bridge.bind('peer','UE');
    const args=patch({dryRun:false});
    await assert.rejects(bridge.materialPatch('owner',args),{code:recovered?'TIMEOUT':'ROLLBACK_FAILED'});
    if(recovered)await assert.rejects(bridge.requestStatus('peer',args.requestId),{code:'ROLLBACK_FAILED'});
    assert.equal(bridge.state('peer').writeLock.rollback,'failed');
    await assert.rejects(bridge.materialPatch('peer',patch({dryRun:false})),{code:'EDITOR_WRITE_LOCKED'});
    assert.deepEqual(await bridge.materialRead('peer',{assetPath}),readResult());
    assert.equal(ue.calls.filter(call=>call.method==='material_patch').length,1);
  }
});

test('an invalid preview cannot be reported as a commit or acquire a persistent write lock',async t=>{
  const bridge=await fixture(t);
  await editor(bridge,'UE',()=>ok(committed()));
  bridge.bind('chat','UE');
  await assert.rejects(bridge.materialPatch('chat',patch()),{code:'MATERIAL_PREVIEW_INVALID'});
  assert.equal(bridge.state('chat').writeLock,null);assert.equal(bridge.state('chat').editorWrite,null);
  assert.deepEqual(await bridge.materialPatch('chat',patch({dryRun:false})),committed());
});

test('a material graph response arriving after a binding change cannot populate owner evidence',async t=>{
  const bridge=await fixture(t),started=deferred(),finish=deferred();
  await editor(bridge,'A',async()=>{started.resolve();await finish.promise;return ok(readResult());});
  await editor(bridge,'B');
  bridge.bind('chat','A');
  const pending=bridge.materialRead('chat',{assetPath});
  const rejected=assert.rejects(pending,{code:'INSTANCE_CHANGED'});
  await started.promise;bridge.bind('chat','B');finish.resolve();await rejected;
  assert.equal(objectOperation(bridge).family,'object_properties');
  bridge.bind('chat','A');
  assert.equal(objectOperation(bridge).family,'object_properties');
});

test('material reads reject mismatched targets, coverage and malformed ownership before registering nodes',async t=>{
  const bridge=await fixture(t);let response=readResult();
  await editor(bridge,'UE',()=>ok(response));bridge.bind('chat','UE');
  for(const bad of [
    {...readResult(),assetPath:'/Game/Different.Different'},
    {...readResult(),nodesComplete:false},
    {...readResult(),nodes:[{...readResult().nodes[0],ownerPath:'/Game/Different.Different'}]},
  ]){
    response=bad;
    await assert.rejects(bridge.materialRead('chat',{assetPath}),{code:'MATERIAL_READ_INVALID'});
    assert.equal(objectOperation(bridge).family,'object_properties');
  }
  response={...readResult(),nodesComplete:false};
  assert.deepEqual(await bridge.materialRead('chat',{assetPath,nodeIds:['node-1']}),response);
  assert.equal(objectOperation(bridge).family,'material_edit');
});

test('the tool guard blocks both material additions and trusted ObjectTools setters after the same material problem exhausts its allowance',async t=>{
  const f=await toolFixture(t,{requireApproval:false,guardMaxRepairAttempts:0});
  const ue=await editor(f.bridge,'UE',message=>{
    if(message.method==='material_read')return ok(readResult());
    if(message.params.assetPath==='/Game/Independent')return ok({...previewed(),assetPath:'/Game/Independent'});
    return {ok:false,error:{code:'MATERIAL_PIN_INVALID',message:'No such pin',details:{rollback:'restored'}}};
  });
  f.bridge.bind('chat','UE');
  assert.equal((await f.execute('unreal_material_read',{assetPath})).ok,true);
  const failure=await f.execute('unreal_material_patch',patch());
  assert.equal(failure.error.code,'MATERIAL_PIN_INVALID');
  assert.equal(failure.executionSafety.error.recovery,'stop_problem');
  assert.equal(failure.executionSafety.error.recoveryConstraints.retainTarget,true);
  assert.ok(failure.executionSafety.error.recoveryConstraints.prohibitedWorkarounds.includes('rebuild_replacement'));
  for(const args of [
    {toolsetName:'editor_toolset.toolsets.material.MaterialTools',toolName:'add_expression',arguments:{material_or_function:{refPath:assetPath},expression_class:{refPath:'/Script/Engine.MaterialExpressionConstant'}}},
    {toolsetName:'editor_toolset.toolsets.object.ObjectTools',toolName:'set_properties',arguments:{instance:{refPath:objectPath},values:'{"default_value":0.4}'}},
  ]){
    const denied=await f.execute('unreal_mcp_call_toolset',{...args,requestId:randomUUID()});
    assert.equal(denied.error.code,'REPAIR_BUDGET_EXHAUSTED');
    assert.equal(denied.error.details.problem.target,assetPath.toLowerCase());
    assert.equal(denied.error.details.recovery,'stop_problem');
    assert.deepEqual(denied.executionSafety.error.recoveryConstraints,failure.executionSafety.error.recoveryConstraints);
  }
  assert.equal(ue.calls.length,2,'denied dependent writes must not reach discovery or native dispatch');
  assert.equal((await f.execute('unreal_material_read',{assetPath})).ok,true);
  assert.equal((await f.execute('unreal_material_patch',patch({assetPath:'/Game/Independent'}))).ok,true);
});

test('material failure output is compact but explicit state retains full guard evidence',async t=>{
  const f=await toolFixture(t,{requireApproval:false});
  await editor(f.bridge,'UE',()=>({ok:false,error:{code:'MATERIAL_PIN_INVALID',message:'Output pin does not exist',details:{rollback:'restored',execution:'not_started'}}}));
  f.bridge.bind('chat','UE');
  const failure=await f.execute('unreal_material_patch',patch());
  assert.equal(failure.error.code,'MATERIAL_PIN_INVALID');
  assert.equal(failure.executionSafety.error.code,'MATERIAL_PIN_INVALID');
  assert.equal(failure.executionSafety.error.rollback,'restored');
  assert.equal('limits' in failure.executionSafety,false);
  const state=await f.execute('unreal_state',{});
  assert.ok(state.executionSafety.limits);
  assert.equal(state.executionSafety.repairs.issues[0].family,'material_edit');
});
