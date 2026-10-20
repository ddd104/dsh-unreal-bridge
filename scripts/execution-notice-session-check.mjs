// Run with installed DSH Electron in Node mode (ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" scripts/execution-notice-session-check.mjs
//     [--runtime <dsh directory>] [--plugin <built or installed lib/index.js>]
//     [--profile <installed profile>] [--output <verification.json>]
// Uses the production AgentLoop, Session validator, and JSONL persistence in
// isolated temporary directories. The scripted LLM adapter makes no network
// requests; all tool bodies are synthetic and never touch an editor or shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {registerExecutionGuard} from '../src/execution-guard.mjs';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index];
  if(!['--runtime','--plugin','--profile','--output'].includes(key)||!process.argv[index+1])throw new Error('Expected --runtime, --plugin, --profile or --output followed by a path');
  args[key]=resolve(process.argv[index+1]);
}
const runtime=args['--runtime']??join(dirname(process.execPath),'resources','app.asar','dsh');
const runtimeRequire=createRequire(join(runtime,'package.json'));
const {Context}=runtimeRequire('@deepseek-ai/cordis');
const sessionModule=runtimeRequire('@deepseek-ai/dsh-session');
const {Session}=sessionModule;
const llmModule=runtimeRequire('@deepseek-ai/dsh-llm');
const {LlmAdapter,createUserMessage,createDeveloperMessage}=llmModule;
const persistencePlugin=runtimeRequire('@deepseek-ai/dsh-session-persistence-jsonl');
const plugin=(name,exportName)=>{const value=runtimeRequire(name);return value.default??value[exportName]??value;};
const versions=Object.fromEntries(['@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-persistence-jsonl'].map(name=>[
  name,JSON.parse(fs.readFileSync(join(runtime,'node_modules',name,'package.json'),'utf8')).version,
]));
const temporaryRoot=fs.mkdtempSync(join(tmpdir(),'dsh-execution-notice-'));
let loaderContext,bundleApply;
const textResponse=text=>[
  {type:'block-start',index:0,blockType:'text'},
  {type:'text-delta',index:0,text},
  {type:'block-end',index:0,block:{type:'text',text}},
  {type:'usage',usage:{inputTokens:5,outputTokens:5}},
  {type:'finish',reason:{kind:'stop'}},
];
const toolResponse=names=>[
  ...names.flatMap((name,index)=>[
    {type:'block-start',index,blockType:'tool-call'},
    {type:'block-end',index,block:{type:'tool-call',id:randomUUID(),name,arguments:'{}'}},
  ]),
  {type:'usage',usage:{inputTokens:5,outputTokens:5}},
  {type:'finish',reason:{kind:'tool-calls'}},
];
class OfflineAdapter extends LlmAdapter{
  requests=[];
  constructor(script){super();this.script=script;}
  async resolveModel(provider,model){return {provider,id:model,name:model};}
  async* stream(options){
    this.requests.push(options);
    const entry=this.script.shift();
    assert.ok(entry,'The real AgentLoop requested an unexpected extra sample');
    for(const chunk of typeof entry==='function'?entry(options):entry){
      options.signal?.throwIfAborted();yield chunk;
    }
  }
}
async function waitForIdle(ctx,agent,send){
  let remove,timer;
  try{
    await new Promise((done,reject)=>{
      remove=ctx.on('agent/status',({agent:subject,status})=>{if(subject===agent&&status==='idle')done();});
      timer=setTimeout(()=>reject(new Error('Real AgentLoop did not become idle within 15 seconds')),15000);
      send();
    });
  }finally{remove?.();clearTimeout(timer);}
}
const notices=events=>events.filter(event=>event.type==='user/message'&&event.data.source.kind==='unreal-execution-budget');
async function coldRestore(root,id,expected){
  const ctx=new Context();
  let handle;
  try{
    await ctx.plugin(persistencePlugin,{root,compression:'none'});
    handle=await ctx.sessionPersistence.open(id,'read');
    const stored=await handle.read();
    assert.deepEqual(stored.events,expected,'A cold JSONL read must preserve every actual loop event');
    const replay=Session.fromRestore(id,stored.events,handle.header,handle.inheritedEventCount,stored.eventState);
    assert.deepEqual(replay.snapshotEvents().slice(0,expected.length),expected);
    assert.equal(replay.snapshotEvents().at(-1).type,'session/end-seed','A real restore appends its canonical resume marker');
    assert.deepEqual(Session.create(id,stored.events,handle.header,handle.inheritedEventCount).deriveMessages(),replay.deriveMessages());
    return {eventCount:stored.events.length,noticeCount:notices(stored.events).length,replayedMessages:replay.deriveMessages().length};
  }finally{await handle?.close();await ctx.fiber.dispose();}
}
async function scenario(name,limits,script,expectedNotices,finalToolCount,expectedErrorCode=null){
  const ctx=new Context(),root=join(temporaryRoot,name),adapter=new OfflineAdapter(script);
  let guard,events,id,record;
  try{
    await ctx.plugin(plugin('@deepseek-ai/dsh-llm','LlmRuntime'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-session','SessionStore'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-session-projection','SessionProjectionRegistry'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-system-prompt','SystemPrompt'),{});
    await ctx.plugin(plugin('@deepseek-ai/dsh-tools','ToolRuntime'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-agent','AgentRegistry'));
    await ctx.plugin(persistencePlugin,{root,compression:'none'});
    await ctx.plugin(plugin('@deepseek-ai/dsh-agent-loop','AgentLoop'),{agents:[]});
    ctx.llm.registerAdapter(['notice-offline'],adapter);
    const guardConfig={guardMaxToolCalls:20,guardMaxSteps:20,guardMaxErrors:3,guardTimeoutMs:30000,...limits};
    if(bundleApply){
      ctx.provide('typert',{register(){}});
      await bundleApply(ctx,{port:0,stateDir:join(temporaryRoot,'bridge-state',name),requireApproval:false,...guardConfig});
    }else guard=registerExecutionGuard(ctx,guardConfig);
    const bodies=[];
    for(const toolName of ['unreal_fixture_read','unreal_fixture_error','unreal_fixture_write_error','unreal_fixture_corrected_write','unreal_fixture_rollback_failed','unreal_fixture_write_locked','unreal_state','unreal_request_status']){
      if(bundleApply&&['unreal_state','unreal_request_status'].includes(toolName))continue;
      ctx.tools.register({name:toolName,description:'Offline event persistence fixture',
        parameters:{type:'object',properties:{},additionalProperties:false},
        output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
        execute:async()=>{
          bodies.push(toolName);
          if(toolName==='unreal_fixture_error')return {ok:false,error:{code:'MCP_READ_ERROR',message:'Synthetic read failure',details:{rollback:'not_needed',retryable:true,recovery:'correct_and_retry'}}};
          if(toolName==='unreal_fixture_write_error')return {ok:false,error:{code:'MCP_TOOL_ERROR',message:'Synthetic write failure: preserve existing array entries',details:{rollback:'not_available',retryable:true,recovery:'verify_before_retry'}}};
          if(toolName==='unreal_fixture_rollback_failed')return {ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED',message:'Synthetic rollback could not be verified',details:{rollback:'failed',retryable:false}}};
          if(toolName==='unreal_fixture_write_locked')return {ok:false,error:{code:'EDITOR_WRITE_LOCKED',message:'Synthetic editor write lock',details:{rollback:'failed',retryable:false}}};
          return {ok:true};
        },
      });
    }
    id=`notice-${name}-${randomUUID()}`;
    const agent=await ctx.agentLoop.create(id,{provider:'notice-offline',model:'fixture'});
    await waitForIdle(ctx,agent,()=>agent.followup(createUserMessage({content:[{type:'text',text:'Run the offline notice regression'}],source:{kind:'user'}})));
    events=agent.session.snapshotEvents();
    const added=notices(events);
    assert.equal(added.length,expectedNotices,`${name} must persist the expected real pre-step notices`);
    for(const event of added){assert.equal(event.data.role,'user');assert.equal(event.data.source.form,'notice');}
    if(expectedErrorCode)assert.ok(added.some(event=>event.data.content.some(block=>block.type==='text'&&block.text.includes(expectedErrorCode))),`${name} must persist the original failure code in a model-visible notice`);
    assert.equal(events.filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed');
    const messages=agent.session.deriveMessages();
    const lastAssistant=messages.findLast(message=>message.role==='assistant');
    assert.ok(lastAssistant?.content.some(block=>block.type==='text'&&block.text===`Final ${name}`),'The real loop must reach its final text response');
    if(finalToolCount!==null)assert.equal(adapter.requests.at(-1).tools?.length??0,finalToolCount);
    assert.equal(adapter.script.length,0,'All planned responses must actually run');
    await ctx.sessionPersistence.flush();
    record={name,result:'PASS',samples:adapter.requests.length,notices:added.length,noticeRoles:[...new Set(added.map(event=>event.data.role))],finalToolSchemas:adapter.requests.at(-1).tools?.length??0,toolBodies:bodies,...(expectedErrorCode?{originalErrorCode:expectedErrorCode}: {})};
  }finally{guard?.dispose();await ctx.fiber.dispose();}
  return {...record,...await coldRestore(root,id,events),durableColdReplay:true};
}

try{
  if(args['--plugin']){
    const {createRuntimeResolution,PluginPackages}=runtimeRequire('@deepseek-ai/dsh-app-boot');
    loaderContext=new Context();
    const resolution=await createRuntimeResolution({installAnchor:join(runtime,'package.json'),home:join(homedir(),'.dsh'),profile:{dir:args['--profile']??join(homedir(),'.dsh','profiles','desktop'),layers:[],skippedBundles:[]}});
    new PluginPackages(loaderContext,{resolution});
    bundleApply=(await import(pathToFileURL(args['--plugin']).href)).apply;
  }
  const checks=[];
  const negative=Session.create(`notice-negative-${randomUUID()}`);
  const oldPayload=createDeveloperMessage({content:[{type:'text',text:'Previous invalid pre-step notice'}],source:{kind:'unreal-execution-budget',form:'notice',summary:'Budget warning'}});
  assert.throws(()=>negative.append('user/message',oldPayload,{surfaceOp:'append'}),/developer\/message and developer role must occur together/);
  assert.equal(negative.snapshotEvents().length,0,'Invalid role/event pairs must not enter the real Session log');
  checks.push({name:'old-developer-notice-rejected-by-real-session',result:'PASS',invalidRole:'developer',eventType:'user/message',mutatedEventCount:0});
  checks.push(await scenario('warning',{guardMaxToolCalls:5},[
    toolResponse(Array(4).fill('unreal_fixture_read')),textResponse('Final warning'),
  ],1,null));
  checks.push(await scenario('tool-calls',{guardMaxToolCalls:1},[
    toolResponse(['unreal_fixture_read']),toolResponse(['unreal_state','unreal_request_status']),textResponse('Final tool-calls'),
  ],2,0));
  checks.push(await scenario('errors',{guardMaxErrors:1},[
    toolResponse(['unreal_fixture_error']),toolResponse(['unreal_request_status']),textResponse('Final errors'),
  ],2,0));
  checks.push(await scenario('write-correction',{guardMaxErrors:50},[
    toolResponse(['unreal_fixture_write_error']),
    options=>{
      const visible=JSON.stringify(options.messages??[]);
      assert.ok(visible.includes('MCP_TOOL_ERROR'),'The production loop must send the original write failure back to the model');
      assert.ok(visible.includes('Synthetic write failure: preserve existing array entries'),'The correction sample must contain the original UE explanation');
      return toolResponse(['unreal_fixture_read']);
    },
    toolResponse(['unreal_fixture_corrected_write']),textResponse('Final write-correction'),
  ],1,null,'MCP_TOOL_ERROR'));
  checks.push(await scenario('rollback-failure',{},[
    toolResponse(['unreal_fixture_rollback_failed']),toolResponse(['unreal_state']),textResponse('Final rollback-failure'),
  ],2,0,'DATA_TABLE_ROLLBACK_FAILED'));
  checks.push(await scenario('write-lock',{},[
    toolResponse(['unreal_fixture_write_locked']),toolResponse(['unreal_state']),textResponse('Final write-lock'),
  ],2,0,'EDITOR_WRITE_LOCKED'));
  checks.push(await scenario('model-steps',{guardMaxSteps:1},[
    toolResponse(['unreal_fixture_read']),textResponse('Final model-steps'),
  ],1,0));
  const report={result:'PASS',checkedAt:new Date().toISOString(),runtime,node:process.versions.node,versions,checks,
    guardSource:args['--plugin']??'src/execution-guard.mjs',
    ...(args['--plugin']?{pluginSha256:createHash('sha256').update(fs.readFileSync(args['--plugin'])).digest('hex')}:{}),
    realAgentLoop:true,realSessionValidator:true,realJsonlPersistence:true,coldBackendReplay:true,
    networkRequests:0,realProfileAccess:args['--plugin']?'package resolution metadata only':false,realProfileWrites:false,realEditorAccess:false,realShellExecution:false};
  if(args['--output']){fs.mkdirSync(dirname(args['--output']),{recursive:true});fs.writeFileSync(args['--output'],`${JSON.stringify(report,null,2)}\n`);}
  console.log(JSON.stringify(report));
}finally{
  await loaderContext?.fiber.dispose();
  if(!resolve(temporaryRoot).startsWith(resolve(tmpdir())+sep)||!basename(temporaryRoot).startsWith('dsh-execution-notice-'))throw new Error('Refusing unexpected cleanup path');
  fs.rmSync(temporaryRoot,{recursive:true,force:true});
}
