// Real UE contract checks against an existing disposable fixture. No asset writes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {UnrealBridge} from '../src/bridge.mjs';

const workspace=resolve(fileURLToPath(new URL('..',import.meta.url)));
const engine=process.argv[2]??'F:/EPIC/Engine58WithPDB/Engine58WithPDB/Windows';
const project=resolve(process.argv[3]??join(workspace,'.test-state/presentation-plugin-compiled/HostProject/HostProject.uproject'));
const stateDir=resolve(process.argv[4]??join(workspace,'.test-state/mcp-adapter-live'));
assert.ok(project.replaceAll('\\','/').toLowerCase().includes('/.test-state/'),'Only a disposable fixture is permitted');
assert.ok(stateDir.replaceAll('\\','/').toLowerCase().startsWith(workspace.replaceAll('\\','/').toLowerCase()+'/.test-state/'));
await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:45000,allowWrites:true}).start();
const session='mcp-adapter-live',toolsetName='editor_toolset.toolsets.data_table.DataTableTools';
const checks=[],diagnostics=[],dispatched=[];
let rawFailure,child,processFailure,exitCode,report={status:'running',startedAt:new Date().toISOString(),project,checks};
const pass=label=>{checks.push(label);console.log(`PASS: ${label}`);};
bridge.on('diagnostic',message=>diagnostics.push(message));
const originalRequest=bridge.request.bind(bridge);
bridge.request=async(editor,method,params,options)=>{
  if(method==='mcp_call_tool'){
    assert.equal(params.name,'call_tool');
    assert.equal(params.arguments.toolset_name,toolsetName);
    assert.ok(['get_schema','search_row_structs'].includes(params.arguments.tool_name),'Reject any asset write operation in this test');
    dispatched.push({toolset:params.arguments.toolset_name,tool:params.arguments.tool_name});
  }
  const result=await originalRequest(editor,method,params,options);
  if(method==='mcp_call_tool'&&(result?.isError===true||result?.ok===false))rawFailure=result;
  return result;
};
const invoke=(toolName,args)=>bridge.mcpCallToolset(session,{toolsetName,toolName,arguments:args,requestId:randomUUID()});
const decode=result=>result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
const strings=value=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
try{
  child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[
    project,'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound',
    `-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`
  ],{stdio:'ignore',windowsHide:true});
  child.once('error',error=>{processFailure=error;});
  child.once('exit',code=>{exitCode=code;});
  const deadline=Date.now()+150000;
  while(!bridge.list().length){
    if(processFailure)throw processFailure;
    if(exitCode!==undefined)throw new Error(`Fixture editor exited ${exitCode} before registration`);
    if(Date.now()>deadline)throw new Error('Fixture editor registration timed out');
    await new Promise(done=>setTimeout(done,200));
  }
  bridge.bind(session,bridge.list()[0].editorId);
  const description=decode(await bridge.mcpDescribe(session,{toolsetName,query:'get_schema',includeSchema:true}));
  const tool=description.tools.find(item=>item.name==='get_schema');
  assert.ok(tool,'Discovery must expose callable short names');
  assert.equal(tool.fullName,`${toolsetName}.get_schema`);
  assert.ok(tool.inputSchema.required.includes('data_table'));
  assert.ok(tool.inputSchema.properties.data_table.required.includes('refPath'));
  pass('real UE description retains fullName and schema while exposing the short callable name');

  const beforeInvalid=dispatched.length;
  let invalid;
  await assert.rejects(invoke(`${toolsetName}.get_schema`,{dataTablePath:'/Game/DSHBridgeTests/NoSuchTable'}),error=>{
    invalid=error;
    return error.code==='MCP_INVALID_ARGUMENTS';
  });
  assert.equal(dispatched.length,beforeInvalid,'Invalid arguments must not reach UE call_tool');
  assert.match(JSON.stringify({message:invalid.message,details:invalid.details}),/data_table/);
  pass('the original wrong dataTablePath parameter is rejected locally with the expected data_table schema');

  let readError;
  await assert.rejects(invoke(`${toolsetName}.get_schema`,{data_table:{refPath:'/Game/DSHBridgeTests/NoSuchTable_McpAdapter.NoSuchTable_McpAdapter'}}),error=>{
    readError=error;
    return error.code==='MCP_TARGET_REFERENCE_UNRESOLVED'&&error.details?.execution==='not_started';
  });
  assert.equal(rawFailure,undefined,'The native target guard must reject missing assets before invoking the actual tool');
  const originalText=readError.message;
  assert.ok(originalText?.length,'Native validation errors must contain a diagnostic');
  assert.equal(dispatched.at(-1).tool,'get_schema','The full name must normalize before dispatch');
  assert.equal(bridge.state(session).writeLock,null);
  pass('a full discovered name reaches native target validation once and rejects a missing table before execution');

  const success=await invoke(`${toolsetName}.search_row_structs`,{struct_name:'*'});
  assert.notEqual(success.isError,true);
  const structs=decode(success);
  assert.ok(Array.isArray(structs.returnValue??structs));
  assert.equal(dispatched.at(-1).tool,'search_row_structs');
  pass('the same session performs a successful read after the read failure');
  const editorLog=await readFile(join(stateDir,'editor.log'),'utf8');
  assert.ok(!editorLog.includes(`${toolsetName}.${toolsetName}.`),'UE dispatch must have no repeated toolset prefix');
  report={...report,status:'passed',finishedAt:new Date().toISOString(),editor:bridge.list()[0],dispatched,
    invalid:{code:invalid.code,message:invalid.message},readError:{code:readError.code,originalText},
    successfulStructCount:(structs.returnValue??structs).length,diagnostics};
}catch(error){
  report={...report,status:'failed',finishedAt:new Date().toISOString(),dispatched,diagnostics,error:{code:error.code,message:error.message,stack:error.stack}};
  process.exitCode=1;
}finally{
  if(child&&exitCode===undefined&&!processFailure){
    child.kill();
    await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,5000))]);
  }
  await bridge.close();
  await writeFile(join(stateDir,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:checks.length,result:join(stateDir,'result.json'),error:report.error?.message}));
}
