// Read-only MCP integration check. Run only against a disposable UE project.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/ue-mcp-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const stateDir=resolve(stateRoot);
await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:60000}).start();
bridge.on('diagnostic',message=>console.log(message));
const child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[resolve(project),'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{stdio:'ignore',windowsHide:true});

try{
  const deadline=Date.now()+180000;
  while(!bridge.list().length){
    if(child.exitCode!==null)throw new Error(`Editor exited ${child.exitCode}`);
    if(Date.now()>deadline)throw new Error('Editor registration timed out');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  bridge.bind('mcp-e2e',bridge.list()[0].editorId);
  const tools=await bridge.mcpTools('mcp-e2e');
  for(const name of ['list_toolsets','describe_toolset','call_tool'])assert.ok(tools.tools.some(tool=>tool.name===name),`Missing MCP tool ${name}`);
  console.log('PASS: UE MCP tools discovered in the bound editor');

  const toolsets=await bridge.mcpToolsets('mcp-e2e');
  assert.notEqual(toolsets.isError,true);
  assert.match(JSON.stringify(toolsets),/EditorAppToolset/);
  const description=await bridge.mcpDescribe('mcp-e2e',{toolsetName:'EditorToolset.EditorAppToolset'});
  assert.match(JSON.stringify(description),/GetSelectedAssets/);
  const assetDescription=await bridge.mcpDescribe('mcp-e2e',{toolsetName:'editor_toolset.toolsets.asset.AssetTools'});
  assert.notEqual(assetDescription.isError,true);
  const assetTools=JSON.parse(assetDescription.content.find(item=>item.type==='text').text).tools;
  for(const name of ['find_assets','create_folder','exists','delete','move'])assert.ok(assetTools.some(tool=>tool.name.endsWith(`.${name}`)),`Missing asset MCP operation ${name}`);
  console.log('PASS: UE MCP toolset discovery and schema description');

  const requestId=randomUUID();
  const result=await bridge.mcpCallToolset('mcp-e2e',{toolsetName:'editor_toolset.toolsets.asset.AssetTools',toolName:'find_assets',arguments:{folder_path:'/Game',name:'',recursive:true},requestId});
  assert.notEqual(result.isError,true);
  assert.ok(Array.isArray(result.content));
  assert.equal((await bridge.requestStatus('mcp-e2e',requestId)).status,'completed');
  console.log('PASS: direct asset search MCP call and request status');
  const folder=`/Game/DSHBridgeMCP_${randomUUID().replaceAll('-','')}`;
  const movedFolder=`${folder}_Moved`;
  const invoke=(toolName,arguments_)=>bridge.mcpCallToolset('mcp-e2e',{toolsetName:'editor_toolset.toolsets.asset.AssetTools',toolName,arguments:arguments_,requestId:randomUUID()});
  const created=await invoke('create_folder',{path:folder});
  assert.notEqual(created.isError,true);
  let currentFolder=folder;
  try{
    const exists=await invoke('exists',{path:folder});
    assert.notEqual(exists.isError,true);
    assert.match(JSON.stringify(exists),/true/);
    const moved=await invoke('move',{path:folder,new_path:movedFolder});
    assert.notEqual(moved.isError,true);
    assert.match(JSON.stringify(moved),/true/);
    currentFolder=movedFolder;
    const existsAfterMove=await invoke('exists',{path:movedFolder});
    assert.match(JSON.stringify(existsAfterMove),/true/);
  }finally{
    const deleted=await invoke('delete',{path:currentFolder});
    assert.notEqual(deleted.isError,true);
  }
  console.log('PASS: direct UE MCP create, query, move and delete on a disposable folder');
  await assert.rejects(
    bridge.mcpCallToolset('mcp-e2e',{toolsetName:'editor_toolset.toolsets.programmatic.ProgrammaticToolset',toolName:'execute_tool_script',arguments:{},requestId:randomUUID()}),
    error=>error.code==='MCP_UNAVAILABLE'&&/disabled/.test(error.message));
  console.log('PASS: script-execution MCP tool is blocked');
}finally{
  child.kill();
  await bridge.close();
}
