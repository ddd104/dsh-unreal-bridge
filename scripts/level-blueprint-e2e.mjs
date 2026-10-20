// Builds no assets on disk: the native automation creates a synthetic in-memory
// map inside a disposable project, then this client only looks up and reads it.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/level-blueprint-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const projectPath=resolve(project),stateDir=resolve(stateRoot);
assert.ok(projectPath.replaceAll('\\','/').toLowerCase().includes('/.test-state/'),'Only disposable .test-state projects are permitted');
await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:45000}).start();
const checks=[],diagnostics=[],session='level-blueprint-e2e';
const pass=label=>{checks.push(label);console.log(`PASS: ${label}`);};
bridge.on('diagnostic',value=>diagnostics.push(value));
let child,exitCode,spawnError,report={status:'running',checks,projectPath};
const decode=result=>{
  assert.notEqual(result?.isError,true);
  const value=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
  return value.returnValue??value;
};
const deadline=Date.now()+180000;
const waitFor=async(predicate,label)=>{
  while(!await predicate()){
    if(spawnError)throw spawnError;
    if(exitCode!==undefined)throw new Error(`Editor exited ${exitCode} before ${label}`);
    if(Date.now()>deadline)throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done=>setTimeout(done,200));
  }
};
try{
  child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[
    projectPath,'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-NoAutoSave',
    '-DSHLevelBlueprintLookupFixture',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,
    '-ExecCmds=Automation RunTests DSH.Bridge.LevelBlueprintLookup',
    `-ReportExportPath=${join(stateDir,'native-report')}`,`-abslog=${join(stateDir,'editor.log')}`
  ],{windowsHide:true,stdio:'ignore'});
  child.once('error',error=>{spawnError=error;});
  child.once('exit',code=>{exitCode=code;});
  await waitFor(()=>bridge.list().length,'editor registration');
  bridge.bind(session,bridge.list()[0].editorId);
  assert.ok(bridge.target(session).capabilities.includes('level_blueprint_lookup'));
  pass('real UE advertises the read-only level Blueprint lookup capability');
  let native;
  await waitFor(async()=>{
    try{native=JSON.parse((await readFile(join(stateDir,'native-report/index.json'),'utf8')).replace(/^\uFEFF/,''));return native.inProcess===0&&native.tests?.length===2;}
    catch{return false;}
  },'native automation completion');
  assert.equal(native.failed,0,JSON.stringify(native.tests));
  assert.equal(native.succeeded,2);
  pass('native preservation and no-creation tests pass');

  const mapPath='/Game/DSHBridgeTests/Map_LevelLookup_Live';
  const before=await bridge.levelBlueprint(session,{mapPath});
  assert.equal(before.mapPath,`${mapPath}.Map_LevelLookup_Live`);
  assert.ok(before.blueprint.refPath.startsWith(`${before.mapPath}:PersistentLevel.`));
  assert.equal(before.saveTarget.refPath,before.mapPath);
  assert.ok(before.graphs.length>0);
  const again=await bridge.levelBlueprint(session,{mapPath:before.mapPath});
  assert.deepEqual(again,before);
  pass('package and object paths return one stable exact level Blueprint and map save target');

  const toolsetName='editor_toolset.toolsets.blueprint.BlueprintTools';
  const graphs=decode(await bridge.mcpCallToolset(session,{toolsetName,toolName:'list_graphs',arguments:{blueprint:before.blueprint},requestId:randomUUID()}));
  assert.ok(Array.isArray(graphs)&&graphs.length>0);
  const graph=graphs.find(item=>item.refPath===before.graphs[0].refPath)??graphs[0];
  const dsl=decode(await bridge.mcpCallToolset(session,{toolsetName,toolName:'read_graph_dsl',arguments:{graph},requestId:randomUUID()}));
  assert.equal(typeof dsl,'string');
  const after=await bridge.levelBlueprint(session,{mapPath});
  assert.deepEqual(after,before,'MCP inspection must preserve graphs, dirty state, and references');
  pass('existing BlueprintTools reads the returned level reference and graph without edits or saves');
  report={status:'passed',checkedAt:new Date().toISOString(),checks,diagnostics,editor:bridge.list()[0],
    nativeTests:native.tests.map(({fullTestPath,state})=>({name:fullTestPath,state})),lookup:before,mcpGraphCount:graphs.length,dslLength:dsl.length};
}catch(error){
  report={status:'failed',checkedAt:new Date().toISOString(),checks,diagnostics,error:{code:error.code,message:error.message,stack:error.stack}};
  process.exitCode=1;
}finally{
  if(child&&exitCode===undefined&&!spawnError){
    child.kill();
    await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,5000))]);
  }
  await bridge.close();
  await writeFile(join(stateDir,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:checks.length,result:join(stateDir,'result.json'),error:report.error?.message}));
}
