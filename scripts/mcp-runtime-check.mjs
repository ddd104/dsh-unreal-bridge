// Run with installed DSH Electron in Node mode (ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" scripts/mcp-runtime-check.mjs
//     [--runtime <dsh directory>] [--profile <installed profile>]
//     [--plugin <built or installed lib/index.js>] [--output <verification.json>]
// Uses the real profile's package resolver and ToolRuntime with a synthetic
// loopback editor. No model, real editor, desktop input, or profile writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir,homedir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index];
  if(!['--runtime','--profile','--plugin','--output'].includes(key)||!process.argv[index+1])throw new Error('Expected --runtime, --profile, --plugin or --output followed by a path');
  args[key]=resolve(process.argv[index+1]);
}
const runtime=args['--runtime']??join(dirname(process.execPath),'resources','app.asar','dsh');
const profile=args['--profile']??join(homedir(),'.dsh','profiles','desktop');
const plugin=args['--plugin']??resolve('lib/index.js');
const runtimeRequire=createRequire(join(runtime,'package.json'));
const {Context}=runtimeRequire('@deepseek-ai/cordis');
const {ToolRuntime}=runtimeRequire('@deepseek-ai/dsh-tools');
const {scopeTarget}=runtimeRequire('@deepseek-ai/dsh-scope');
const {snapshotJsonValue}=runtimeRequire('@deepseek-ai/dsh-util-values');
const {createRuntimeResolution,PluginPackages}=runtimeRequire('@deepseek-ai/dsh-app-boot');
const versions=Object.fromEntries(['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-util-values'].map(name=>[
  name,JSON.parse(fs.readFileSync(join(runtime,'node_modules',name,'package.json'),'utf8')).version,
]));
const loaderContext=new Context();
const tempRoot=fs.mkdtempSync(join(tmpdir(),'dsh-mcp-runtime-'));
let context;
try{
  const resolution=await createRuntimeResolution({installAnchor:join(runtime,'package.json'),home:join(homedir(),'.dsh'),profile:{dir:profile,layers:[],skippedBundles:[]}});
  new PluginPackages(loaderContext,{resolution});
  const {apply}=await import(pathToFileURL(plugin).href);
  const {WebSocket}=createRequire(plugin)('ws');
  context=new Context();
  context.provide('systemPrompt',{tools(){},section(){}});
  context.provide('typert',{register(){}});
  const tools=new ToolRuntime(context);
  await apply(context,{port:0,stateDir:join(tempRoot,'bridge'),requireApproval:false});
  const bridge=context.unrealBridge.bridge;
  const checks=[];

  // Confirm that the real installed gate rejects an optional undefined field.
  const badValue={ok:false,error:{code:'MCP_READ_ERROR',message:'Synthetic UE error',details:{requestId:undefined}}};
  assert.equal(snapshotJsonValue(badValue),undefined);
  tools.register({name:'mcp_undefined_output_fixture',description:'Offline lossless JSON rejection fixture',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>badValue});
  const before=await tools.execute({name:'mcp_undefined_output_fixture',arguments:{},callId:randomUUID(),signal:new AbortController().signal});
  assert.equal(before.isError,true);assert.equal(before.error.info.code,'INVALID_TOOL_OUTPUT');
  assert.match(before.error.message,/lossless JSON/);
  checks.push({name:'installed-runtime-rejects-undefined-error-details',result:'PASS',code:before.error.info.code});

  const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
  const OBJECT='editor_toolset.toolsets.object.ObjectTools';
  const inputSchema={type:'object',properties:{data_table:{type:'object',properties:{refPath:{type:'string'}},required:['refPath'],additionalProperties:false}},required:['data_table']};
  const describe=tool=>({content:[{type:'text',text:JSON.stringify({tools:[{name:`${DATA_TABLE}.${tool}`,inputSchema}]})}]});
  const objectSchema={type:'object',properties:{object:{type:'object',properties:{refPath:{type:'string'}},required:['refPath'],additionalProperties:false}},required:['object']};
  const objectDescription={content:[{type:'text',text:JSON.stringify({tools:[
    {name:`${OBJECT}.get_properties`,inputSchema:objectSchema},
    {name:`${OBJECT}.set_properties`,inputSchema:{...objectSchema,properties:{...objectSchema.properties,handlers:{type:'array',items:{type:'string'}}},required:['object','handlers']}},
  ]})}]};
  let handlers=['ExistingHandlerA','ExistingHandlerB'];
  const writeError={isError:true,content:[{type:'text',text:'Array append rejected: existing entries also changed, so insertion position is ambiguous'}]};
  const ueError={isError:true,content:[{type:'text',text:'资产不存在 / DataTable not found: /Game/Missing'}]};
  const socket=new WebSocket(bridge.descriptor.url,{headers:{Authorization:`Bearer ${bridge.token}`}});
  await once(socket,'open');const ack=once(socket,'message');
  socket.send(JSON.stringify({type:'hello',protocol:1,editorId:'offline-editor',project:'OfflineMcpRuntime',projectPath:tempRoot,engineVersion:'5.8',pid:42,capabilities:['mcp_tools','mcp_target_validation']}));await ack;
  const dispatches=[];
  socket.on('message',raw=>{
    const message=JSON.parse(raw);if(message.type!=='request')return;
    let result;
    if(message.method==='mcp_discover'){
      const toolset=message.params.arguments.toolset_name;
      result=toolset==='BadDescription'?{content:[{type:'text',text:'not JSON'}]}:toolset==='FailedDescription'?ueError:toolset===OBJECT?objectDescription:describe('get_schema');
    }else if(message.method==='mcp_list_tools')result={tools:[]};
    else{
      dispatches.push(message);
      const {toolset_name:toolset,tool_name:tool,arguments:parameters}=message.params.arguments;
      if(toolset===OBJECT){
        if(tool==='get_properties')result={handlers:[...handlers]};
        else if(handlers.some((value,index)=>parameters.handlers[index]!==value))result=writeError;
        else{handlers=[...parameters.handlers];result={handlers:[...handlers],saved:false};}
      }else result=parameters.data_table.refPath==='/Game/Missing'?ueError:{schema:{rowStruct:'FObstacle'}};
    }
    socket.send(JSON.stringify({type:'response',id:message.id,ok:true,result}));
  });
  let sequence=0;
  const fixture=id=>{
    const controller=new AbortController(),cancellations=[];
    const agent={session:{id},cancel(source,options){cancellations.push({source,options});controller.abort();}};
    bridge.bind(id,'offline-editor');
    context.emit(scopeTarget(context,agent),'session/event',agent.session,{type:'turn/start',seq:++sequence,data:{turn:1},time:Date.now()});
    context.emit(scopeTarget(context,agent),'session/event',agent.session,{type:'step/start',seq:++sequence,data:{turn:1,step:1},time:Date.now()});
    const execute=(name,arguments_)=>tools.execute({name,arguments:arguments_,callId:randomUUID(),agent,signal:controller.signal});
    return {execute,cancellations,controller};
  };
  const callArgs=(path='/Game/Found')=>({toolsetName:DATA_TABLE,toolName:`${DATA_TABLE}.get_schema`,arguments:{data_table:{refPath:path}},requestId:randomUUID()});
  const checkedError=(result,code,text)=>{
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.equal(result.value.ok,false);assert.equal(result.value.error.code,code);
    assert.notEqual(snapshotJsonValue(result.value),undefined);
    assert.deepEqual(result.value,JSON.parse(JSON.stringify(result.value)));
    const rendered=result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
    assert.ok(rendered.includes(code),rendered);
    if(text){assert.equal(result.value.error.message,text);assert.ok(rendered.includes(text),rendered);}
  };

  const read=fixture('offline-read-correction');
  const failed=await read.execute('unreal_mcp_call_toolset',callArgs('/Game/Missing'));
  checkedError(failed,'MCP_READ_ERROR',ueError.content[0].text);
  assert.deepEqual(failed.value.error.details.ueResult,ueError);
  assert.equal(failed.value.error.details.retryable,true);
  assert.equal(failed.value.error.details.recovery,'correct_and_retry');
  assert.equal(failed.value.executionSafety.errors,1);
  assert.equal(read.cancellations.length,0);assert.equal(read.controller.signal.aborted,false);
  const corrected=await read.execute('unreal_mcp_call_toolset',callArgs());
  assert.equal(corrected.isError,false,JSON.stringify(corrected));assert.equal(corrected.value.ok,true);assert.equal(corrected.value.schema.rowStruct,'FObstacle');
  checks.push({name:'real-tool-runtime-read-error-render-and-corrected-call',result:'PASS',errorCode:'MCP_READ_ERROR',originalUeTextPreserved:true,cancellations:0});

  const write=fixture('offline-write-correction'),beforeWrite=dispatches.length;
  const objectCall=(toolName,parameters)=>({toolsetName:OBJECT,toolName,arguments:{object:{refPath:'/Game/Offline/BP_Handler.BP_Handler_C:DefaultObject'},...parameters},requestId:randomUUID()});
  const attempted=objectCall('set_properties',{handlers:['ChangedExistingHandler','ExistingHandlerB','NewHandlerC']});
  const rejected=await write.execute('unreal_mcp_call_toolset',attempted);
  checkedError(rejected,'MCP_TOOL_ERROR',writeError.content[0].text);
  assert.deepEqual(rejected.value.error.details.ueResult,writeError);
  assert.equal(rejected.value.error.details.retryable,true);
  assert.equal(rejected.value.error.details.rollback,'not_available');
  assert.equal(rejected.value.error.details.recovery,'verify_before_retry');
  assert.equal(rejected.value.executionSafety.errors,1);
  assert.equal(rejected.value.executionSafety.lastError.code,'MCP_TOOL_ERROR');
  assert.equal(write.cancellations.length,0);assert.equal(write.controller.signal.aborted,false);
  const readback=await write.execute('unreal_mcp_call_toolset',objectCall('get_properties'));
  assert.equal(readback.isError,false);assert.equal(readback.value.ok,true);
  assert.deepEqual(readback.value.handlers,['ExistingHandlerA','ExistingHandlerB']);
  const correctedWrite=objectCall('set_properties',{handlers:[...readback.value.handlers,'NewHandlerC']});
  assert.notEqual(correctedWrite.requestId,attempted.requestId,'a corrected completed failure is a new logical request');
  const completed=await write.execute('unreal_mcp_call_toolset',correctedWrite);
  assert.equal(completed.isError,false);assert.equal(completed.value.ok,true);
  assert.deepEqual(completed.value.handlers,['ExistingHandlerA','ExistingHandlerB','NewHandlerC']);
  assert.equal(completed.value.saved,false);
  const writeState=await write.execute('unreal_state',{});
  assert.equal(writeState.value.executionSafety.errors,1);
  assert.equal(writeState.value.executionSafety.halted,false);
  assert.equal(writeState.value.executionSafety.budgetExhausted,false);
  assert.equal(dispatches.length-beforeWrite,3);
  checks.push({name:'real-tool-runtime-write-error-readback-and-corrected-array-append',result:'PASS',errorCode:'MCP_TOOL_ERROR',originalUeTextPreserved:true,recovery:'verify_before_retry',failedWrites:1,readbacks:1,correctedWrites:1,preservedExistingEntries:true,saved:false,cancellations:0});

  const preflight=fixture('offline-preflight-correction'),beforePreflight=dispatches.length;
  checkedError(await preflight.execute('unreal_mcp_call_toolset',{...callArgs(),arguments:{dataTablePath:'/Game/Found'}}),'MCP_INVALID_ARGUMENTS');
  checkedError(await preflight.execute('unreal_mcp_call_toolset',{...callArgs(),requestId:'invalid-id'}),'MCP_INVALID_ARGUMENTS');
  assert.equal(dispatches.length,beforePreflight);
  assert.equal((await preflight.execute('unreal_mcp_call_toolset',callArgs())).value.ok,true);
  assert.equal(preflight.cancellations.length,0);
  checks.push({name:'local-argument-errors-pass-output-schema-and-render-without-dispatch',result:'PASS',errorCode:'MCP_INVALID_ARGUMENTS',cancellations:0});

  const absent=fixture('offline-top-level-not-found');
  checkedError(await absent.execute('unreal_mcp_call',{name:'missing_top_level_tool',arguments:{},requestId:randomUUID()}),'MCP_TOOL_NOT_FOUND');
  assert.equal(absent.cancellations.length,0);
  checks.push({name:'top-level-not-found-omits-undefined-toolset',result:'PASS',errorCode:'MCP_TOOL_NOT_FOUND',cancellations:0});

  const discovery=fixture('offline-discovery-failures');
  checkedError(await discovery.execute('unreal_mcp_describe',{toolsetName:'BadDescription'}),'MCP_DESCRIPTION_UNPARSEABLE');
  const failedDescription=await discovery.execute('unreal_mcp_describe',{toolsetName:'FailedDescription'});
  checkedError(failedDescription,'MCP_READ_ERROR',ueError.content[0].text);
  assert.equal(failedDescription.value.error.details.requestId,null);
  assert.equal(discovery.cancellations.length,0);
  checks.push({name:'discovery-error-with-no-request-id-remains-lossless-json',result:'PASS',requestId:null,cancellations:0});

  const level=fixture('offline-level-capability'),beforeLevel=dispatches.length;
  const state=await level.execute('unreal_state',{});
  assert.deepEqual(state.value.executionSafety.limits,{guardMaxToolCalls:300,guardMaxSteps:200,guardMaxErrors:50,guardTimeoutMs:1800000});
  assert.equal(state.value.blueprintSupport.levelBlueprintLookup,false);
  checkedError(await level.execute('unreal_level_blueprint',{mapPath:'/Game/Maps/Map_Test'}),'LEVEL_BLUEPRINT_LOOKUP_UNAVAILABLE');
  checkedError(await level.execute('unreal_read_blueprint',{assetPath:'/Game/Maps/Map_Test.Map_Test:PersistentLevel.Map_Test'}),'LEVEL_BLUEPRINT_REQUIRES_LOOKUP');
  assert.equal(dispatches.length,beforeLevel);assert.equal(level.cancellations.length,0);
  checks.push({name:'installed-default-budget-and-old-editor-level-capability-are-actionable',result:'PASS',toolBudget:300,modelStepBudget:200,errorBudget:50,timeoutMs:1800000,cancellations:0});

  const record={result:'PASS',checkedAt:new Date().toISOString(),node:process.versions.node,runtime,versions,plugin,
    pluginSha256:createHash('sha256').update(fs.readFileSync(plugin)).digest('hex'),checks,
    providerRequests:0,realProfileAccess:'package resolution metadata only',realProfileWrites:false,realEditorAccess:false,realDesktopInput:false};
  if(args['--output']){fs.mkdirSync(dirname(args['--output']),{recursive:true});fs.writeFileSync(args['--output'],`${JSON.stringify(record,null,2)}\n`);}
  console.log(JSON.stringify(record));
}finally{
  await context?.fiber.dispose();
  await loaderContext.fiber.dispose();
  if(!resolve(tempRoot).startsWith(resolve(tmpdir())+sep)||!basename(tempRoot).startsWith('dsh-mcp-runtime-'))throw new Error('Refusing unexpected cleanup path');
  fs.rmSync(tempRoot,{recursive:true,force:true});
}
