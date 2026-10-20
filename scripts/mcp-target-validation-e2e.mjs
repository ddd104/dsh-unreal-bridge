// Real UE preflight checks in a disposable HostProject. No model calls or asset saves.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {basename,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/mcp-target-validation-e2e.mjs <engine-root> <disposable-HostProject.uproject> <state-dir>');
const testRoot=await realpath(fileURLToPath(new URL('../.test-state/',import.meta.url)));
const contained=path=>{const part=relative(testRoot,path);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`);};
const projectPath=await realpath(resolve(project)),stateDir=resolve(stateRoot);
assert.ok(contained(projectPath),'Only projects inside this workspace .test-state are permitted');
assert.equal(basename(projectPath).toLowerCase(),'hostproject.uproject','Use the disposable HostProject, never an application project');
assert.ok(contained(stateDir),'The report directory must be inside this workspace .test-state');
await mkdir(stateDir,{recursive:true});
assert.ok(contained(await realpath(stateDir)),'The report directory must not resolve outside .test-state');

const runId=randomUUID().replaceAll('-','');
const nativeReport=join(stateDir,`native-report-${runId}`);
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:45000}).start();
const checks=[],diagnostics=[],rejections=[],session=`mcp-target-validation-${runId}`;
const blueprintTools='editor_toolset.toolsets.blueprint.BlueprintTools';
const dataTableTools='editor_toolset.toolsets.data_table.DataTableTools';
const pass=label=>{checks.push(label);console.log(`PASS: ${label}`);};
const redact=value=>String(value).replaceAll(bridge.token,'[redacted]');
bridge.on('diagnostic',value=>diagnostics.push(redact(value)));
const decode=result=>{
  assert.notEqual(result?.isError,true,JSON.stringify(result));
  const value=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
  return value.returnValue??value;
};
const call=(toolName,arguments_,requestId=randomUUID(),toolsetName=blueprintTools)=>bridge.mcpCallToolset(session,{toolsetName,toolName,arguments:arguments_,requestId});
const expectRejected=async(operation,code)=>{
  let rejected;
  await assert.rejects(operation,error=>{
    assert.equal(error.code,code);
    assert.equal(error.details?.execution,'not_started');
    assert.equal(error.details?.retryable,true);
    rejected={code:error.code,message:error.message,details:error.details};
    return true;
  });
  rejections.push(rejected);
  const state=bridge.state(session);
  assert.equal(state.connected,true,'A rejected target must not disconnect the editor');
  assert.equal(state.uncertain,null,'Preflight rejection must not create an uncertain write');
  assert.equal(state.writeLock,null,'Preflight rejection must not lock later writes');
};
const absent=async path=>{
  try{await stat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
  assert.fail(`Synthetic test asset must not exist on disk: ${path}`);
};
let child,exitCode,spawnError,report={status:'running',checks,projectPath};
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
  const testGroups=['DSH.Bridge.LevelBlueprintLookup','DSH.Bridge.PresentationSafety','DSH.Bridge.McpTargetValidation'];
  child=spawn(join(resolve(engine),'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[
    projectPath,'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound','-NoAutoSave',
    '-DSHLevelBlueprintLookupFixture',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,
    `-ExecCmds=Automation RunTests ${testGroups.join('+')}`,
    `-ReportExportPath=${nativeReport}`,`-abslog=${join(stateDir,'editor.log')}`
  ],{windowsHide:true,stdio:'ignore'});
  child.once('error',error=>{spawnError=error;});
  child.once('exit',(code,signal)=>{exitCode=code??signal??'unknown';});
  await waitFor(()=>bridge.list().length,'editor registration');
  const editor=bridge.list()[0];
  assert.equal(editor.pid,child.pid,'Only the editor launched by this check may be used');
  assert.equal((await realpath(editor.projectPath)).toLowerCase(),projectPath.toLowerCase());
  bridge.bind(session,editor.editorId);
  for(const capability of ['mcp_target_validation','safe_asset_presentation','level_blueprint_lookup'])assert.ok(editor.capabilities.includes(capability),`Missing capability ${capability}`);
  let native;
  await waitFor(async()=>{
    try{native=JSON.parse((await readFile(join(nativeReport,'index.json'),'utf8')).replace(/^\uFEFF/,''));return native.inProcess===0&&native.tests?.length>=9;}
    catch{return false;}
  },'native automation completion');
  assert.equal(native.failed,0,JSON.stringify(native.tests.filter(test=>test.state!=='Success').map(test=>({name:test.fullTestPath,state:test.state,errors:test.entries.filter(entry=>entry.event?.type==='Error').slice(0,3).map(entry=>entry.event.message)}))));
  const nativeTests=native.tests.map(({fullTestPath,state})=>({name:fullTestPath,state}));
  for(const [group,count] of [[testGroups[0],2],[testGroups[1],4],[testGroups[2],3]]){
    assert.equal(nativeTests.filter(test=>test.name.startsWith(`${group}.`)).length,count,`Expected ${count} tests for ${group}`);
  }
  assert.equal(native.succeeded,native.tests.length);
  pass('real UE advertises all safety capabilities and passes nine native preservation, presentation and preflight tests');

  const mapPath='/Game/DSHBridgeTests/Map_LevelLookup_Live';
  const mapDiskPath=join(projectPath,'..','Content','DSHBridgeTests','Map_LevelLookup_Live.umap');
  await absent(mapDiskPath);
  const before=await bridge.levelBlueprint(session,{mapPath});
  assert.equal(before.status,'available');
  assert.equal(before.saveTarget.refPath,before.mapPath);
  assert.ok(before.blueprint.refPath.startsWith(`${before.mapPath}:PersistentLevel.`));
  const graphName=`TargetValidation_${runId}`,requestId=randomUUID();
  await expectRejected(()=>call('add_function_graph',{blueprint:before.saveTarget,graph_name:graphName},requestId),'MCP_TARGET_TYPE_MISMATCH');
  assert.deepEqual(await bridge.levelBlueprint(session,{mapPath}),before,'Wrong World target must preserve map graphs, dirty state and exact references');
  pass('a World supplied as a Blueprint is rejected before execution without changing the map');

  const graph=decode(await call('add_function_graph',{blueprint:before.blueprint,graph_name:graphName},requestId));
  assert.ok(graph.refPath.startsWith(`${before.blueprint.refPath}.`));
  const after=await bridge.levelBlueprint(session,{mapPath});
  assert.equal(after.blueprint.refPath,before.blueprint.refPath);
  assert.equal(after.packageDirty,true);
  assert.equal(after.graphs.length,before.graphs.length+1);
  assert.ok(after.graphs.some(item=>item.name===graphName&&item.refPath===graph.refPath));
  for(const previous of before.graphs)assert.deepEqual(after.graphs.find(item=>item.refPath===previous.refPath),previous);
  const graphInventory=decode(await call('list_graphs',{blueprint:before.blueprint}));
  assert.ok(graphInventory.some(item=>item.refPath===graph.refPath));
  assert.deepEqual(await bridge.levelBlueprint(session,{mapPath}),after,'Inventory read must preserve the new graph and map state');
  await absent(mapDiskPath);
  pass('the same request UUID succeeds after correction to the exact level Blueprint and the new graph remains unsaved');

  await expectRejected(()=>call('get_schema',{data_table:before.saveTarget},randomUUID(),dataTableTools),'MCP_TARGET_TYPE_MISMATCH');
  const missing={refPath:`/Game/DSHBridgeTests/DT_Missing_${runId}.DT_Missing_${runId}`};
  await expectRejected(()=>call('get_schema',{data_table:missing},randomUUID(),dataTableTools),'MCP_TARGET_REFERENCE_UNRESOLVED');
  assert.deepEqual(await bridge.levelBlueprint(session,{mapPath}),after);
  pass('DataTable operations reject a World and a missing reference before native execution');

  const assetPath=`/Game/DSHBridgeTests/BP_TargetE2E_${runId}`;
  const blueprintDiskPath=join(projectPath,'..','Content','DSHBridgeTests',`BP_TargetE2E_${runId}.uasset`);
  await absent(blueprintDiskPath);
  const created=await bridge.apply(session,(await bridge.preview(session,'create',{assetPath,parent:'Actor'})).previewId,randomUUID());
  assert.equal(created.saved,false);
  const ordinaryRef={refPath:created.assetPath};
  const ordinaryGraphs=decode(await call('list_graphs',{blueprint:ordinaryRef}));
  assert.ok(ordinaryGraphs.length>0);
  const readOrdinary=()=>bridge.read(session,{assetPath,graph:'EventGraph',detail:'full'});
  const ordinaryBefore=await readOrdinary();
  await expectRejected(()=>call('get_schema',{data_table:ordinaryRef},randomUUID(),dataTableTools),'MCP_TARGET_TYPE_MISMATCH');
  await expectRejected(()=>call('get_node_infos',{nodes:[ordinaryRef]}),'MCP_TARGET_TYPE_MISMATCH');
  assert.deepEqual(await readOrdinary(),ordinaryBefore);
  await absent(blueprintDiskPath);
  pass('an ordinary Actor Blueprint remains supported while wrong DataTable and nested node types are rejected');

  // Inventory-based reads avoid find_node_types/read_graph_dsl, whose engine implementations can create temporary nodes.
  const ordinaryGraph=decode(await call('get_graph',{blueprint:ordinaryRef,graph_name:'EventGraph'}));
  const levelNodes=decode(await call('find_nodes',{graph,title:''}));
  const ordinaryNodes=decode(await call('find_nodes',{graph:ordinaryGraph,title:''}));
  assert.ok(levelNodes.length>0&&ordinaryNodes.length>0,'Both synthetic Blueprints must contain existing nodes for the ownership check');
  await expectRejected(()=>call('arrange_nodes',{nodes:[levelNodes[0],ordinaryNodes[0]]}),'MCP_TARGET_OWNER_MISMATCH');
  assert.deepEqual(await readOrdinary(),ordinaryBefore);
  assert.deepEqual(await bridge.levelBlueprint(session,{mapPath}),after);
  await absent(mapDiskPath);
  await absent(blueprintDiskPath);
  pass('nodes from different Blueprint owners cannot be arranged together and both assets stay unchanged and unsaved');
  report={status:'passed',checkedAt:new Date().toISOString(),projectPath,checks,diagnostics,nativeTests,nativeReport,rejections,
    levelBlueprint:{before,after,createdGraph:graph},ordinaryBlueprint:{assetPath:created.assetPath,saved:created.saved},editor};
}catch(error){
  report={status:'failed',checkedAt:new Date().toISOString(),projectPath,checks,diagnostics,rejections,nativeReport,
    error:{code:error.code,message:error.message,details:error.details,stack:error.stack}};
  process.exitCode=1;
}finally{
  if(child&&exitCode===undefined&&!spawnError){
    const exited=new Promise(done=>child.once('exit',done));
    child.kill();
    await Promise.race([exited,new Promise(done=>setTimeout(done,5000))]);
  }
  await bridge.close();
  await writeFile(join(stateDir,'result.json'),redact(JSON.stringify(report,null,2))+'\n');
  console.log(JSON.stringify({status:report.status,checks:checks.length,result:join(stateDir,'result.json'),error:report.error?.message}));
}
