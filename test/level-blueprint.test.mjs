import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {levelBlueprintSchema} from '../src/protocol.mjs';

const mapPath='/Game/Maps/Map_Test.Map_Test';
const available={status:'available',mapPath,blueprint:{refPath:`${mapPath}:PersistentLevel.Map_Test`},graphs:[{name:'EventGraph',refPath:`${mapPath}:PersistentLevel.Map_Test.EventGraph`,nodeCount:1}],saveTarget:{refPath:mapPath},savingNote:'Save the map package after an authorized edit.',packageDirty:false,compileError:false};
async function fixture(t,capabilities=['read_blueprint','level_blueprint_lookup'],config={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-level-lookup-'));
  const bridge=await new UnrealBridge({port:0,stateDir,...config}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId:'UE',project:'fixture',projectPath:'/tmp/fixture',engineVersion:'5.8',pid:42,capabilities}));await ack;
  bridge.bind('chat','UE');let respond=()=>available;const calls=[];
  socket.on('message',async raw=>{const message=JSON.parse(raw);if(message.type!=='request')return;calls.push(message);const result=await respond(message);socket.send(JSON.stringify({type:'response',id:message.id,ok:true,result}));});
  return {bridge,calls,setHandler:handler=>respond=handler};
}

test('level lookup accepts map packages or objects and rejects subobjects and disk paths',()=>{
  for(const value of ['/Game/Maps/Map_Test',mapPath])assert.equal(levelBlueprintSchema.parse({mapPath:value}).mapPath,value);
  for(const value of [`${mapPath}:PersistentLevel.Map_Test`,'F:/Project/Map_Test.umap','/Engine/Map_Test','/Game/../Other'])assert.equal(levelBlueprintSchema.safeParse({mapPath:value}).success,false);
});

test('an old editor advertises the missing level capability and does not dispatch a guessed path',async t=>{
  const f=await fixture(t,['read_blueprint']);
  assert.deepEqual(f.bridge.state('chat').blueprintSupport,{normalBlueprints:true,levelBlueprintLookup:false,levelBlueprintNativePatch:false});
  await assert.rejects(f.bridge.levelBlueprint('chat',{mapPath}),error=>error.code==='LEVEL_BLUEPRINT_LOOKUP_UNAVAILABLE'&&error.details.execution==='not_started');
  assert.equal(f.calls.length,0);
});

test('level lookup is a read under allowWrites false and returns the exact existing reference',async t=>{
  const f=await fixture(t,undefined,{allowWrites:false});
  assert.deepEqual(await f.bridge.levelBlueprint('chat',{mapPath:'/Game/Maps/Map_Test'}),available);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'resolve_level_blueprint');
  assert.equal(f.bridge.state('chat').blueprintSupport.levelBlueprintLookup,true);
});

test('a lookup cannot return a different map or accept a binding round trip while in flight',async t=>{
  const f=await fixture(t);f.setHandler(()=>({...available,mapPath:'/Game/Maps/Other.Other'}));
  await assert.rejects(f.bridge.levelBlueprint('chat',{mapPath}),{code:'INVALID_LEVEL_BLUEPRINT_RESULT'});
  let entered,release;const started=new Promise(r=>entered=r),finish=new Promise(r=>release=r);
  f.setHandler(async()=>{entered();await finish;return available;});
  const pending=f.bridge.levelBlueprint('chat',{mapPath});await started;f.bridge.bind('chat',null);f.bridge.bind('chat','UE');release();
  await assert.rejects(pending,{code:'INSTANCE_CHANGED'});
});
