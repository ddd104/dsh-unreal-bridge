// Starts real PIE only in a disposable fixture. Never run this against a production project.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/runtime-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const projectPath=resolve(project);
if(!projectPath.replaceAll('\\','/').toLowerCase().includes('/.test-state/'))throw new Error('Use a disposable .test-state project only');
const stateDir=resolve(stateRoot);await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:10000,allowWrites:false}).start();
const checks=[],diagnostics=[];
bridge.on('diagnostic',message=>diagnostics.push(message));
const child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor.exe'),[
  projectPath,'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-DSHRuntimePIETest',
  `-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`,
  '-ExecCmds=Automation RunTests DSH.Bridge.RuntimePIEIntegration','-TestExit=Automation Test Queue Empty'
],{stdio:'ignore',windowsHide:true});
let exitCode;
child.on('exit',code=>{exitCode=code;});
const passed=label=>{checks.push(label);console.log(`PASS: ${label}`);};
const waitFor=async(predicate,label)=>{
  const deadline=Date.now()+150000;
  while(!predicate()){
    if(exitCode!==undefined)throw new Error(`Editor exited (${exitCode}) before ${label}`);
    if(Date.now()>deadline)throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
};
try{
  await waitFor(()=>bridge.list().length,'bridge connection');
  const editor=bridge.list()[0];assert.ok(editor.capabilities.includes('runtime_inspection'));
  bridge.bind('runtime-e2e',editor.editorId);
  passed('real editor advertises runtime inspection');
  await waitFor(()=>bridge.state('runtime-e2e').selection.some(item=>item.label==='DSHRuntime_First'&&item.runtime),'first PIE actor selection');
  const first=await bridge.runtimeSnapshot('runtime-e2e');
  assert.equal(first.kind,'actor');assert.equal(first.runtimeEvidence,true);assert.equal(first.status,'available');
  assert.ok(first.components.some(component=>component.name==='RuntimeFixtureComponent'&&component.visible===false));
  passed('real PIE actor selection and component state captured over the bridge with writes disabled');
  await waitFor(()=>bridge.state('runtime-e2e').selection.some(item=>item.name==='RuntimeFixtureComponent'&&item.runtime),'PIE component selection');
  const component=await bridge.runtimeSnapshot('runtime-e2e',{includeComponents:false});
  assert.equal(component.kind,'component');assert.equal(component.paused,true);assert.equal(component.visible,false);
  assert.equal(bridge.state('runtime-e2e').runtime.status,'paused');
  assert.equal(component.target.playSessionId,first.target.playSessionId);
  passed('paused PIE component resolves to the same run and its own instance');
  await waitFor(()=>bridge.runtimeHistory('runtime-e2e',{snapshotId:first.snapshotId}).status==='expired','actor destruction invalidation');
  assert.equal(bridge.runtimeHistory('runtime-e2e',{snapshotId:first.snapshotId}).reason,'actor_destroyed');
  passed('actor destruction invalidates the handle while preserving sampled evidence');
  await waitFor(()=>bridge.state('runtime-e2e').selection.some(item=>item.label==='DSHRuntime_Second'&&item.runtime),'second PIE actor selection');
  const second=await bridge.runtimeSnapshot('runtime-e2e');
  assert.notEqual(second.target.playSessionId,first.target.playSessionId);
  assert.notEqual(second.target.objectId,first.target.objectId);
  assert.equal(second.path,first.path);
  await assert.rejects(bridge.runtimeSnapshot('runtime-e2e',{target:{playSessionId:first.target.playSessionId,worldId:first.target.worldId,objectId:first.target.objectId}}),{code:'RUNTIME_TARGET_EXPIRED'});
  passed('restarting PIE reuses the fixture path without reviving the old target');
  await waitFor(()=>bridge.runtimeHistory('runtime-e2e',{snapshotId:second.snapshotId}).status==='expired','PIE end invalidation');
  assert.equal(bridge.state('runtime-e2e').runtime.status,'stopped');
  passed('EndPIE clears the active run without disconnecting the bridge');
  await waitFor(()=>exitCode!==undefined,'editor automation completion');
  assert.equal(exitCode,0);
  const log=await readFile(join(stateDir,'editor.log'),'utf8');
  assert.match(log,/Result=\{Success\}.*RuntimePIEIntegration/);
  assert.equal(bridge.runtimeHistory('runtime-e2e',{snapshotId:first.snapshotId}).path,first.path);
  assert.deepEqual(diagnostics,[]);
  passed('native automation passes and historical evidence remains readable after editor exit');
  await writeFile(join(stateDir,'result.json'),JSON.stringify({checks,diagnostics,first,component,second},null,2));
}finally{
  if(exitCode===undefined)child.kill();
  await bridge.close();
}
