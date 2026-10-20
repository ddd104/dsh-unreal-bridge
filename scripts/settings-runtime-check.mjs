// Run with installed DSH Electron in Node mode:
// ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" scripts/settings-runtime-check.mjs
// Uses the official Loader, Settings and ConfigEditor with a temporary profile.
// No installed profile, UE editor, model API or user asset is modified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  if(!['--runtime','--plugin','--output'].includes(process.argv[index])||!process.argv[index+1])throw new Error('Expected --runtime, --plugin or --output and a path');
  args[process.argv[index]]=resolve(process.argv[index+1]);
}
const runtime=args['--runtime']??join(dirname(process.execPath),'resources/app.asar/dsh');
const runtimeRequire=createRequire(join(runtime,'package.json'));
const {boot,initProfile,readProfilePatches}=runtimeRequire('@deepseek-ai/dsh-app-boot');
const load=name=>{const value=runtimeRequire(name);return value.default??value;};
const ConfigEditor=load('@deepseek-ai/dsh-config-editor');
const Settings=load('@deepseek-ai/dsh-settings');
const {ToolRuntime}=runtimeRequire('@deepseek-ai/dsh-tools');
const {scopeTarget}=runtimeRequire('@deepseek-ai/dsh-scope');
const {Service}=runtimeRequire('@deepseek-ai/cordis');
const pluginPath=args['--plugin']??resolve('src/index.mjs');
const Plugin=await import(pathToFileURL(pluginPath).href);
const output=args['--output']??resolve('.test-state/settings-runtime-check.json');
const testRoot=resolve('.test-state');
fs.mkdirSync(testRoot,{recursive:true});
const home=fs.realpathSync(fs.mkdtempSync(join(testRoot,'settings-profile-')));
const dir=join(home,'profiles/test');
const stateDir=join(home,'bridge-state');
const checks=[];
let context,tools;
let sequence=0;

try{
  initProfile(dir,['test-settings-bundle']);
  const bundle=join(dir,'node_modules/test-settings-bundle');
  fs.mkdirSync(bundle,{recursive:true});
  fs.writeFileSync(join(home,'package.json'),'{"name":"settings-test-home"}\n');
  fs.writeFileSync(join(bundle,'package.json'),JSON.stringify({
    name:'test-settings-bundle',version:'1.0.0',
    dsh:{bundle:{patch:'cordis.patch.yml'},compatibility:{dshReleases:{'0.2.1-rc.2':'compatible'}}},
  }));
  fs.writeFileSync(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
    {id:'config-editor',name:'cordis:settingsTestEditor'},
    {id:'settings',name:'cordis:settingsTestForms'},
    {id:'dsh-unreal-bridge',name:'cordis:settingsTestBridge',config:{port:0,stateDir,requireApproval:false}},
  ]}],null,2));
  fs.writeFileSync(join(dir,'cordis.yml'),'[]\n');
  const profile={name:'test',startedBundles:['test-settings-bundle'],dir,patchPath:join(dir,'cordis.patch.yml'),
    installAnchor:join(runtime,'package.json'),cwd:home,home,overlays:[],telemetryDisabledEnv:undefined};
  const start=()=>boot('dsh',join(dir,'cordis.yml'),readProfilePatches('dsh',profile),root=>{
    root.provide('profileContext',profile);
    root.provide('systemPrompt',{tools(){},section(){}});
    root.provide('typert',{register(){}});
    tools=new ToolRuntime(root);
    Object.assign(root.loader.builtins,{
      settingsTestEditor:ConfigEditor,settingsTestForms:Settings,settingsTestBridge:Plugin,
    });
  });
  const descriptor=()=>context.settings.describe().find(row=>row.ns==='dsh-unreal-bridge');
  const entry=()=>context.configEditor.entries().find(row=>row.options.id==='dsh-unreal-bridge');
  const agent={session:{id:'settings-runtime-session'},cancel(){throw new Error('No cancellation expected');}};
  const beginTurn=turn=>context.emit(scopeTarget(context,agent),'session/event',agent.session,{type:'turn/start',seq:++sequence,data:{turn},time:Date.now()});
  const readState=async()=>{
    const response=await tools.execute({name:'unreal_state',arguments:{},callId:randomUUID(),agent,signal:new AbortController().signal});
    assert.equal(response.isError,false,JSON.stringify(response));
    assert.equal(response.value.ok,true,JSON.stringify(response));
    return response.value;
  };

  context=await start();
  const initial=descriptor();
  assert.ok(initial,'official Settings sees the plugin Config');
  assert.equal(initial.autoGenerate,false);
  assert.equal(initial.value.requireApproval,false,'installation inheritance is respected');
  for(const name of ['port','stateDir','allowMcpDesktopInput'])assert.equal(Object.hasOwn(initial.value,name),false);
  checks.push('official editable-field projection and inherited defaults');
  const originalEntry=entry(),fiber=originalEntry.fiber;
  const bridge=context.unrealBridge.bridge,token=bridge.token;
  const requestId=randomUUID();
  const lease=bridge.editorWrites.acquire({editorId:'synthetic-editor',sessionId:agent.session.id,requestId,method:'save',hash:'synthetic'});
  bridge.editorWrites.markUncertain(lease);
  bridge.writeLocks.set('synthetic-editor',{requestId,code:'ROLLBACK_FAILED',rollback:'failed'});
  beginTurn(1);
  const before=await readState();
  assert.equal(before.executionSafety.limits.guardMaxErrors,50);
  await context.settings.mutate('dsh-unreal-bridge',[
    {op:'set',path:['guardMaxErrors'],value:73},
    {op:'set',path:['guardMaxRepairAttempts'],value:4},
    {op:'set',path:['requestTimeoutMs'],value:41000},
    {op:'set',path:['knowledgeTimeoutMs'],value:130000},
    {op:'set',path:['visualCacheRetentionDays'],value:21},
    {op:'set',path:['allowWrites'],value:false},
  ],initial.revision);
  assert.equal(entry().fiber,fiber,'volatile edit does not remount the plugin');
  assert.equal(context.unrealBridge.bridge,bridge,'bridge instance remains live');
  assert.equal(bridge.token,token,'connection credentials are not recreated');
  assert.equal(bridge.editorWrites.get('synthetic-editor'),lease,'unknown write barrier survives settings edits');
  assert.equal(bridge.writeLocks.get('synthetic-editor').code,'ROLLBACK_FAILED');
  assert.equal(bridge.config.allowWrites,false);
  assert.equal(bridge.config.requestTimeoutMs,41000);
  checks.push('official atomic save updates live references without replacing bridge, token or write barriers');
  const ongoing=await readState();
  assert.equal(ongoing.executionSafety.limits.guardMaxErrors,50,'current turn keeps its activation snapshot');
  beginTurn(2);
  const next=await readState();
  assert.equal(next.executionSafety.limits.guardMaxErrors,73);
  assert.equal(next.executionSafety.limits.guardMaxRepairAttempts,4);
  checks.push('active-turn limits remain stable; the following user turn uses saved limits');
  const persisted=fs.readFileSync(profile.patchPath,'utf8');
  assert.match(persisted,/guardMaxErrors: 73/);
  assert.match(persisted,/requestTimeoutMs: 41000/);
  assert.equal(entry().options.config.port,0);
  assert.equal(entry().options.config.stateDir,stateDir);
  checks.push('ConfigEditor persists the profile and preserves hidden static fields');
  await assert.rejects(context.settings.mutate('dsh-unreal-bridge',[{op:'set',path:['guardMaxErrors'],value:7}],initial.revision),error=>error.code==='SETTINGS_CONFLICT');
  assert.equal(fs.readFileSync(profile.patchPath,'utf8'),persisted);
  await assert.rejects(context.settings.mutate('dsh-unreal-bridge',[{op:'set',path:['port'],value:19000}],descriptor().revision),/not volatile/);
  await assert.rejects(context.settings.mutate('dsh-unreal-bridge',[{op:'set',path:['guardMaxRepairAttempts'],value:-1}],descriptor().revision));
  assert.equal(fs.readFileSync(profile.patchPath,'utf8'),persisted);
  assert.equal(entry().fiber,fiber);
  checks.push('stale revision, static-field edits and invalid values leave disk and live plugin unchanged');
  await context.fiber.dispose(); context=undefined;
  context=await start();
  assert.equal(descriptor().value.guardMaxErrors,73);
  assert.equal(descriptor().value.requestTimeoutMs,41000);
  assert.equal(descriptor().value.visualCacheRetentionDays,21);
  assert.equal(context.unrealBridge.bridge.config.allowWrites,false);
  checks.push('cold start restores settings through the official Loader');
  await context.settings.mutate('dsh-unreal-bridge',[
    {op:'unset',path:['guardMaxErrors']},{op:'unset',path:['requireApproval']},
  ],descriptor().revision);
  assert.equal(descriptor().value.guardMaxErrors,50);
  assert.equal(descriptor().value.requireApproval,false,'reset inherits the installation setting, not a hardcoded boolean');
  assert.equal(entry().options.config.port,0);
  assert.equal(entry().options.config.stateDir,stateDir);
  checks.push('reset operations restore inherited defaults while preserving transport configuration');

  // Exercise the real registered tool through Cordis's context proxy. Only the
  // editor dispatch is synthetic; approvals must resolve in an injected child.
  const liveFiber=entry().fiber,liveBridge=context.unrealBridge.bridge;
  const liveToken=liveBridge.token,liveServer=liveBridge.server;
  const editorId='approval-test-editor',previewId='approval-test-preview';
  const originalApply=liveBridge.apply;
  const approvalCalls=[],dispatches=[];
  let approvalProvider,approvalOutcome='allowed-once';
  const settleServices=async()=>{
    await Promise.all([...context.registry.values()].flatMap(runtime=>[...runtime.fibers]).map(fiber=>fiber.await()));
  };
  const assertBridgeStable=()=>{
    assert.equal(entry().fiber,liveFiber);
    assert.equal(context.unrealBridge.bridge,liveBridge);
    assert.equal(liveBridge.token,liveToken);
    assert.equal(liveBridge.server,liveServer);
  };
  const applyPreview=async()=>{
    const requestId=randomUUID();
    const result=await tools.execute({name:'unreal_apply',arguments:{previewId,requestId},callId:randomUUID(),agent,signal:new AbortController().signal});
    assert.equal(result.isError,false,JSON.stringify(result));
    return result.value;
  };
  class SyntheticApproval extends Service{
    constructor(providerContext){super(providerContext,'approval');}
    async request(request){
      assert.equal(Object.hasOwn(this.ctx.fiber.inject,'approval'),true,'approval caller is an authorized injected child');
      assert.equal(this.ctx.fiber.parent.fiber,liveFiber,'optional dependency belongs to the live bridge plugin');
      assert.equal(request.toolName,'unreal_apply');
      assert.equal(request.agent,agent);
      assert.match(request.reason,/\/Game\/SettingsApprovalTest/);
      approvalCalls.push({outcome:approvalOutcome,fiber:this.ctx.fiber.uid});
      return approvalOutcome;
    }
  }
  try{
    await context.settings.mutate('dsh-unreal-bridge',[
      {op:'set',path:['allowWrites'],value:true},{op:'set',path:['requireApproval'],value:true},
    ],descriptor().revision);
    liveBridge.editors.set(editorId,{editorId,capabilities:[],selection:[]});
    liveBridge.sessions.set(agent.session.id,editorId);
    liveBridge.previews.set(previewId,{sessionId:agent.session.id,editorId,kind:'patch',params:{assetPath:'/Game/SettingsApprovalTest'},expires:Date.now()+60000});
    liveBridge.apply=async(sessionId,preview,requestId)=>{
      assert.equal(sessionId,agent.session.id);assert.equal(preview,previewId);
      dispatches.push(requestId);return {synthetic:true,requestId};
    };
    beginTurn(3);
    assert.equal((await applyPreview()).error.code,'APPROVAL_UNAVAILABLE');
    assert.equal(dispatches.length,0);
    approvalProvider=await context.plugin(SyntheticApproval);
    await settleServices();
    assert.throws(()=>liveFiber.ctx.approval,/without inject/,'bridge parent never receives undeclared service access');
    assert.equal((await applyPreview()).ok,true);
    assert.equal(approvalCalls.length,1);assert.equal(dispatches.length,1);
    assertBridgeStable();
    approvalOutcome='rejected';
    assert.equal((await applyPreview()).error.code,'PERMISSION_DENIED');
    assert.equal(approvalCalls.length,2);assert.equal(dispatches.length,1);
    await approvalProvider.dispose();approvalProvider=undefined;
    await settleServices();
    assert.equal((await applyPreview()).error.code,'APPROVAL_UNAVAILABLE');
    assert.equal(approvalCalls.length,2);assert.equal(dispatches.length,1);
    assertBridgeStable();
    approvalOutcome='allowed-once';
    approvalProvider=await context.plugin(SyntheticApproval);
    await settleServices();
    assert.equal((await applyPreview()).ok,true);
    assert.equal(approvalCalls.length,3);assert.equal(dispatches.length,2);
    assertBridgeStable();
    checks.push('dynamic optional approval injection, denial, removal and re-addition use authorized child contexts without replacing plugin or bridge');
  }finally{
    await approvalProvider?.dispose();
    liveBridge.apply=originalApply;
    liveBridge.previews.delete(previewId);liveBridge.sessions.delete(agent.session.id);liveBridge.editors.delete(editorId);
  }
  const report={status:'passed',plugin:pluginPath,versions:Object.fromEntries(
    ['@deepseek-ai/dsh-settings','@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-tools','@deepseek-ai/schemastery','@deepseek-ai/cordis'].map(name=>[
      name,JSON.parse(fs.readFileSync(join(runtime,'node_modules',name,'package.json'),'utf8')).version,
    ])),checks,scope:'Temporary profile; real installed Loader, Settings, ConfigEditor, ToolRuntime and Cordis dependency lifecycle; synthetic write barrier and editor dispatch; no editor, model API, installed profile or user assets.'};
  fs.mkdirSync(dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:'passed',checks:checks.length,output}));
}catch(error){
  console.error(error.stack??error);
  throw error;
}finally{
  try{await context?.fiber.dispose();}finally{
    const rel=relative(testRoot,home);
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'cleanup remains within isolated test root');
    await fs.promises.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
