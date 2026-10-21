// Run with the installed DSH Electron in Node mode (ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" scripts/model-recovery-session-check.mjs
//     [--runtime <dsh directory>] [--plugin <built or installed lib/index.js>]
//     [--profile <installed profile>] [--output <verification.json>]
// Uses the production AgentLoop, Session validator and JSONL persistence with
// an offline adapter and synthetic tools. No network requests or editor access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {registerExecutionGuard} from '../src/execution-guard.mjs';
import {registerModelRecovery} from '../src/model-recovery.mjs';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index];
  if(!['--runtime','--plugin','--profile','--output'].includes(key)||!process.argv[index+1])throw new Error('Expected --runtime, --plugin, --profile or --output followed by a path');
  args[key]=resolve(process.argv[index+1]);
}
const runtime=args['--runtime']??join(dirname(process.execPath),'resources','app.asar','dsh');
const runtimeRequire=createRequire(join(runtime,'package.json'));
const {Context}=runtimeRequire('@deepseek-ai/cordis');
const {Session}=runtimeRequire('@deepseek-ai/dsh-session');
const {LlmAdapter,createUserMessage}=runtimeRequire('@deepseek-ai/dsh-llm');
const persistencePlugin=runtimeRequire('@deepseek-ai/dsh-session-persistence-jsonl');
const plugin=(name,exportName)=>{const value=runtimeRequire(name);return value.default??value[exportName]??value;};
const versions=Object.fromEntries(['@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-persistence-jsonl'].map(name=>[
  name,JSON.parse(fs.readFileSync(join(runtime,'node_modules',name,'package.json'),'utf8')).version,
]));
const temporaryRoot=fs.mkdtempSync(join(tmpdir(),'dsh-model-recovery-'));
const SOURCE='unreal-model-recovery';
const MALFORMED={code:'MALFORMED_RESPONSE',message:'DeepSeek Messages stream: tool input is invalid JSON'};
let loaderContext,bundleApply;
const notices=events=>events.filter(event=>event.type==='user/message'&&event.data.source.kind===SOURCE);
const textResponse=text=>[
  {type:'block-start',index:0,blockType:'text'},
  {type:'text-delta',index:0,text},
  {type:'block-end',index:0,block:{type:'text',text}},
  {type:'usage',usage:{inputTokens:5,outputTokens:5}},
  {type:'finish',reason:{kind:'stop'}},
];
function toolResponse(name,argumentsText='{}',malformed=false){
  return [
    {type:'block-start',index:0,blockType:'tool-call'},
    {type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name,arguments:argumentsText}},
    {type:'usage',usage:{inputTokens:5,outputTokens:5}},
    {type:'finish',reason:malformed?{kind:'error',failure:MALFORMED}:{kind:'tool-calls'}},
  ];
}
const readResponse=()=>toolResponse('unreal_fixture_read');
const patchResponse=()=>toolResponse('unreal_fixture_patch','{"patch":{"checked":true}}');
function malformedResponse(name='unreal_fixture_patch'){
  // A fully formed sibling call in the same failed response must also remain
  // undispatched; only the earlier successful step may have executed a read.
  return [
    {type:'block-start',index:0,blockType:'tool-call'},
    {type:'block-end',index:0,block:{type:'tool-call',id:randomUUID(),name:'unreal_fixture_read',arguments:'{}'}},
    ...toolResponse(name,'{"patch":{"checked":true}}}',true).map(chunk=>'index' in chunk?{...chunk,index:1}:chunk),
  ];
}
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
function assertVisibleNotice(options,count){
  const visible=(options.messages??[]).filter(message=>message.source?.kind===SOURCE);
  assert.equal(visible.length,count,'Retry sampling must receive all persisted recovery notices');
  for(const message of visible){
    assert.equal(message.role,'user');
    assert.equal(message.source.form,'notice');
    assert.ok(Number.isSafeInteger(message.source.attemptSeq));
    assert.ok(message.content.some(block=>block.type==='text'&&block.text.includes('unreal_fixture_patch')));
  }
}
async function coldRestore(root,id,expected){
  const ctx=new Context();let handle;
  try{
    await ctx.plugin(persistencePlugin,{root,compression:'none'});
    handle=await ctx.sessionPersistence.open(id,'read');
    const stored=await handle.read();
    assert.deepEqual(stored.events,expected,'A cold JSONL read must preserve every actual loop event');
    const replay=Session.fromRestore(id,stored.events,handle.header,handle.inheritedEventCount,stored.eventState);
    assert.deepEqual(replay.snapshotEvents().slice(0,expected.length),expected);
    assert.equal(replay.snapshotEvents().at(-1).type,'session/end-seed');
    assert.deepEqual(Session.create(id,stored.events,handle.header,handle.inheritedEventCount).deriveMessages(),replay.deriveMessages());
    assert.deepEqual(notices(replay.snapshotEvents()),notices(expected),'Cold Session restore must retain recovery prompts and their attempt references');
    return {eventCount:stored.events.length,coldReplayNotices:notices(stored.events).length,replayedMessages:replay.deriveMessages().length};
  }finally{await handle?.close();await ctx.fiber.dispose();}
}
async function scenario(name,{limits={},script,expectedNotices,expectedAttempts,expectedBodies,reason='completed',turns=1}){
  const ctx=new Context(),root=join(temporaryRoot,name),adapter=new OfflineAdapter(script);
  let guard,disposeRecovery,events,id,record;
  const observedFailures=[],retrySnapshots=[];
  try{
    await ctx.plugin(plugin('@deepseek-ai/dsh-llm','LlmRuntime'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-session','SessionStore'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-session-projection','SessionProjectionRegistry'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-system-prompt','SystemPrompt'),{});
    await ctx.plugin(plugin('@deepseek-ai/dsh-tools','ToolRuntime'));
    await ctx.plugin(plugin('@deepseek-ai/dsh-agent','AgentRegistry'));
    await ctx.plugin(persistencePlugin,{root,compression:'none'});
    await ctx.plugin(plugin('@deepseek-ai/dsh-agent-loop','AgentLoop'),{agents:[]});
    ctx.llm.registerAdapter(['recovery-offline'],adapter);
    // Register first so this observer wraps the installed recovery handler.
    // Record the durable log before the next sample can start.
    ctx.on('agent/request-error',async(payload,next)=>{
      observedFailures.push(payload.failure);
      const action=await next();
      if(action?.kind==='retry')retrySnapshots.push(payload.agent.session.snapshotEvents());
      return action;
    });
    const guardConfig={guardMaxToolCalls:20,guardMaxSteps:20,guardMaxErrors:3,guardTimeoutMs:30000,guardMaxMalformedRetries:2,...limits};
    if(bundleApply){
      ctx.provide('typert',{register(){}});
      await bundleApply(ctx,{port:0,stateDir:join(temporaryRoot,'bridge-state',name),requireApproval:false,...guardConfig});
    }else{
      guard=registerExecutionGuard(ctx,guardConfig);
      disposeRecovery=registerModelRecovery(ctx,guard);
    }
    const bodies=[];
    for(const toolName of ['unreal_fixture_read','unreal_fixture_patch','other_fixture_patch']){
      ctx.tools.register({name:toolName,description:'Offline malformed-response fixture',
        parameters:{type:'object',properties:{patch:{type:'object',properties:{checked:{type:'boolean'}},additionalProperties:false}},additionalProperties:false},
        output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
        execute:async()=>{bodies.push(toolName);return {ok:true};},
      });
    }
    id=`recovery-${name}-${randomUUID()}`;
    const agent=await ctx.agentLoop.create(id,{provider:'recovery-offline',model:'fixture'});
    for(let turn=0;turn<turns;turn++){
      await waitForIdle(ctx,agent,()=>agent.followup(createUserMessage({content:[{type:'text',text:'Run the offline malformed-response regression'}],source:{kind:'user'}})));
    }
    events=agent.session.snapshotEvents();
    const added=notices(events),attempts=events.filter(event=>event.type==='assistant/attempt');
    assert.equal(added.length,expectedNotices,`${name}: recovery notices`);
    assert.equal(attempts.length,expectedAttempts,`${name}: durable malformed attempts`);
    assert.deepEqual(bodies,expectedBodies,`${name}: completed tools must not be replayed and malformed calls must never be dispatched`);
    assert.equal(adapter.script.length,0,`${name}: all planned responses must run`);
    assert.equal(events.filter(event=>event.type==='turn/end').length,turns);
    assert.equal(events.filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,reason,`${name}: final turn outcome`);
    assert.equal(observedFailures.length,expectedAttempts);
    for(const failure of observedFailures)assert.deepEqual(failure,MALFORMED);
    for(const notice of added){
      assert.equal(notice.data.role,'user');assert.equal(notice.data.source.form,'notice');
      const attempt=attempts.find(event=>event.seq===notice.data.source.attemptSeq);
      assert.ok(attempt&&attempt.seq<notice.seq,'A persisted prompt must refer to its already persisted failed attempt');
      const prior=events.slice(0,notice.seq).findLast(event=>event.type==='turn/start');
      assert.equal(attempt.data.turn,prior.data.turn);
      assert.ok(!events.some(event=>event.seq>attempt.seq&&event.seq<notice.seq&&['assistant/message','tool/call','step/end'].includes(event.type)),'Recovery must occur before any failed-attempt dispatch or step end');
      const next=events.find(event=>event.seq>notice.seq&&['assistant/attempt','assistant/message'].includes(event.type));
      assert.equal(next?.data.step,attempt.data.step,'The next sample must retry the same step');
    }
    assert.equal(retrySnapshots.length,expectedNotices,'Every retry must already have a persisted model-visible prompt');
    await ctx.sessionPersistence.flush();
    record={name,result:'PASS',samples:adapter.requests.length,notices:added.length,malformedAttempts:attempts.length,turns,finalReason:reason,toolBodies:bodies};
  }finally{disposeRecovery?.();guard?.dispose();await ctx.fiber.dispose();}
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
  checks.push(await scenario('same-step-recovery',{
    script:[readResponse(),malformedResponse(),options=>{assertVisibleNotice(options,1);return malformedResponse();},options=>{assertVisibleNotice(options,2);return patchResponse();},textResponse('Final same-step-recovery')],
    expectedNotices:2,expectedAttempts:2,expectedBodies:['unreal_fixture_read','unreal_fixture_patch'],
  }));
  checks.push(await scenario('bounded-recovery',{
    script:[readResponse(),malformedResponse(),options=>{assertVisibleNotice(options,1);return malformedResponse();},options=>{assertVisibleNotice(options,2);return malformedResponse();}],
    expectedNotices:2,expectedAttempts:3,expectedBodies:['unreal_fixture_read'],reason:'error',
  }));
  checks.push(await scenario('disabled-recovery',{
    limits:{guardMaxMalformedRetries:0},script:[readResponse(),malformedResponse()],
    expectedNotices:0,expectedAttempts:1,expectedBodies:['unreal_fixture_read'],reason:'error',
  }));
  checks.push(await scenario('non-unreal-not-retried',{
    script:[readResponse(),malformedResponse('other_fixture_patch')],
    expectedNotices:0,expectedAttempts:1,expectedBodies:['unreal_fixture_read'],reason:'error',
  }));
  checks.push(await scenario('inactive-guard-not-retried',{
    script:[malformedResponse()],expectedNotices:0,expectedAttempts:1,expectedBodies:[],reason:'error',
  }));
  checks.push(await scenario('exhausted-budget-not-retried',{
    limits:{guardMaxSteps:1},script:[readResponse(),malformedResponse()],
    expectedNotices:0,expectedAttempts:1,expectedBodies:['unreal_fixture_read'],reason:'error',
  }));
  checks.push(await scenario('retry-count-resets-next-turn',{
    turns:2,script:[...Array.from({length:2},(_,turn)=>[
      readResponse(),malformedResponse(),options=>{assertVisibleNotice(options,turn*2+1);return malformedResponse();},options=>{assertVisibleNotice(options,turn*2+2);return patchResponse();},textResponse(`Final turn ${turn+1}`),
    ]).flat()],expectedNotices:4,expectedAttempts:4,expectedBodies:['unreal_fixture_read','unreal_fixture_patch','unreal_fixture_read','unreal_fixture_patch'],
  }));
  const report={result:'PASS',checkedAt:new Date().toISOString(),runtime,node:process.versions.node,versions,checks,
    recoverySource:args['--plugin']??'src/model-recovery.mjs',
    ...(args['--plugin']?{pluginSha256:createHash('sha256').update(fs.readFileSync(args['--plugin'])).digest('hex')}:{}),
    realAgentLoop:true,realSessionValidator:true,realJsonlPersistence:true,coldBackendReplay:true,
    networkRequests:0,realProfileAccess:args['--plugin']?'package resolution metadata only':false,realProfileWrites:false,realEditorAccess:false,realShellExecution:false};
  if(args['--output']){fs.mkdirSync(dirname(args['--output']),{recursive:true});fs.writeFileSync(args['--output'],`${JSON.stringify(report,null,2)}\n`);}
  console.log(JSON.stringify(report));
}finally{
  await loaderContext?.fiber.dispose();
  if(!resolve(temporaryRoot).startsWith(resolve(tmpdir())+sep)||!basename(temporaryRoot).startsWith('dsh-model-recovery-'))throw new Error('Refusing unexpected cleanup path');
  fs.rmSync(temporaryRoot,{recursive:true,force:true});
}
