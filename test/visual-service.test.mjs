import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {watch} from 'node:fs';
import {mkdtemp,rm,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import sharp from 'sharp';
import {UnrealBridge} from '../src/bridge.mjs';
import {VisualService} from '../src/visual.mjs';
import {visualCaptureSchema,visualCompareSchema} from '../src/protocol.mjs';
import {apply} from '../src/index.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const actor={kind:'actor',path:'/Game/Map.Map:PersistentLevel.Car_1',class:'/Script/Engine.StaticMeshActor',name:'Car_1',label:'车辆',worldPath:'/Game/Map.Map'};
const component={kind:'component',path:actor.path+'.Mesh',class:'/Script/Engine.StaticMeshComponent',name:'Mesh',label:'Mesh',worldPath:actor.worldPath,ownerPath:actor.path,ownerLabel:actor.label};
const template={kind:'component',source:'blueprint_editor',path:'/Game/BP_Car.BP_Car_C:Mesh_GEN_VARIABLE',class:'/Script/Engine.SceneComponent',name:'Mesh_GEN_VARIABLE',label:'Mesh',componentVariableName:'Mesh',ownerLabel:'BP_Car',ownerBlueprintPath:'/Game/BP_Car.BP_Car',isInherited:false};

async function fixture(t){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-visual-service-'));
  const bridge=await new UnrealBridge({port:0,stateDir,heartbeatMs:1000}).start();
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  return {bridge,visual:new VisualService(bridge),stateDir};
}

async function writeCapture(message){
  assert.equal(message.method,'visual_capture');
  const {outputDir,targetPath,region,source}=message.params;
  const width=32,height=24,pixels=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*3;pixels[p]=x*7;pixels[p+1]=y*9;pixels[p+2]=(x+y)*4;}
  const fullPath=join(outputDir,'viewport.png'),cropPath=join(outputDir,'crop.png'),metadataPath=join(outputDir,'capture.json');
  await sharp(pixels,{raw:{width,height,channels:3}}).png().toFile(fullPath);
  const crop=region??(targetPath?{x:4,y:4,width:16,height:16}:{x:0,y:0,width,height});
  await sharp(fullPath).extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).png().toFile(cropPath);
  const result={source,fullPath,cropPath,metadataPath,viewport:{width,height},crop,target:targetPath?{path:targetPath}:null,camera:{location:[0,0,100],rotation:[0,0,0],fov:90},render:{realtime:true},warnings:[]};
  await writeFile(metadataPath,JSON.stringify(result),{flag:'wx'});
  return result;
}

async function editor(bridge,id='UE1',{handler=writeCapture,capabilities=['visual_capture']}={}){
  const requests=[],responses=[],errors=[];
  const ws=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(ws,'open');const ack=once(ws,'message');
  ws.send(JSON.stringify({type:'hello',protocol:1,editorId:id,project:id,projectPath:`C:/Projects/${id}`,engineVersion:'5.8',pid:321,capabilities}));await ack;
  ws.on('message',async raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;requests.push(message);
    try{const result=await handler(message);responses.push(result);ws.send(JSON.stringify({type:'response',id:message.id,ok:true,result}));}
    catch(error){errors.push(error);ws.send(JSON.stringify({type:'response',id:message.id,ok:false,error:{code:'MOCK_CAPTURE_FAILED',message:error.message}}));}
  });
  let sequence=0;
  return {ws,requests,responses,errors,async selection(assets){const changed=once(bridge,'change');ws.send(JSON.stringify({type:'event',sequence:++sequence,event:'selection_changed',data:{assets}}));await changed;}};
}

test('selected scene Actor/component becomes the exact capture target and image bytes stay outside bridge messages',async t=>{
  const {bridge,visual}=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE1');
  for(const selected of [actor,component]){
    await ue.selection([selected]);const capture=await visual.capture('chat');
    assert.equal(ue.requests.at(-1).params.targetPath,selected.path);assert.equal(capture.sessionId,'chat');assert.equal(capture.editorId,'UE1');
    assert.equal(visual.getCapture('chat',capture.captureId),capture);
    assert.equal((await sharp(capture.cropPath).metadata()).width,16);assert.equal((await sharp(capture.fullPath).metadata()).width,32);
    assert.deepEqual(JSON.parse(await readFile(capture.metadataPath,'utf8')).target,{path:selected.path});
    assert.ok(isAbsolute(capture.previewPath));
  }
  assert.deepEqual(ue.errors,[]);
  for(const value of [...ue.requests,...ue.responses]){const message=JSON.stringify(value);assert.ok(message.length<4096);assert.doesNotMatch(message,/base64|data:image|"pixels"|"imageData"/);}
});

test('automatic capture rejects missing/multiple selection, Blueprint assets and templates while explicit regions bypass selection',async t=>{
  const {bridge,visual}=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE1');
  for(const [selection,code] of [[[],'TARGET_REQUIRED'],[[actor,component],'TARGET_REQUIRED'],[[{path:'/Game/BP_Car.BP_Car',class:'Blueprint'}],'SCENE_INSTANCE_REQUIRED'],[[template],'SCENE_INSTANCE_REQUIRED']]){
    await ue.selection(selection);await assert.rejects(visual.capture('chat'),{code});
  }
  assert.equal(ue.requests.length,0);
  const region={x:2,y:3,width:7,height:8},capture=await visual.capture('chat',{region});
  assert.deepEqual(ue.requests[0].params.region,region);assert.equal(ue.requests[0].params.targetPath,undefined);assert.equal(capture.crop.width,7);
  const full=await visual.capture('chat',{fullViewport:true});assert.equal(full.crop.width,32);
});

test('capture requires advertised support and rejects editor-supplied paths outside the allocated evidence directory',async t=>{
  const {bridge,visual,stateDir}=await fixture(t);
  const old=await editor(bridge,'old',{capabilities:[]});bridge.bind('chat','old');
  await assert.rejects(visual.capture('chat',{fullViewport:true}),{code:'VISUAL_UNAVAILABLE'});assert.equal(old.requests.length,0);
  await editor(bridge,'bad',{handler:async message=>({...await writeCapture(message),cropPath:join(stateDir,'outside.png')})});bridge.bind('chat','bad');
  await assert.rejects(visual.capture('chat',{fullViewport:true}),{code:'INVALID_CAPTURE'});assert.equal(visual.captures.size,0);
});

test('captures are serialized across conversations sharing one editor while a different editor can capture independently',{timeout:10000},async t=>{
  const {bridge,visual}=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
  let active=0,maxActive=0,started=0;
  const ue=await editor(bridge,'A',{handler:async message=>{active++;maxActive=Math.max(maxActive,active);if(++started===1){entered.resolve();await release.promise;}try{return await writeCapture(message);}finally{active--;}}});
  await editor(bridge,'B');bridge.bind('one','A');bridge.bind('two','A');bridge.bind('other','B');
  const first=visual.capture('one',{fullViewport:true});await entered.promise;
  const second=visual.capture('two',{fullViewport:true});
  try{
    const independent=await visual.capture('other',{fullViewport:true});assert.equal(independent.editorId,'B');
    await tick();assert.equal(ue.requests.length,1);assert.equal(active,1);
  }finally{release.resolve();}
  const [a,b]=await Promise.all([first,second]);assert.equal(maxActive,1);assert.notEqual(a.captureId,b.captureId);assert.notEqual(a.cropPath,b.cropPath);assert.equal(visual.queues.size,0);
});

test('capture IDs are isolated by conversation and current editor binding',async t=>{
  const {bridge,visual,stateDir}=await fixture(t);await editor(bridge,'A');await editor(bridge,'B');bridge.bind('one','A');bridge.bind('two','A');
  const capture=await visual.capture('one',{fullViewport:true});
  assert.throws(()=>visual.getCapture('two',capture.captureId),{code:'CAPTURE_NOT_FOUND'});
  const referencePath=join(stateDir,'reference.png');await copyFile(capture.cropPath,referencePath);
  await assert.rejects(visual.compare('two',{referencePath,captureId:capture.captureId}),{code:'CAPTURE_NOT_FOUND'});
  bridge.bind('one','B');assert.throws(()=>visual.getCapture('one',capture.captureId),{code:'INSTANCE_CHANGED'});
  await assert.rejects(visual.compare('one',{referencePath,captureId:capture.captureId}),{code:'INSTANCE_CHANGED'});
  bridge.bind('one','A');assert.equal(visual.getCapture('one',capture.captureId),capture);
});

test('assessment and unconfirmed regression remain unknown; confirmed aligned regression passes and preserves source evidence',async t=>{
  const {bridge,visual,stateDir}=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE1');await ue.selection([actor]);
  const capture=await visual.capture('chat'),referencePath=join(stateDir,'user-reference.png');await copyFile(capture.cropPath,referencePath);
  const sourceBefore=await readFile(referencePath),captureBefore=await readFile(capture.cropPath);
  for(const [mode,alignmentConfirmed,verdict] of [['assessment',false,'unknown'],['regression',false,'unknown'],['regression',true,'pass']]){
    const report=await visual.compare('chat',{referencePath,captureId:capture.captureId,mode,alignmentConfirmed});
    assert.equal(report.verdict,verdict);assert.equal(report.metrics.pixels.changedRatio,0);assert.deepEqual(report.hypotheses,[]);
    assert.equal(report.conditions.alignmentConfirmed,alignmentConfirmed);assert.equal(report.conditions.targetMask,false);
    assert.deepEqual(JSON.parse(await readFile(report.reportPath,'utf8')),report);
    assert.notEqual(report.evidence.reference,referencePath);assert.notEqual(report.evidence.current,capture.cropPath);
    if(mode==='regression'&&!alignmentConfirmed)assert.match(report.reasons.join(' '),/not been confirmed/);
  }
  assert.equal(ue.requests.length,1);assert.deepEqual(await readFile(referencePath),sourceBefore);assert.deepEqual(await readFile(capture.cropPath),captureBefore);
});

test('reference ROI is explicit and comparison never stretches mismatched dimensions',async t=>{
  const {bridge,visual}=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE1');await ue.selection([actor]);
  const capture=await visual.capture('chat');
  const mismatch=await visual.compare('chat',{referencePath:capture.fullPath,captureId:capture.captureId,mode:'regression',alignmentConfirmed:true});
  assert.equal(mismatch.verdict,'unknown');assert.deepEqual(mismatch.metrics,{});assert.equal(mismatch.dimensions.reference.width,32);assert.equal(mismatch.dimensions.current.width,16);
  const aligned=await visual.compare('chat',{referencePath:capture.fullPath,captureId:capture.captureId,referenceRegion:capture.crop,mode:'regression',alignmentConfirmed:true});
  assert.equal(aligned.verdict,'pass');assert.equal(aligned.metrics.color.meanDeltaE,0);assert.equal(aligned.dimensions.reference.width,16);
  await assert.rejects(visual.compare('chat',{referencePath:'relative.png',captureId:capture.captureId}),{code:'INVALID_REFERENCE'});
});

test('color-only assessment uses independent explicit regions and reuses one capture without spatial alignment',async t=>{
  const {bridge,visual}=await fixture(t),ue=await editor(bridge);bridge.bind('chat','UE1');
  const capture=await visual.capture('chat',{fullViewport:true});
  const referenceRegion={x:0,y:0,width:25,height:7},currentRegion={x:2,y:3,width:11,height:9};
  const report=await visual.compare('chat',{referencePath:capture.fullPath,captureId:capture.captureId,analysis:'color_distribution',referenceRegion,currentRegion,checks:['color']});
  assert.equal(ue.requests.length,1);assert.equal(report.analysis,'color_distribution');assert.equal(report.verdict,'unknown');
  assert.equal(report.metrics.colorDistribution.reference.sampleCount,25*7);assert.equal(report.metrics.colorDistribution.current.sampleCount,11*9);
  assert.deepEqual(report.dimensions.reference.region,referenceRegion);assert.deepEqual(report.dimensions.current.region,currentRegion);
  assert.equal(report.metrics.structure,undefined);assert.equal(report.metrics.pixels,undefined);assert.equal(report.evidence.heatmap,undefined);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath,'utf8')),report);
  await assert.rejects(visual.compare('chat',{referencePath:capture.fullPath,captureId:capture.captureId,analysis:'color_distribution',checks:['edges']}));
});

test('rebinding while the reference is being read rejects before dispatching a capture',async t=>{
  const {bridge,visual,stateDir}=await fixture(t),first=await editor(bridge,'A'),second=await editor(bridge,'B');bridge.bind('chat','A');
  const referencePath=join(stateDir,'input.png');await sharp({create:{width:8,height:8,channels:3,background:'#abcdef'}}).png().toFile(referencePath);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  visual.readReference=async(source,destination)=>{entered.resolve();await release.promise;await copyFile(source,destination);};
  const pending=visual.compare('chat',{referencePath,capture:{fullViewport:true}}),rejected=assert.rejects(pending,{code:'INSTANCE_CHANGED'});
  await entered.promise;bridge.bind('chat','B');release.resolve();await rejected;
  assert.equal(first.requests.length,0);assert.equal(second.requests.length,0);
});

test('rebinding while comparison evidence is being written prevents a success result',{timeout:10000},async t=>{
  const {bridge,visual}=await fixture(t);await editor(bridge,'A');await editor(bridge,'B');bridge.bind('chat','A');
  const capture=await visual.capture('chat',{fullViewport:true}),directory=visual.directory.bind(visual);let changed=false;
  const watchers=[];t.after(()=>watchers.forEach(watcher=>watcher.close()));
  visual.directory=async(...args)=>{const dir=await directory(...args);watchers.push(watch(dir,(_event,filename)=>{if(String(filename)==='reference.png'&&!changed){changed=true;bridge.bind('chat','B');}}));return dir;};
  await assert.rejects(visual.compare('chat',{referencePath:capture.cropPath,captureId:capture.captureId,mode:'regression',alignmentConfirmed:true}),{code:'INSTANCE_CHANGED'});
  assert.equal(changed,true);
});

test('visual schemas reject ambiguous targets, invalid regions/thresholds, PIE and unexpected fields',()=>{
  for(const value of [{targetPath:actor.path,region:{x:0,y:0,width:2,height:2}},{targetPath:actor.path,fullViewport:true},{source:'pie'},{region:{x:0.2,y:0,width:2,height:2}},{region:{x:0,y:0,width:0,height:2}},{padding:257},{script:'do something'}])assert.equal(visualCaptureSchema.safeParse(value).success,false,JSON.stringify(value));
  for(const value of [{referencePath:'x',captureId:randomUUID(),capture:{fullViewport:true}},{referencePath:'x',checks:[]},{referencePath:'x',thresholds:{maxChangedPixelRatio:1.1}},{referencePath:'x',thresholds:{mystery:1}},{referencePath:'x',resize:true}])assert.equal(visualCompareSchema.safeParse(value).success,false,JSON.stringify(value));
  const defaults=visualCompareSchema.parse({referencePath:'x'});assert.equal(defaults.mode,'assessment');assert.equal(defaults.alignmentConfirmed,false);
});

async function toolFixture(t,{modalities=['text'],attachments=true}={}){
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-visual-tools-')),tools=new Map(),provided=new Map(),fsCalls=[],observed=[],saved=[];
  const fs={resolve:async(value,options)=>{fsCalls.push({method:'resolve',value,options});return value;},stat:async value=>{fsCalls.push({method:'stat',value});const info=await stat(value);return {type:info.isFile()?'file':'directory',version:'v1'};},readBytes:async(value,signal,limit)=>{fsCalls.push({method:'readBytes',value,limit,signal});return readFile(value,{signal});}};
  let approvals=0;
  const attachmentStore=attachments?{imageLimits:{mediaTypes:['image/png'],maxImagesPerMessage:4,maxImageBytes:8*1024*1024,maxMessageImageBytes:16*1024*1024},async saveImages(inputs){saved.push(...inputs);return Promise.all(inputs.map(async(input,index)=>{const info=await sharp(input.data).metadata();return {attachmentId:`test-image-${index}`,mediaType:input.mediaType,bytes:input.data.length,width:info.width,height:info.height,name:input.name};}));}}:undefined;
  const services={fs,workingDirectory:{ensure:async()=>stateDir},attachments:attachmentStore,llm:{resolveModelInfo:async()=>({inputModalities:modalities})},approval:{request:async()=>{approvals++;return 'rejected';}}};
  const ctx={tools:{register:d=>tools.set(d.name,d)},systemPrompt:{section(){}},typert:{register(){}},provide:(key,value)=>provided.set(key,value),effect:f=>f(),get:key=>services[key],emit:(...args)=>observed.push(args)};
  await apply(ctx,{stateDir,port:0,allowWrites:false});const bridge=provided.get('unrealBridge').bridge;
  t.after(async()=>{await bridge.close();await rm(stateDir,{recursive:true,force:true});});
  const ue=await editor(bridge);bridge.bind('chat','UE1');
  const exec={agent:{session:{id:'chat',requestHeader:()=>({config:{provider:'test',model:'active'}})}},name:'unreal_visual_compare',callId:'visual',signal:new AbortController().signal};
  return {tools,bridge,ue,stateDir,exec,fsCalls,observed,saved,attachmentStore,get approvals(){return approvals;}};
}

test('DSH visual tools use the filesystem service and preserve text fallback without write approval',async t=>{
  const f=await toolFixture(t),captureTool=f.tools.get('unreal_visual_capture'),compareTool=f.tools.get('unreal_visual_compare');
  const state=await f.tools.get('unreal_state').execute({},f.exec);assert.equal(state.visualTools.revision,2);assert.ok(state.visualTools.analyses.includes('color_distribution'));assert.equal(state.visualTools.signedZeroNormalized,true);
  const capture=await captureTool.execute({fullViewport:true},f.exec);assert.equal(capture.ok,true);assert.equal(capture.visualOutput.mode,'text');assert.equal(capture.visualOutput.reason.code,'MODEL_IMAGE_INPUT_UNSUPPORTED');
  const referencePath=join(f.stateDir,'input.png');await copyFile(capture.cropPath,referencePath);
  const result=await compareTool.execute({referencePath,captureId:capture.captureId,mode:'regression',alignmentConfirmed:true},f.exec);
  assert.equal(result.ok,true);assert.equal(result.verdict,'pass');assert.equal(result.visualOutput.mode,'text');assert.equal(f.saved.length,0);assert.equal(f.approvals,0);
  assert.deepEqual(f.fsCalls.map(call=>call.method),['resolve','stat','readBytes']);assert.equal(f.fsCalls[0].options.cwd,f.stateDir);assert.equal(f.fsCalls[2].limit,20*1024*1024);
  assert.equal(f.observed[0][0],'fs/observed');assert.equal(f.observed[0][1],referencePath);
  assert.ok(compareTool.output.render({},result).every(block=>block.type==='text'));
  assert.equal((await captureTool.execute({fullViewport:true},{})).error.code,'SESSION_REQUIRED');
});

test('DSH vision output stores bounded previews and renders durable references instead of bridge image bytes',async t=>{
  const f=await toolFixture(t,{modalities:['text','image']}),captureTool=f.tools.get('unreal_visual_capture'),compareTool=f.tools.get('unreal_visual_compare');
  const capture=await captureTool.execute({fullViewport:true},f.exec);assert.equal(capture.visualOutput.mode,'images');
  const referencePath=join(f.stateDir,'input.png');await copyFile(capture.cropPath,referencePath);
  const result=await compareTool.execute({referencePath,captureId:capture.captureId},f.exec);
  assert.equal(result.ok,true);assert.equal(result.verdict,'unknown');assert.equal(result.visualOutput.mode,'images');assert.equal(result.visualOutput.images.length,2);
  const blocks=compareTool.output.render({},result),images=blocks.filter(block=>block.type==='image');assert.equal(images.length,2);
  for(const block of images){assert.ok(block.attachment.attachmentId);assert.equal(block.data,undefined);assert.equal(block.attachment.data,undefined);assert.ok(block.attachment.width<=1600&&block.attachment.height<=1000);}
  assert.ok(f.saved.every(input=>Buffer.isBuffer(input.data)));assert.equal(f.ue.requests.length,1);assert.equal(f.approvals,0);
  assert.doesNotMatch(JSON.stringify(result),/base64|data:image/);
});

test('rebinding during attachment storage cannot return success for the previous editor',async t=>{
  const f=await toolFixture(t,{modalities:['text','image']}),captureTool=f.tools.get('unreal_visual_capture'),compareTool=f.tools.get('unreal_visual_compare');
  const capture=await captureTool.execute({fullViewport:true},f.exec),referencePath=join(f.stateDir,'input.png');await copyFile(capture.cropPath,referencePath);
  await editor(f.bridge,'B');
  const save=f.attachmentStore.saveImages.bind(f.attachmentStore);
  f.attachmentStore.saveImages=async inputs=>{const refs=await save(inputs);f.bridge.bind('chat','B');return refs;};
  const result=await compareTool.execute({referencePath,captureId:capture.captureId},f.exec);
  assert.equal(result.ok,false);assert.equal(result.error.code,'INSTANCE_CHANGED');
});

test('cancellation after attachment storage returns a stable CANCELLED code',async t=>{
  const f=await toolFixture(t,{modalities:['text','image']}),captureTool=f.tools.get('unreal_visual_capture'),compareTool=f.tools.get('unreal_visual_compare');
  const capture=await captureTool.execute({fullViewport:true},f.exec),referencePath=join(f.stateDir,'input.png');await copyFile(capture.cropPath,referencePath);
  const controller=new AbortController();f.exec.signal=controller.signal;
  const save=f.attachmentStore.saveImages.bind(f.attachmentStore);
  f.attachmentStore.saveImages=async inputs=>{const refs=await save(inputs);controller.abort();return refs;};
  const result=await compareTool.execute({referencePath,captureId:capture.captureId},f.exec);
  assert.equal(result.ok,false);assert.equal(result.error.code,'CANCELLED');
});
