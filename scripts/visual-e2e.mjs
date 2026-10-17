// Uses a rendered disposable editor, never the user's running project/profile.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {UnrealBridge} from '../src/bridge.mjs';
import {VisualService} from '../src/visual.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/visual-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const projectPath=resolve(project);
if(!projectPath.replaceAll('\\','/').toLowerCase().includes('/.test-state/'))throw new Error('Use a disposable .test-state project only');
const stateDir=resolve(stateRoot);await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:60000}).start();
const visual=new VisualService(bridge),checks=[];
const child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor.exe'),[projectPath,'-unattended','-RenderOffscreen','-windowed','-ResX=800','-ResY=600','-nosplash','-nop4','-nosound',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{stdio:'ignore',windowsHide:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const passed=label=>{checks.push(label);console.log(`PASS: ${label}`);};
try{
  const deadline=Date.now()+180000;
  while(!bridge.list().length){if(child.exitCode!==null)throw new Error(`Test editor exited ${child.exitCode}`);if(Date.now()>deadline)throw new Error('Editor registration timed out');await pause(250);}
  const instance=bridge.list()[0];assert.ok(instance.capabilities.includes('visual_capture'));bridge.bind('visual-e2e',instance.editorId);
  passed('real editor advertises visual capture');
  let capture;
  while(!capture){
    try{capture=await visual.capture('visual-e2e',{fullViewport:true});}
    catch(error){if(!['VIEWPORT_UNAVAILABLE','VIEWPORT_SIZE_INVALID','CAPTURE_READ_FAILED'].includes(error.code)||Date.now()>deadline)throw error;await pause(1000);}
  }
  const image=await sharp(capture.cropPath).metadata();assert.ok(image.width>32&&image.height>24);
  assert.equal(capture.source,'editor');assert.equal(capture.render.selectionOverlaysRemoved,true);
  const metadata=JSON.parse(await readFile(capture.metadataPath,'utf8'));assert.equal(metadata.camera.viewProjectionMatrix.length,4);
  passed('rendered viewport PNG and camera metadata cross the real bridge by path');
  const aligned=await visual.compare('visual-e2e',{referencePath:capture.cropPath,captureId:capture.captureId,mode:'regression',alignmentConfirmed:true});
  assert.equal(aligned.verdict,'pass');passed('captured reference passes confirmed regression at native resolution');
  const alteredPath=join(stateDir,'altered-reference.png');await sharp(capture.cropPath).negate().png().toFile(alteredPath);
  const altered=await visual.compare('visual-e2e',{referencePath:alteredPath,captureId:capture.captureId,mode:'regression',alignmentConfirmed:true,thresholds:{maxMeanDeltaE:0}});
  assert.equal(altered.verdict,'fail');assert.ok(altered.evidence.heatmap);passed('known rendered-image color change fails with heatmap evidence');
  const designPath=join(stateDir,'design-reference.png');await sharp(capture.cropPath).resize({width:97,height:73,fit:'fill'}).png().toFile(designPath);
  const advisory=await visual.compare('visual-e2e',{referencePath:designPath,captureId:capture.captureId,mode:'assessment'});
  assert.equal(advisory.verdict,'unknown');assert.deepEqual(advisory.metrics,{});assert.equal(advisory.evidence.heatmap,undefined);
  passed('external design dimensions remain unknown without manufactured pixel metrics');
  const region=await visual.capture('visual-e2e',{region:{x:1,y:2,width:32,height:24}});
  assert.equal((await sharp(region.cropPath).metadata()).width,32);assert.equal(region.crop.height,24);
  passed('explicit pixel region uses the current rendered viewport');
  await assert.rejects(visual.capture('visual-e2e',{targetPath:'/Game/Absent.Absent:PersistentLevel.Missing'}),{code:'TARGET_NOT_FOUND'});
  assert.equal(bridge.state('visual-e2e').uncertain,null);passed('invalid target fails without poisoning asset write state');
  const result={status:'passed',engine:instance.engineVersion,checks,capture,alignedReport:aligned.reportPath,alteredReport:altered.reportPath,assessmentReport:advisory.reportPath};
  await writeFile(join(stateDir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:'passed',tests:checks.length}));
}finally{child.kill();await bridge.close();}
