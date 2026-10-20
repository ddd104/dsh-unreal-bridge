import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {selectionSchema,runtimeChangedSchema,runtimeSnapshotSchema} from '../src/protocol.mjs';
import {apply} from '../src/index.mjs';

async function fixture(t,config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-runtime-'));
  const bridge=await new UnrealBridge({port:0,stateDir,heartbeatMs:1000,...config}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return bridge;
}
const target=(overrides={})=>({playSessionId:'run-1',worldId:'world-1',objectId:'object-1',pieInstance:0,netMode:'standalone',status:'running',...overrides});
const identity=({playSessionId,worldId,objectId})=>({playSessionId,worldId,objectId});
const actor=(runtime=target())=>({kind:'actor',path:'/Game/Maps/UEDPIE_0_Test.Test:PersistentLevel.Car',class:'/Game/BP_Car.BP_Car_C',name:'Car',label:'车辆',worldPath:'/Game/Maps/UEDPIE_0_Test.Test',blueprintPath:'/Game/BP_Car.BP_Car',runtime});
const snapshot=(runtime=target(),extra={})=>({...actor(runtime),target:runtime,capturedAt:'2026-10-17T12:34:56.000Z',sampledFrame:'9007199254740993',paused:runtime.status==='paused',runtimeEvidence:true,object:{properties:[{name:'bHidden',value:false}]},components:[],...extra});
async function connect(bridge,editorId='UE1',handler=message=>snapshot({...target(),...message.params.target}),capabilities=['runtime_inspection']){
  const ws=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(ws,'open');const ack=once(ws,'message');
  ws.send(JSON.stringify({type:'hello',protocol:1,editorId,project:`Project-${editorId}`,projectPath:`/tmp/${editorId}`,engineVersion:'5.8',pid:42,capabilities}));await ack;
  ws.on('message',async raw=>{const message=JSON.parse(raw);if(message.type!=='request')return;const result=await handler(message);if(result!==undefined&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',id:message.id,ok:true,result}));});
  let sequence=0;
  const flush=async()=>{const pong=once(ws,'pong');ws.ping();await pong;};
  const event=async(name,data,seq=++sequence)=>{sequence=Math.max(sequence,seq);ws.send(JSON.stringify({type:'event',sequence:seq,event:name,data}));await flush();};
  return {ws,flush,event,runtime:(runtime=target(),invalidated=[])=>event('runtime_changed',{playSessionId:runtime?.playSessionId??null,status:runtime?.status??'stopped',isSimulating:false,invalidated}),select:(...assets)=>event('selection_changed',{assets}),respond:(id,result)=>ws.send(JSON.stringify({type:'response',id,ok:true,result}))};
}
async function live(bridge,peer,sessionId='chat',runtime=target()){
  bridge.bind(sessionId,'UE1');await peer.runtime(runtime);await peer.select(actor(runtime));
}

test('runtime metadata is restricted to level instances and bounded parameters reject before dispatch',()=>{
  assert.equal(selectionSchema.safeParse({assets:[actor()]}).success,true);
  const component={...actor(),kind:'component',ownerPath:actor().path,ownerLabel:'车辆',runtime:target({objectId:'mesh'})};
  assert.equal(selectionSchema.safeParse({assets:[component]}).success,true);
  assert.equal(selectionSchema.safeParse({assets:[{path:'/Game/BP.BP',class:'Blueprint',runtime:target()}]}).success,false);
  const template={kind:'component',source:'blueprint_editor',path:'/Game/BP.BP_C:Mesh',class:'StaticMeshComponent',name:'Mesh',label:'Mesh',componentVariableName:'Mesh',ownerLabel:'BP',ownerBlueprintPath:'/Game/BP.BP',isInherited:false};
  assert.equal(selectionSchema.safeParse({assets:[{...template,runtime:target()}]}).success,false);
  assert.equal(runtimeChangedSchema.safeParse({playSessionId:null,status:'running',isSimulating:false,invalidated:[]}).success,false);
  assert.equal(runtimeChangedSchema.safeParse({playSessionId:'run',status:'stopped',isSimulating:false,invalidated:[]}).success,false);
  assert.deepEqual(runtimeSnapshotSchema.parse({}),{maxProperties:80,includeComponents:true,maxComponents:16,collectionOffset:0,collectionLimit:20});
  for(const params of [{target:{playSessionId:'x',worldId:'y'}},{target:{...identity(target()),path:actor().path}},{path:actor().path},{properties:['x'.repeat(257)]},{properties:Array(101).fill('x'),maxProperties:200},{properties:['a','b'],maxProperties:1},{maxProperties:201},{maxProperties:0},{maxComponents:33},{maxComponents:0},{maxComponents:-1},{collectionOffset:-1},{collectionOffset:1000001},{collectionLimit:101},{collectionLimit:0}])assert.equal(runtimeSnapshotSchema.safeParse(params).success,false,JSON.stringify(params));
  assert.equal(runtimeSnapshotSchema.safeParse({properties:Array(100).fill('x'),maxProperties:200,maxComponents:32,collectionOffset:1000000,collectionLimit:100}).success,true);
});

test('selection/runtime events never sample; snapshot locks exact identity and preserves sampled metadata',async t=>{
  const bridge=await fixture(t,{allowWrites:false});const requests=[];
  const peer=await connect(bridge,'UE1',message=>{requests.push(message);return snapshot({...target(),...message.params.target});});
  await live(bridge,peer);
  assert.equal(requests.length,0);assert.equal(bridge.state('chat').runtime.status,'running');
  const captured=await bridge.runtimeSnapshot('chat',{properties:['bHidden'],includeComponents:false,collectionOffset:4,collectionLimit:3});
  assert.equal(requests.length,1);assert.equal(requests[0].method,'runtime_snapshot');
  assert.deepEqual(requests[0].params,{target:identity(target()),properties:['bHidden'],maxProperties:80,includeComponents:false,maxComponents:16,collectionOffset:4,collectionLimit:3});
  assert.equal(captured.status,'available');assert.equal(captured.runtimeEvidence,true);assert.equal(captured.sampledFrame,'9007199254740993');assert.equal(captured.editorId,'UE1');assert.match(captured.snapshotId,/^[0-9a-f-]{36}$/);
  await peer.runtime(target({status:'paused'}));
  assert.equal(bridge.state('chat').selection[0].runtime.status,'paused');
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:captured.snapshotId}).target.status,'running');
  assert.equal(bridge.state('chat').runtimeSnapshots[0].capturedAt,captured.capturedAt);
});

test('runtime snapshots require capability, one PIE selection or explicit identity, and an active run',async t=>{
  const bridge=await fixture(t);const old=await connect(bridge,'Old',undefined,[]);bridge.bind('chat','Old');
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'RUNTIME_UNAVAILABLE'});
  const peer=await connect(bridge);bridge.bind('chat','UE1');
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'RUNTIME_SELECTION_REQUIRED'});
  await assert.rejects(bridge.runtimeSnapshot('chat',{target:identity(target())}),{code:'RUNTIME_NOT_RUNNING'});
  await peer.runtime();await peer.select(actor(),actor(target({objectId:'other'})));
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'RUNTIME_SELECTION_REQUIRED'});
  await peer.select({path:'/Game/BP.BP',class:'Blueprint'});
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'RUNTIME_SELECTION_REQUIRED'});
  assert.equal((await bridge.runtimeSnapshot('chat',{target:identity(target())})).status,'available');
  await old.runtime(null);assert.equal(bridge.state('chat').runtime.status,'running');
});

test('stop/restart with the same path expires old targets and out-of-order events cannot revive them',async t=>{
  const bridge=await fixture(t);let count=0;const peer=await connect(bridge,'UE1',message=>{count++;return snapshot({...target(),...message.params.target});});await live(bridge,peer);
  const first=await bridge.runtimeSnapshot('chat');
  await peer.runtime(null);assert.equal(bridge.state('chat').selection.length,0);
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).status,'expired');
  const newTarget=target({playSessionId:'run-2',worldId:'world-2',objectId:'object-2'});
  await peer.runtime(newTarget);await peer.select(actor(newTarget));
  assert.equal(actor(newTarget).path,first.path);
  await assert.rejects(bridge.runtimeSnapshot('chat',{target:identity(first.target)}),{code:'RUNTIME_TARGET_EXPIRED'});
  const second=await bridge.runtimeSnapshot('chat');assert.equal(second.status,'available');assert.equal(count,2);
  await peer.event('runtime_changed',{playSessionId:'run-1',status:'running',isSimulating:false,invalidated:[]},1);
  assert.equal(bridge.state('chat').runtime.playSessionId,'run-2');
  // Even a higher sequence containing a retired run cannot revive that run.
  await peer.runtime(target());assert.equal(bridge.state('chat').runtime.playSessionId,'run-2');
  await peer.select(actor());assert.deepEqual(bridge.state('chat').selection,[]);
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:second.snapshotId}).status,'available');
});

test('destroyed actors and unloaded worlds do not rebind by path inside the same run',async t=>{
  const bridge=await fixture(t);const peer=await connect(bridge);await live(bridge,peer);
  const first=await bridge.runtimeSnapshot('chat');
  await peer.runtime(target(),[{...identity(target()),reason:'actor_destroyed'}]);
  assert.equal(bridge.state('chat').selection.length,0);
  await peer.select(actor());assert.equal(bridge.state('chat').selection.length,0);
  await assert.rejects(bridge.runtimeSnapshot('chat',{target:identity(target())}),{code:'RUNTIME_TARGET_EXPIRED'});
  const replacement=target({objectId:'new-object'});await peer.select(actor(replacement));
  const second=await bridge.runtimeSnapshot('chat');assert.equal(second.path,first.path);assert.equal(second.status,'available');
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).reason,'actor_destroyed');
  await peer.runtime(target(),[{...identity(target({objectId:'different-object'})),reason:'world_unloaded'}]);
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:second.snapshotId}).reason,'world_unloaded');
  await assert.rejects(bridge.runtimeSnapshot('chat',{target:identity(replacement)}),{code:'RUNTIME_TARGET_EXPIRED'});
});

test('tracking eviction expires only the old handle while a reselected live instance gets a new handle',async t=>{
  const bridge=await fixture(t);const peer=await connect(bridge);await live(bridge,peer);
  const first=await bridge.runtimeSnapshot('chat');
  await peer.runtime(target(),[{...identity(target()),reason:'tracking_evicted'}]);
  assert.equal(bridge.state('chat').selection.length,0);
  const old=bridge.runtimeHistory('chat',{snapshotId:first.snapshotId});
  assert.equal(old.status,'expired');assert.equal(old.reason,'tracking_evicted');
  await assert.rejects(bridge.runtimeSnapshot('chat',{target:identity(target())}),{code:'RUNTIME_TARGET_EXPIRED'});
  const reselected=target({objectId:'reselected-handle'});await peer.select(actor(reselected));
  const next=await bridge.runtimeSnapshot('chat');
  assert.equal(next.path,first.path);assert.equal(next.target.playSessionId,first.target.playSessionId);
  assert.notEqual(next.target.objectId,first.target.objectId);assert.equal(next.status,'available');
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).reason,'tracking_evicted');
});

test('history remains isolated by conversation and preserves editor identity across switch, unbind and disconnect',async t=>{
  const bridge=await fixture(t);const a=await connect(bridge);await live(bridge,a);bridge.bind('other','UE1');
  const first=await bridge.runtimeSnapshot('chat');
  assert.deepEqual(bridge.runtimeHistory('other'),{snapshots:[]});
  assert.throws(()=>bridge.runtimeHistory('other',{snapshotId:first.snapshotId}),{code:'RUNTIME_SNAPSHOT_NOT_FOUND'});
  const b=await connect(bridge,'UE2');await b.runtime();await b.select(actor());bridge.bind('chat','UE2');
  const second=await bridge.runtimeSnapshot('chat');
  assert.equal(second.editorId,'UE2');assert.equal(first.editorId,'UE1');
  bridge.bind('chat',null);assert.equal(bridge.state('chat').runtime,null);assert.equal(bridge.state('chat').runtimeSnapshots.length,2);
  const closed=once(bridge.editors.get('UE1').ws,'close');a.ws.close();await closed;
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).status,'disconnected');
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:second.snapshotId}).status,'available');
  // Reusing the editor ID on a new connection cannot make its old evidence live.
  const again=await connect(bridge);await again.runtime();await again.select(actor());
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).status,'disconnected');
  const copy=bridge.runtimeHistory('chat',{snapshotId:first.snapshotId});copy.object.properties[0].value=true;
  assert.equal(bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}).object.properties[0].value,false);
});

test('an object invalidated while its snapshot is in flight is retained only as expired evidence',async t=>{
  const bridge=await fixture(t);let dispatched;const request=new Promise(resolve=>dispatched=resolve);
  const peer=await connect(bridge,'UE1',message=>{dispatched(message);});await live(bridge,peer);
  const pending=bridge.runtimeSnapshot('chat');const message=await request;
  await peer.runtime(target(),[{...identity(target()),reason:'object_destroyed'}]);
  peer.respond(message.id,snapshot());
  const captured=await pending;assert.equal(captured.status,'expired');assert.equal(captured.reason,'object_destroyed');
  assert.equal(bridge.state('chat').runtimeSnapshots[0].status,'expired');
});

test('a run ending during a snapshot does not attach old evidence to the next run',async t=>{
  const bridge=await fixture(t);let dispatched;const request=new Promise(resolve=>dispatched=resolve);
  const peer=await connect(bridge,'UE1',message=>{dispatched(message);});await live(bridge,peer);
  const pending=bridge.runtimeSnapshot('chat');const message=await request;
  await peer.runtime(null);await peer.runtime(target({playSessionId:'run-2'}));
  peer.respond(message.id,snapshot());assert.equal((await pending).reason,'pie_ended');
});

test('binding changes including A to B to A discard in-flight runtime results',async t=>{
  const bridge=await fixture(t);let dispatched;const request=new Promise(resolve=>dispatched=resolve);
  const a=await connect(bridge,'UE1',message=>{dispatched(message);});await connect(bridge,'UE2');await live(bridge,a);
  const pending=bridge.runtimeSnapshot('chat');const rejected=assert.rejects(pending,{code:'INSTANCE_CHANGED'});const message=await request;
  bridge.bind('chat','UE2');bridge.bind('chat','UE1');a.respond(message.id,snapshot());await rejected;
  assert.deepEqual(bridge.runtimeHistory('chat'),{snapshots:[]});
});

test('responses from a different WebSocket editor and mismatched target identities are rejected',async t=>{
  const bridge=await fixture(t);let dispatched;const request=new Promise(resolve=>dispatched=resolve);
  const a=await connect(bridge,'UE1',message=>{dispatched(message);});const b=await connect(bridge,'UE2');await live(bridge,a);
  const pending=bridge.runtimeSnapshot('chat');const message=await request;
  b.respond(message.id,snapshot());await b.flush();assert.equal(bridge.pending.has(message.id),true);
  const rejected=assert.rejects(pending,{code:'INVALID_RUNTIME_SNAPSHOT'});a.respond(message.id,snapshot(target({objectId:'someone-else'})));await rejected;
  assert.deepEqual(bridge.runtimeHistory('chat'),{snapshots:[]});
});

test('malformed snapshot evidence is rejected without entering history',async t=>{
  const bridge=await fixture(t);const peer=await connect(bridge,'UE1',()=>snapshot(target(),{runtimeEvidence:false}));await live(bridge,peer);
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'INVALID_RUNTIME_SNAPSHOT'});assert.deepEqual(bridge.runtimeHistory('chat'),{snapshots:[]});
});

test('runtime output normalizes signed zero throughout evidence and rejects nonfinite JSON extras',async t=>{
  const bridge=await fixture(t);let peer;
  peer=await connect(bridge,'UE1',message=>{
    // Exercise actual WS bytes: -0 survives JSON.parse in the host.
    const raw=JSON.stringify({type:'response',id:message.id,ok:true,result:snapshot()}).replace('"object":{','"object":{"rotation":{"pitch":-0,"roll":-0},').replace('"components":[]','"components":[{"transform":[-0,{"x":-0}]}]');
    peer.ws.send(raw);
  });await live(bridge,peer);
  const captured=await bridge.runtimeSnapshot('chat');
  assert.equal(Object.is(captured.object.rotation.pitch,-0),false);assert.equal(Object.is(captured.components[0].transform[0],-0),false);assert.equal(Object.is(captured.components[0].transform[1].x,-0),false);
  const history=bridge.runtimeHistory('chat',{snapshotId:captured.snapshotId});assert.equal(Object.is(history.object.rotation.roll,-0),false);
  bridge.request=async()=>snapshot(target(),{diagnostics:{overflow:Infinity}});
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'INVALID_RUNTIME_SNAPSHOT'});
  bridge.request=async()=>snapshot(target(),{object:{value:Infinity}});
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'INVALID_RUNTIME_SNAPSHOT'});
  assert.equal(bridge.runtimeHistory('chat').snapshots.length,1);
});

test('history evicts the oldest entry after 20 captures and enforces its total byte budget',async t=>{
  const bridge=await fixture(t);const peer=await connect(bridge);await live(bridge,peer);
  const first=await bridge.runtimeSnapshot('chat');for(let index=0;index<20;index++)await bridge.runtimeSnapshot('chat');
  assert.equal(bridge.runtimeHistory('chat').snapshots.length,20);
  assert.throws(()=>bridge.runtimeHistory('chat',{snapshotId:first.snapshotId}),{code:'RUNTIME_SNAPSHOT_NOT_FOUND'});
  // Larger-than-transport responses can still be returned by internal request
  // adapters. The history must enforce its own budget independently of WS.
  bridge.request=async()=>snapshot(target(),{object:{payload:'x'.repeat(1024*1024)}});
  for(let index=0;index<17;index++)await bridge.runtimeSnapshot('chat');
  const records=bridge.runtimeSnapshots.get('chat');assert.ok(records.length<20);assert.ok(records.reduce((sum,item)=>sum+item.bytes,0)<=16*1024*1024);
  bridge.request=async()=>snapshot(target(),{object:{payload:'x'.repeat(16*1024*1024)}});
  await assert.rejects(bridge.runtimeSnapshot('chat'),{code:'RUNTIME_SNAPSHOT_TOO_LARGE'});
});

test('runtime tools are registered as approval-free reads and history works offline',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-runtime-tools-')),tools=new Map(),services=new Map(),prompts=[];let approvals=0;
  const ctx={tools:{register:tool=>tools.set(tool.name,tool)},systemPrompt:{section:section=>prompts.push(section.text)},typert:{register(){}},provide:(key,value)=>services.set(key,value),effect:f=>f(),get:key=>key==='approval'?{request:async()=>{approvals++;return 'rejected';}}:undefined};
  await apply(ctx,{stateDir,port:0,allowWrites:false,requireApproval:true});const bridge=services.get('unrealBridge').bridge;
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  const peer=await connect(bridge);await live(bridge,peer);const exec={agent:{session:{id:'chat'}},signal:new AbortController().signal};
  assert.equal(tools.size,24);assert.equal(tools.get('unreal_runtime_snapshot').isConcurrencySafe(),true);assert.equal(tools.get('unreal_runtime_history').isConcurrencySafe(),true);
  const result=await tools.get('unreal_runtime_snapshot').execute({},exec);assert.equal(result.ok,true);assert.equal(approvals,0);
  const closed=once(bridge.editors.get('UE1').ws,'close');peer.ws.close();await closed;
  const history=await tools.get('unreal_runtime_history').execute({snapshotId:result.snapshotId},exec);assert.equal(history.ok,true);assert.equal(history.status,'disconnected');
  assert.equal((await tools.get('unreal_state').execute({},exec)).runtimeSnapshots.length,1);
  assert.equal((await tools.get('unreal_runtime_history').execute({},{})).error.code,'SESSION_REQUIRED');
  assert.equal((await tools.get('unreal_runtime_history').execute({snapshotId:randomUUID()},exec)).error.code,'RUNTIME_SNAPSHOT_NOT_FOUND');
  assert.match(prompts[0],/AngelScript/);assert.match(prompts[0],/not the events\/nodes actually executed/);
});
