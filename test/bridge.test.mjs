import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';
import {patchSchema} from '../src/protocol.mjs';
import {apply} from '../src/index.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,config={}){const stateDir=await mkdtemp(join(tmpdir(),'dsh-bridge-'));const b=await new UnrealBridge({port:0,stateDir,heartbeatMs:1000,...config}).start();t.after(async()=>{await b.close();await rm(stateDir,{recursive:true,force:true});});return b;}
async function editor(b,editorId='UE1',handler=msg=>({echo:msg.method})){
  const ws=new WebSocket(b.descriptor.url,{headers:{Authorization:`Bearer ${b.token}`}});await once(ws,'open');const ack=once(ws,'message');ws.send(JSON.stringify({type:'hello',protocol:1,editorId,project:editorId,projectPath:`/tmp/${editorId}`,engineVersion:'5.8',pid:123,capabilities:['read_blueprint','apply_patch']}));await ack;
  ws.on('message',async raw=>{const m=JSON.parse(raw);if(m.type!=='request')return;const result=await handler(m);if(result!==undefined)ws.send(JSON.stringify({type:'response',id:m.id,ok:true,result}));});return ws;
}
const patch=()=>({assetPath:'/Game/Test/BP_Test',graph:'EventGraph',baseRevision:'v1',operations:[{op:'add_node',nodeId:'temp1',kind:'call_function',functionPath:'/Script/Engine.KismetSystemLibrary:PrintString'}]});

test('authentication rejects missing token and browser origins',async t=>{const b=await fixture(t);for(const headers of [{},{Origin:'http://127.0.0.1'},{Authorization:`Bearer ${b.token}`,Origin:'https://evil.test'}]){const ws=new WebSocket(b.descriptor.url,{headers});const [e]=await once(ws,'error');assert.match(e.message,/401/);}assert.equal(b.list().length,0);});
test('authenticated native UE loopback origin is accepted',async t=>{const b=await fixture(t);const ws=new WebSocket(b.descriptor.url,{headers:{Authorization:`Bearer ${b.token}`,Origin:'http://127.0.0.1'}});await once(ws,'open');ws.close();});
test('two conversations keep independent instance and selection state',async t=>{const b=await fixture(t);const a=await editor(b,'A'),c=await editor(b,'B');b.bind('one','A');b.bind('two','B');a.send(JSON.stringify({type:'event',sequence:1,event:'selection_changed',data:{assets:[{path:'/Game/A.A',class:'Blueprint'}]}}));await pause(20);assert.equal(b.state('one').selection[0].path,'/Game/A.A');assert.deepEqual(b.state('two').selection,[]);assert.equal((await b.read('two',{assetPath:'/Game/B'})).echo,'read_blueprint');const closed=once(b.editors.get('B').ws,'close');c.close();await closed;assert.equal(b.state('two').editorId,'B');assert.equal(b.state('two').connected,false);});
test('out-of-order events cannot restore stale selections',async t=>{const b=await fixture(t);const ws=await editor(b);b.bind('s','UE1');for(const sequence of [2,1])ws.send(JSON.stringify({type:'event',sequence,event:'selection_changed',data:{assets:[{path:`/Game/N${sequence}`,class:'Blueprint'}]}}));await pause(20);assert.equal(b.state('s').selection[0].path,'/Game/N2');});
test('patch schema rejects unknown ops, path escape and unknown fields',()=>{for(const p of [{...patch(),assetPath:'/Game/../Engine/X'},{...patch(),operations:[{op:'execute_shell',command:'x'}]},{...patch(),save:true}])assert.equal(patchSchema.safeParse(p).success,false);});
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
  assert.equal(services.get('unrealBridge').typertRemote.service,services.get('unrealBridge'));assert.equal(tools.size,10);
});
