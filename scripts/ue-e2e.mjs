// Run only against a disposable test project. All created assets stay in that project.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {UnrealBridge} from '../src/bridge.mjs';
const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/ue-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const stateDir=resolve(stateRoot);await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:30000}).start();
bridge.on('diagnostic',s=>console.log(s));
const child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[resolve(project),'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{stdio:'ignore',windowsHide:true});
try{
  const deadline=Date.now()+120000;
  while(!bridge.list().length){if(child.exitCode!==null)throw new Error(`Editor exited ${child.exitCode}`);if(Date.now()>deadline)throw new Error('Editor registration timed out');await new Promise(r=>setTimeout(r,250));}
  const instance=bridge.list()[0];bridge.bind('e2e',instance.editorId);console.log('PASS: real UE instance authenticated and registered');
  const catalog=await bridge.catalog('e2e',{query:'KismetSystemLibrary:PrintString'});assert.ok(catalog.functions.length);console.log('PASS: native function catalog and exact pin metadata');
  const assetPath=`/Game/DSHBridgeTests/BP_${randomUUID().replaceAll('-','')}`;
  const create=await bridge.preview('e2e','create',{assetPath,parent:'Actor'});const created=await bridge.apply('e2e',create.previewId,randomUUID());assert.equal(created.saved,false);
  const original=await bridge.read('e2e',{assetPath,detail:'full'});const graph=original.graphs.find(x=>x.name==='EventGraph');assert.ok(graph);
  const begin=graph.nodes.find(n=>n.functionPath==='/Script/Engine.Actor:ReceiveBeginPlay');
  const operations=[{op:'add_node',nodeId:'print',kind:'call_function',functionPath:'/Script/Engine.KismetSystemLibrary:PrintString',position:{x:400,y:200}},{op:'set_pin_default',nodeId:'print',pin:'InString',value:'Hello from DSH integration test'}];
  if(begin)operations.push({op:'connect',from:{node:begin.id,pin:begin.pins.find(p=>p.type==='exec'&&p.direction==='output').name},to:{node:'print',pin:catalog.functions[0].pins.find(p=>p.type==='exec'&&p.direction==='input').name}});
  else operations.push({op:'add_node',nodeId:'begin',kind:'event',functionPath:'/Script/Engine.Actor:ReceiveBeginPlay'},{op:'connect',from:{node:'begin',pin:'then'},to:{node:'print',pin:'execute'}});
  const params={assetPath,graph:graph.name,baseRevision:original.revision,operations};
  const preview=await bridge.preview('e2e','patch',params);assert.equal((await bridge.read('e2e',{assetPath})).revision,original.revision);
  const applied=await bridge.apply('e2e',preview.previewId,randomUUID());assert.equal(applied.compiled,true);
  const after=await bridge.read('e2e',{assetPath,detail:'full'});const print=after.graphs.flatMap(g=>g.nodes??[]).find(n=>n.functionPath==='/Script/Engine.KismetSystemLibrary:PrintString');assert.equal(print.pins.find(p=>p.name==='InString').defaultValue,'Hello from DSH integration test');assert.ok(print.pins.find(p=>p.name==='execute').links.length);
  console.log('PASS: create, preview, connected graph patch, compile and read-back');
  await assert.rejects(bridge.request(bridge.target('e2e'),'apply_patch',params,{id:randomUUID()}),{code:'CONFLICT'});console.log('PASS: editor-side stale revision rejection');
  const undone=await bridge.mutate('e2e','undo',{assetPath,baseRevision:after.revision},randomUUID());assert.equal(undone.revision,original.revision);console.log('PASS: owned editor undo restores blueprint');
  const saved=await bridge.mutate('e2e','save',{assetPath,baseRevision:undone.revision},randomUUID());assert.equal(saved.saved,true);console.log('PASS: explicit save in disposable project');
  const socket=bridge.target('e2e').ws;const close=once(socket,'close');socket.terminate();await close;const reconnectDeadline=Date.now()+15000;while(!bridge.state('e2e').connected){if(Date.now()>reconnectDeadline)throw new Error('Reconnect timed out');await new Promise(r=>setTimeout(r,100));}console.log('PASS: editor reconnect keeps conversation binding');
  console.log(JSON.stringify({status:'passed',engine:instance.engineVersion,tests:7}));
}finally{child.kill();await bridge.close();}
