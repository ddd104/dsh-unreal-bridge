import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { VERSION, helloSchema, selectionSchema, patchSchema, createSchema, readSchema, focusSchema, catalogSchema, knowledgeSchema, knowledgeRecordSchema, mcpCallSchema, mcpDescribeSchema, mcpToolsetCallSchema, dataTableCopySchema, runtimeChangedSchema, runtimeSnapshotSchema, runtimeSnapshotResultSchema, runtimeHistorySchema, fail, BridgeError } from './protocol.mjs';
import { assertSafeMcpCall } from './mcp-policy.mjs';
import {levelBlueprintSchema} from './protocol.mjs';
import {shortToolName,describeTools,validateMcpArguments,isReadOnlyMcpCall,mcpFailure} from './mcp-contract.mjs';
import {isUnsafeWriteError} from './write-safety.mjs';
import {EditorWrites} from './editor-writes.mjs';

export function defaultStateDir() {
  return process.platform==='win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(),'AppData','Local'),'DSHUnrealBridge') : join(process.env.XDG_STATE_HOME ?? join(homedir(),'.local','state'),'dsh-unreal-bridge');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secureEquals = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
const runtimeKey=target=>JSON.stringify([target.playSessionId,target.worldId,target.objectId]);
const sameRuntimeTarget=(a,b)=>runtimeKey(a)===runtimeKey(b);
const runtimeIdentity=({playSessionId,worldId,objectId})=>({playSessionId,worldId,objectId});
const SNAPSHOT_LIMIT=20, SNAPSHOT_BYTES=16*1024*1024;

export class UnrealBridge extends EventEmitter {
  constructor(config={}) {
    super();
    this.config={port:17891, stateDir:defaultStateDir(), requestTimeoutMs:30000, heartbeatMs:10000, allowWrites:true, ...config};
    this.editors=new Map(); this.sessions=new Map(); this.pending=new Map(); this.previews=new Map(); this.inflight=new Map(); this.results=new Map(); this.uncertain=new Map(); this.eventVersion=0; this.closed=false;
    this.runtimeSnapshots=new Map(); this.bindingVersions=new Map(); this.writeLocks=new Map();
    this.editorWrites=new EditorWrites();
    this.token=randomBytes(32).toString('hex'); this.auditChain=Promise.resolve();
  }
  async start() {
    await mkdir(this.config.stateDir,{recursive:true,mode:0o700});
    this.server=createServer((_req,res)=>{res.writeHead(404);res.end();});
    this.wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false});
    this.server.on('upgrade',(req,socket,head)=>{
      const supplied=req.headers.authorization?.replace(/^Bearer /,'') ?? '';
      // UE's libwebsockets adds this loopback Origin. Browser WebSocket APIs
      // cannot supply the required Authorization header.
      const nativeOrigin=!req.headers.origin||['http://127.0.0.1','127.0.0.1'].includes(req.headers.origin);
      if(req.url!=='/editor' || !nativeOrigin || !secureEquals(supplied,this.token)) {socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.accept(ws));
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.config.port,'127.0.0.1',()=>{this.server.off('error',reject);resolve();});});
    this.server.on('error',e=>this.emit('diagnostic',e.message));
    this.port=this.server.address().port;
    this.descriptor={protocol:VERSION,url:`ws://127.0.0.1:${this.port}/editor`,token:this.token,pid:process.pid,startedAt:new Date().toISOString()};
    this.descriptorPath=join(this.config.stateDir,'bridge.json');
    const tmp=join(this.config.stateDir,`bridge-${randomUUID()}.tmp`);
    await writeFile(tmp,JSON.stringify(this.descriptor),{mode:0o600}); await rename(tmp,this.descriptorPath);
    this.heartbeat=setInterval(()=>{for(const peer of this.wss.clients){if(peer.alive===false){peer.terminate();continue;}peer.alive=false;peer.ping();}},this.config.heartbeatMs); this.heartbeat.unref();
    return this;
  }
  accept(ws) {
    ws.alive=true; ws.on('pong',()=>{ws.alive=true;});
    const helloTimer=setTimeout(()=>ws.close(1008,'Handshake timeout'),5000); helloTimer.unref();
    let editor;
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      try {
        const message=JSON.parse(raw.toString());
        if(!editor){
          const hello=helloSchema.parse(message);
          if(this.editors.has(hello.editorId)) fail('DUPLICATE_INSTANCE','Instance ID is already connected');
          clearTimeout(helloTimer);
          editor={...hello,ws,selection:[],runtime:null,invalidRuntimeTargets:new Map(),invalidRuntimeWorlds:new Set(),retiredPlaySessions:new Set(),lastSequence:0,connectedAt:Date.now(),revisions:new Map()}; this.editors.set(editor.editorId,editor);
          ws.send(JSON.stringify({type:'hello_ack',protocol:VERSION,connectionId:randomUUID()})); this.changed(); return;
        }
        if(message.type==='response') {
          const pending=this.pending.get(message.id);
          if(!pending || pending.editor!==editor) return;
          this.pending.delete(message.id); clearTimeout(pending.timer); pending.cleanup();
          if(message.ok===true) pending.resolve(message.result); else pending.reject(new BridgeError(message.error?.code ?? 'EDITOR_ERROR',message.error?.message ?? 'Editor rejected request',message.error?.details));
        } else if(message.type==='event') {
          if(!Number.isSafeInteger(message.sequence)||message.sequence<=editor.lastSequence) return;
          editor.lastSequence=message.sequence;
          if(message.event==='selection_changed') editor.selection=selectionSchema.parse(message.data).assets.filter(item=>!item.runtime||!this.runtimeUnavailable(editor,item.runtime));
          else if(message.event==='runtime_changed') this.runtimeChanged(editor,runtimeChangedSchema.parse(message.data));
          else if(message.event==='blueprint_changed') { if(typeof message.data?.assetPath!=='string'||typeof message.data?.revision!=='string') return; editor.revisions.set(message.data.assetPath,message.data.revision); this.invalidate(editor.editorId,message.data.assetPath); }
          this.changed();
        }
      } catch(e) { this.emit('diagnostic',`Rejected editor message: ${e.message}`); ws.close(1008,'Invalid protocol message'); }
    });
    ws.on('close',()=>{
      clearTimeout(helloTimer); if(!editor||this.editors.get(editor.editorId)!==editor)return;
      this.editors.delete(editor.editorId); this.invalidate(editor.editorId);
      for(const records of this.runtimeSnapshots.values())for(const record of records)if(record.editor===editor&&record.status==='available'){record.status='disconnected';record.reason='editor_disconnected';}
      for(const [key,p] of this.pending) if(p.editorId===editor.editorId){clearTimeout(p.timer);p.cleanup();this.pending.delete(key);p.reject(new BridgeError('DISCONNECTED','Editor disconnected; check request status before retrying a write'));}
      this.changed();
    });
  }
  changed(){this.eventVersion++;this.emit('change');}
  list(){return [...this.editors.values()].map(({editorId,project,projectPath,engineVersion,pid,capabilities})=>({editorId,project,projectPath,engineVersion,pid,capabilities}));}
  state(sessionId){const editorId=this.sessions.get(sessionId);const e=this.editors.get(editorId);const write=this.editorWrites.get(editorId);return {version:this.eventVersion,sessionId,editorId:editorId??null,connected:!!e,editors:this.list(),selection:e?.selection??[],runtime:e?.runtime??null,runtimeSnapshots:this.runtimeHistory(sessionId).snapshots,blueprintSupport:{normalBlueprints:e?.capabilities.includes('read_blueprint')??false,levelBlueprintLookup:e?.capabilities.includes('level_blueprint_lookup')??false,levelBlueprintNativePatch:false},toolSafety:{argumentSchemaValidation:true,nativeTargetValidation:e?.capabilities.includes('mcp_target_validation')??false,safePresentation:e?.capabilities.includes('safe_asset_presentation')??false},allowWrites:this.config.allowWrites,requireApproval:this.config.requireApproval,uncertain:this.uncertain.get(sessionId)??(write?.phase==='uncertain'?this.editorWrites.details(write):null),editorWrite:write?this.editorWrites.details(write):null,writeLock:this.writeLocks.get(editorId)??null};}
  bind(sessionId,editorId){if(editorId!==null&&!this.editors.has(editorId))fail('INSTANCE_NOT_FOUND','Editor is not connected'); if(this.inflight.has(sessionId))fail('BUSY','A request is still executing for this conversation');editorId===null?this.sessions.delete(sessionId):this.sessions.set(sessionId,editorId);this.bindingVersions.set(sessionId,(this.bindingVersions.get(sessionId)??0)+1);this.changed();return this.state(sessionId);}
  target(sessionId){const editorId=this.sessions.get(sessionId);if(!editorId)fail('NOT_BOUND','Select an Unreal Editor instance for this conversation first');const editor=this.editors.get(editorId);if(!editor)fail('DISCONNECTED','The bound editor is offline; reconnect it or choose another instance');return editor;}
  mcpTarget(sessionId){const editor=this.target(sessionId);if(!editor.capabilities.includes('mcp_tools'))fail('MCP_UNAVAILABLE','This editor does not expose UE MCP tools; enable ModelContextProtocol and update DSHUnrealBridge');return editor;}
  async request(editor,method,params={},options={}) {
    if(editor.ws.readyState!==WebSocket.OPEN)fail('DISCONNECTED','Editor is offline');
    const id=options.id??randomUUID(); if(this.pending.has(id))fail('DUPLICATE_REQUEST','Request is already pending');
    if(options.signal?.aborted)fail('CANCELLED','Request cancelled before dispatch');
    return new Promise((resolve,reject)=>{
      const cleanup=()=>options.signal?.removeEventListener('abort',abort);
      const finish=e=>{const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);cleanup();reject(e);};
      const abort=()=>finish(new BridgeError('CANCELLED','Request cancelled; editor may have already executed it',{requestId:id}));
      const timer=setTimeout(()=>finish(new BridgeError('TIMEOUT','Editor response timed out; query request status before retrying',{requestId:id})),options.timeoutMs??this.config.requestTimeoutMs); timer.unref();
      this.pending.set(id,{editor,editorId:editor.editorId,resolve,reject,timer,cleanup}); options.signal?.addEventListener('abort',abort,{once:true});
      editor.ws.send(JSON.stringify({type:'request',protocol:VERSION,id,method,params}),e=>{if(e)finish(new BridgeError('DISCONNECTED',e.message,{requestId:id}));});
    });
  }
  async read(sessionId,args,signal){return this.request(this.target(sessionId),'read_blueprint',readSchema.parse(args),{signal});}
  async levelBlueprint(sessionId,args,signal){
    const params=levelBlueprintSchema.parse(args),editor=this.target(sessionId);
    if(!editor.capabilities.includes('level_blueprint_lookup'))fail('LEVEL_BLUEPRINT_LOOKUP_UNAVAILABLE','Update the editor bridge to resolve level Blueprints. Finish supported work and report this missing capability; do not guess subobject paths or search bridge source',{execution:'not_started',retryable:false,recommendedTool:'unreal_level_blueprint'});
    const binding=this.bindingVersions.get(sessionId)??0;
    const result=await this.request(editor,'resolve_level_blueprint',params,{signal});
    if(this.target(sessionId)!==editor||(this.bindingVersions.get(sessionId)??0)!==binding)fail('INSTANCE_CHANGED','The editor binding changed while resolving the level Blueprint; read the current target again',{execution:'not_started',retryable:true});
    if(typeof result?.mapPath!=='string'||result.mapPath.split('.')[0]!==params.mapPath.split('.')[0]||typeof result?.blueprint?.refPath!=='string'||!result.blueprint.refPath.startsWith(`${result.mapPath}:`))fail('INVALID_LEVEL_BLUEPRINT_RESULT','The editor returned a Blueprint outside the requested map; do not use this reference',{mapPath:params.mapPath});
    return result;
  }
  runtimeUnavailable(editor,target){
    const invalid=editor.invalidRuntimeTargets.get(runtimeKey(target));
    if(invalid)return invalid;
    if(editor.invalidRuntimeWorlds.has(JSON.stringify([target.playSessionId,target.worldId])))return 'world_unloaded';
    if(editor.retiredPlaySessions.has(target.playSessionId))return 'pie_ended';
    if(editor.runtime&&(editor.runtime.status==='stopped'||editor.runtime.playSessionId!==target.playSessionId))return 'pie_ended';
    return null;
  }
  runtimeChanged(editor,runtime){
    // An ended run never becomes active again, even if an invalid producer sends
    // a newer event carrying its old session ID.
    if(runtime.playSessionId&&editor.retiredPlaySessions.has(runtime.playSessionId))return;
    const previous=editor.runtime?.playSessionId;
    if(previous&&previous!==runtime.playSessionId)editor.retiredPlaySessions.add(previous);
    for(const target of runtime.invalidated){
      editor.invalidRuntimeTargets.set(runtimeKey(target),target.reason);
      if(target.reason==='world_unloaded')editor.invalidRuntimeWorlds.add(JSON.stringify([target.playSessionId,target.worldId]));
    }
    editor.runtime=runtime;
    editor.selection=editor.selection.filter(item=>!item.runtime||!this.runtimeUnavailable(editor,item.runtime)).map(item=>item.runtime?{...item,runtime:{...item.runtime,status:runtime.status}}:item);
    for(const records of this.runtimeSnapshots.values())for(const record of records){
      if(record.editor!==editor||record.status==='expired')continue;
      const reason=this.runtimeUnavailable(editor,record.snapshot.target);
      if(reason){record.status='expired';record.reason=reason;}
    }
  }
  snapshotSummary(record){
    const {snapshotId,editorId,project,target,path,label,capturedAt,sampledFrame}=record.snapshot;
    return {snapshotId,editorId,project,target:structuredClone(target),path,label,capturedAt,sampledFrame,status:record.status,...(record.reason?{reason:record.reason}:{})};
  }
  runtimeHistory(sessionId,args={}){
    const {snapshotId}=runtimeHistorySchema.parse(args),records=this.runtimeSnapshots.get(sessionId)??[];
    if(!snapshotId)return {snapshots:records.map(record=>this.snapshotSummary(record))};
    const record=records.find(item=>item.snapshot.snapshotId===snapshotId);
    if(!record)fail('RUNTIME_SNAPSHOT_NOT_FOUND','Snapshot is unavailable in this conversation or has been evicted');
    return {...structuredClone(record.snapshot),status:record.status,...(record.reason?{reason:record.reason}:{})};
  }
  async runtimeSnapshot(sessionId,args={},signal){
    const params=runtimeSnapshotSchema.parse(args),editor=this.target(sessionId),bindingVersion=this.bindingVersions.get(sessionId);
    if(!editor.capabilities.includes('runtime_inspection'))fail('RUNTIME_UNAVAILABLE','This editor does not expose PIE runtime inspection; update DSHUnrealBridge');
    if(!params.target){
      if(editor.selection.length!==1||!editor.selection[0].runtime)fail('RUNTIME_SELECTION_REQUIRED','Select exactly one PIE actor or component, or provide its exact runtime target identity');
      params.target=runtimeIdentity(editor.selection[0].runtime);
    }
    if(!editor.runtime||editor.runtime.status==='stopped')fail('RUNTIME_NOT_RUNNING','PIE is not running in the bound editor');
    const unavailable=this.runtimeUnavailable(editor,params.target);
    if(unavailable)fail('RUNTIME_TARGET_EXPIRED','The runtime target is no longer available; select a new live instance',{target:params.target,reason:unavailable});
    const response=await this.request(editor,'runtime_snapshot',params,{signal});
    if(signal?.aborted)fail('CANCELLED','Runtime snapshot cancelled');
    if(this.sessions.get(sessionId)!==editor.editorId||this.bindingVersions.get(sessionId)!==bindingVersion||this.editors.get(editor.editorId)!==editor)fail('INSTANCE_CHANGED','Editor binding changed while reading the runtime snapshot');
    const parsed=runtimeSnapshotResultSchema.safeParse(response);
    if(!parsed.success)fail('INVALID_RUNTIME_SNAPSHOT','Editor returned an invalid runtime snapshot',{issues:parsed.error.issues});
    if(!sameRuntimeTarget(parsed.data.target,params.target))fail('INVALID_RUNTIME_SNAPSHOT','Editor returned a different runtime target than requested');
    // DSH's strict value encoder rejects signed zero; Unreal transforms and
    // reflected float properties can contain it. The schema guarantees finite
    // JSON data before this round trip normalizes -0 throughout the evidence.
    const snapshot={...JSON.parse(JSON.stringify(parsed.data)),snapshotId:randomUUID(),editorId:editor.editorId,project:editor.project};
    // Availability is host-owned metadata. Never trust a response to revive an
    // invalidated object, and never treat the sampled values as current values.
    delete snapshot.status;delete snapshot.reason;
    const reason=this.runtimeUnavailable(editor,snapshot.target);
    // Reserve the longest lifecycle annotation as part of the byte budget, so
    // later expiry/disconnect annotations cannot push retained evidence over it.
    const bytes=Buffer.byteLength(JSON.stringify({...snapshot,status:'disconnected',reason:'editor_disconnected'}),'utf8');
    if(bytes>SNAPSHOT_BYTES)fail('RUNTIME_SNAPSHOT_TOO_LARGE','Runtime snapshot exceeds the 16 MiB conversation history budget; request fewer properties or components');
    const records=this.runtimeSnapshots.get(sessionId)??[];
    records.push({editor,snapshot,bytes,status:reason?'expired':'available',...(reason?{reason}:{})});
    let total=records.reduce((sum,record)=>sum+record.bytes,0);
    while(records.length>SNAPSHOT_LIMIT||total>SNAPSHOT_BYTES)total-=records.shift().bytes;
    this.runtimeSnapshots.set(sessionId,records);this.changed();
    return this.runtimeHistory(sessionId,{snapshotId:snapshot.snapshotId});
  }
  async focus(sessionId,args,signal){const editor=this.target(sessionId);if(!editor.capabilities.includes('focus_asset'))fail('FOCUS_UNAVAILABLE','This editor does not support asset presentation');if(!editor.capabilities.includes('safe_asset_presentation'))fail('FOCUS_SAFETY_UNAVAILABLE','Update and restart the UE bridge plugin before focusing assets: this editor does not verify presentation targets',{execution:'not_started',retryable:true});return this.request(editor,'focus_asset',focusSchema.parse(args),{signal});}
  async catalog(sessionId,args={}){return this.request(this.target(sessionId),'catalog',catalogSchema.parse(args));}
  async knowledge(sessionId,args,signal){const editor=this.target(sessionId);if(!editor.capabilities.includes('project_knowledge'))fail('KNOWLEDGE_UNAVAILABLE','This editor does not expose project knowledge tools');return this.request(editor,'knowledge_call',knowledgeSchema.parse(args),{signal,timeoutMs:120000});}
  async knowledgeRecord(sessionId,args,signal){const {tool,arguments:toolArgs,requestId}=knowledgeRecordSchema.parse(args);const editor=this.target(sessionId);if(!editor.capabilities.includes('project_knowledge'))fail('KNOWLEDGE_UNAVAILABLE','This editor does not expose project knowledge tools');return this.mutate(sessionId,'knowledge_call',{tool,arguments:toolArgs},requestId,signal);}
  async mcpTools(sessionId,signal){return this.request(this.mcpTarget(sessionId),'mcp_list_tools',{}, {signal});}
  async mcpToolsets(sessionId,signal){return this.request(this.mcpTarget(sessionId),'mcp_discover',{name:'list_toolsets',arguments:{}},{signal});}
  async mcpDescribe(sessionId,args,signal){
    const {toolsetName,query,includeSchema}=mcpDescribeSchema.parse(args);
    const result=await this.request(this.mcpTarget(sessionId),'mcp_discover',{name:'describe_toolset',arguments:{toolset_name:toolsetName}},{signal});
    const {block,description}=describeTools(result,toolsetName);
    const found=description.tools.filter(tool=>!query||tool.fullName.toLowerCase().includes(query.toLowerCase()));
    const tools=includeSchema?found:found.map(({name,fullName,toolsetName,description})=>({name,fullName,toolsetName,description:description?.split('\n')[0]?.slice(0,180)??''}));
    return {...result,content:result.content.map(item=>item===block?{...item,text:JSON.stringify({...description,tools})}:item)};
  }
  async mcpCall(sessionId,args,signal){
    const {name,arguments:toolArgs,requestId}=mcpCallSchema.parse(args),editor=this.mcpTarget(sessionId),bindingVersion=this.bindingVersions.get(sessionId);
    let call={name,arguments:toolArgs};
    assertSafeMcpCall(call,{allowDesktopInput:this.config.allowMcpDesktopInput===true});
    let toolsetName,toolName;
    if(name.toLowerCase()==='call_tool'){
      toolsetName=toolArgs.toolset_name??'';
      const parsed=(toolsetName?mcpToolsetCallSchema:mcpCallSchema).safeParse(toolsetName?{toolsetName,toolName:toolArgs.tool_name,arguments:toolArgs.arguments,requestId}:{name:toolArgs.tool_name,arguments:toolArgs.arguments,requestId});
      if(!parsed.success||Object.keys(toolArgs).some(key=>!['toolset_name','tool_name','arguments'].includes(key)))fail('MCP_INVALID_ARGUMENTS','Use toolset_name, tool_name and arguments from the discovered tool schema',{execution:'not_started',retryable:true,issues:parsed.error?.issues??[]});
      if(toolsetName){
        toolName=shortToolName(toolsetName,parsed.data.toolName);
        call={name:'call_tool',arguments:{toolset_name:toolsetName,tool_name:toolName,arguments:parsed.data.arguments}};
      }else{
        if(parsed.data.name.toLowerCase()==='call_tool')fail('MCP_INVALID_TOOL_NAME','call_tool cannot dispatch to itself',{execution:'not_started',retryable:true});
        call={name:parsed.data.name,arguments:parsed.data.arguments};
      }
    }
    // Normalization can expose a nested dispatcher hidden by its full prefix.
    assertSafeMcpCall(call,{allowDesktopInput:this.config.allowMcpDesktopInput===true});
    if((toolName??call.name).split('.').at(-1).toLowerCase()==='call_tool'&&toolName)fail('MCP_TARGET_UNSUPPORTED','Nested MCP dispatchers cannot verify their final target; call the discovered leaf tool directly',{execution:'not_started',retryable:true});
    const mcpReadOnly=isReadOnlyMcpCall(call);
    // Cached outcomes and existing write barriers take precedence over discovery.
    // A preflight failure has no cached outcome, so its arguments can be corrected.
    const priorKey=`${editor.editorId}:${sessionId}:${requestId}`;
    if(this.results.has(priorKey))return this.mutate(sessionId,'mcp_call_tool',call,requestId,signal,{mcpReadOnly});
    if(!mcpReadOnly)this.assertWriteAvailable(sessionId,editor);
    let tool;
    if(toolsetName){
      const result=await this.mcpDescribe(sessionId,{toolsetName,query:toolName},signal);
      tool=JSON.parse(result.content.find(item=>item.type==='text').text).tools.find(item=>item.name===toolName);
    }else{
      const catalog=await this.mcpTools(sessionId,signal);
      if(catalog?.isError===true||catalog?.ok===false)throw mcpFailure(catalog,requestId,true);
      tool=catalog?.tools?.find(item=>item.name===call.name);
    }
    if(!tool)fail('MCP_TOOL_NOT_FOUND','This tool is not in the bound editor catalog; use unreal_mcp_describe or unreal_mcp_tools to choose an exact name',{execution:'not_started',retryable:true,...(toolsetName?{toolsetName}:{}),toolName:toolName??call.name});
    validateMcpArguments(tool,toolsetName?call.arguments.arguments:call.arguments);
    if(this.mcpTarget(sessionId)!==editor||this.bindingVersions.get(sessionId)!==bindingVersion)fail('INSTANCE_CHANGED','The editor binding changed during MCP argument validation; read its current schema before retrying',{execution:'not_started',retryable:true});
    if(!editor.capabilities.includes('mcp_target_validation'))fail('MCP_TARGET_VALIDATION_UNAVAILABLE','Update and restart the UE bridge plugin before executing MCP tools: this editor cannot verify target object types and ownership before dispatch',{execution:'not_started',retryable:true,requiredCapability:'mcp_target_validation'});
    return this.mutate(sessionId,'mcp_call_tool',call,requestId,signal,{mcpReadOnly});
  }
  async mcpCallToolset(sessionId,args,signal){const {toolsetName,toolName,arguments:toolArgs,requestId}=mcpToolsetCallSchema.parse(args);return this.mcpCall(sessionId,{name:'call_tool',arguments:{toolset_name:toolsetName,tool_name:toolName,arguments:toolArgs},requestId},signal);}
  async copyDataTableProperty(sessionId,args,signal){const {requestId,...params}=dataTableCopySchema.parse(args);if(!this.target(sessionId).capabilities.includes('data_table_copy_property'))fail('DATA_TABLE_COPY_UNAVAILABLE','Update the UE bridge plugin to copy DataTable properties safely; do not fall back to set_rows or desktop input',{retryable:false});return this.mutate(sessionId,'data_table_copy_property',params,requestId,signal);}
  invalidate(editorId,asset){for(const [key,p] of this.previews) if(p.editorId===editorId&&(!asset||p.params.assetPath.split('.')[0]===asset.split('.')[0]))this.previews.delete(key);}
  async preview(sessionId,kind,args,signal){
    const params=kind==='patch'?patchSchema.parse(args):createSchema.parse(args); const editor=this.target(sessionId);
    const result=await this.request(editor,kind==='patch'?'preview_patch':'preview_create',params,{signal});
    const previewId=randomUUID(); const record={previewId,sessionId,editorId:editor.editorId,kind,params,hash:digest(params),expires:Date.now()+300000,result};
    for(const [key,p] of this.previews) if(p.expires<Date.now())this.previews.delete(key);
    if(this.previews.size>=256)fail('PREVIEW_LIMIT','Too many pending previews');
    this.previews.set(previewId,record);return {previewId,expiresAt:new Date(record.expires).toISOString(),...result};
  }
  previewRecord(sessionId,previewId){const p=this.previews.get(previewId);if(!p||p.sessionId!==sessionId||p.expires<Date.now())fail('PREVIEW_EXPIRED','Preview missing, changed, or expired; read and preview again');if(this.target(sessionId).editorId!==p.editorId)fail('INSTANCE_CHANGED','Conversation is bound to another editor');return p;}
  async audit(row){const path=join(this.config.stateDir,'audit.jsonl');this.auditChain=this.auditChain.catch(()=>{}).then(async()=>{try{if((await stat(path)).size>10*1024*1024)await rename(path,join(this.config.stateDir,`audit-${Date.now()}.jsonl`));}catch(e){if(e.code!=='ENOENT')throw e;}await appendFile(path,JSON.stringify({time:new Date().toISOString(),...row})+'\n',{mode:0o600});});return this.auditChain;}
  assertWriteAvailable(sessionId,editor){
    if(!this.config.allowWrites)fail('READ_ONLY','Writes are disabled in the bridge configuration');
    if(this.writeLocks.has(editor.editorId))fail('EDITOR_WRITE_LOCKED','Editor writes are locked because rollback could not be verified; inspect the recorded failure before recovery',this.writeLocks.get(editor.editorId));
    if(this.uncertain.has(sessionId))fail('OUTCOME_UNKNOWN','Resolve the previous write using unreal_request_status before another write',this.uncertain.get(sessionId));
    if(this.inflight.has(sessionId))fail('BUSY','Another write is in progress');
    this.editorWrites.assertAvailable(editor.editorId);
  }
  lockUnsafeWrite(editorId,error,record){
    if(isUnsafeWriteError(error))this.writeLocks.set(editorId,{
      requestId:record.requestId,method:record.method,...(record.assetPath?{assetPath:record.assetPath}:{}),
      code:error.code??'ROLLBACK_FAILED',rollback:'failed',retryable:false,
    });
  }
  cacheResult(key,record){
    this.results.set(key,record);
    if(this.results.size>1000)this.results.delete(this.results.keys().next().value);
  }
  async mutate(sessionId,method,params,requestId,signal,options={}){
    // Read-only status is derived from the audited host catalog, never from
    // caller metadata. All other MCP operations remain potential mutations.
    const readOnly=method==='mcp_call_tool'&&options.mcpReadOnly===true&&isReadOnlyMcpCall(params);
    if(!readOnly&&!this.config.allowWrites)fail('READ_ONLY','Writes are disabled in the bridge configuration');
    const editor=this.target(sessionId),bindingVersion=this.bindingVersions.get(sessionId); const key=`${editor.editorId}:${sessionId}:${requestId}`; const hash=digest({method,params});
    const prior=this.results.get(key);if(prior){if(prior.hash!==hash)fail('IDEMPOTENCY_MISMATCH','Request ID was used for different parameters');if(prior.error)throw prior.error;return prior.result;}
    let lease;
    if(!readOnly){
      this.assertWriteAvailable(sessionId,editor);
      lease=this.editorWrites.acquire({editorId:editor.editorId,sessionId,requestId,method,assetPath:params.assetPath,hash});
      this.inflight.set(sessionId,requestId);
      this.changed();
    }
    let dispatched=false;
    try {
      await this.audit({phase:'requested',sessionId,editorId:editor.editorId,requestId,method,assetPath:params.assetPath,toolName:params.name,paramsHash:hash});
      if(readOnly&&(this.sessions.get(sessionId)!==editor.editorId||this.bindingVersions.get(sessionId)!==bindingVersion||this.editors.get(editor.editorId)!==editor))fail('INSTANCE_CHANGED','Editor binding changed before the read was dispatched',{execution:'not_started',retryable:true});
      // An abort/offline connection before dispatch cannot leave an unknown write.
      if(signal?.aborted)fail('CANCELLED','Request cancelled before dispatch',{execution:'not_started',requestId});
      if(editor.ws.readyState!==WebSocket.OPEN)fail('DISCONNECTED','Editor disconnected before dispatch',{execution:'not_started',requestId});
      dispatched=true;
      const result=await this.request(editor,method,params,{id:requestId,signal});
      if(method==='mcp_call_tool'&&(result?.isError===true||result?.ok===false))throw mcpFailure(result,requestId,readOnly);
      if(method==='data_table_copy_property'&&result?.verified!==true)fail('DATA_TABLE_ROLLBACK_FAILED','The DataTable copy did not return a verified result; stop writes and inspect the editor',{retryable:false,rollback:'failed',requestId});
      this.cacheResult(key,{hash,result});
      await this.audit({phase:'completed',sessionId,editorId:editor.editorId,requestId,method,revision:result?.revision}).catch(e=>this.emit('diagnostic',`Audit completion failed: ${e.message}`));
      if(readOnly&&(this.sessions.get(sessionId)!==editor.editorId||this.bindingVersions.get(sessionId)!==bindingVersion||this.editors.get(editor.editorId)!==editor))fail('INSTANCE_CHANGED','Editor binding changed during the read; query the current editor again',{execution:'completed',retryable:true});
      return result;
    }catch(e){
      this.lockUnsafeWrite(editor.editorId,e,{requestId,method,assetPath:params.assetPath});
      // Pre-dispatch failures and explicit native rejections have no journal
      // outcome. Keep their UUID available for the corrected operation.
      const notStarted=!dispatched||e.details?.execution==='not_started';
      if(!notStarted)this.cacheResult(key,{hash,error:e});
      if(dispatched&&!notStarted&&['TIMEOUT','CANCELLED','DISCONNECTED'].includes(e.code)&&lease){
        this.editorWrites.markUncertain(lease);
        this.uncertain.set(sessionId,this.editorWrites.details(lease));
      }
      await this.audit({phase:'failed',sessionId,editorId:editor.editorId,requestId,method,code:e.code??'ERROR',message:e.message,rollback:e.details?.rollback,writeLocked:this.writeLocks.has(editor.editorId)}).catch(()=>{});throw e;
    }finally{
      if(lease){
        if(lease.phase==='pending')this.editorWrites.release(lease);
        if(this.inflight.get(sessionId)===requestId)this.inflight.delete(sessionId);
      }
      this.changed();
    }
  }
  async apply(sessionId,previewId,requestId,signal){const p=this.previewRecord(sessionId,previewId);return this.mutate(sessionId,p.kind==='patch'?'apply_patch':'create_blueprint',p.params,requestId,signal);}
  async requestStatus(sessionId,requestId){
    const editor=this.target(sessionId),lease=this.editorWrites.get(editor.editorId);
    const result=await this.request(editor,'request_status',{requestId});
    // A completed query may reconcile another conversation's original write.
    // Do not release a newer lease or trust a result from a replaced connection.
    if(this.editors.get(editor.editorId)!==editor)fail('DISCONNECTED','The editor connection changed during request status lookup');
    if(lease?.phase==='uncertain'&&lease.requestId===requestId&&this.editorWrites.get(editor.editorId)===lease&&result.status==='completed'){
      const response=result.response;
      const valid=response&&typeof response.ok==='boolean'&&(response.id===undefined||response.id===requestId)&&(response.ok
        ?response.result!==null&&typeof response.result==='object'&&!Array.isArray(response.result)
        :typeof response.error?.code==='string'&&typeof response.error?.message==='string');
      if(!valid)fail('INVALID_REQUEST_STATUS','The completed write response is malformed; the editor remains protected');
      let error=result.response.ok?null:new BridgeError(result.response.error.code,result.response.error.message,result.response.error.details);
      if(!error&&lease.method==='data_table_copy_property'&&result.response.result?.verified!==true)error=new BridgeError('DATA_TABLE_ROLLBACK_FAILED','The recovered copy result is unverified',{rollback:'failed',retryable:false,requestId});
      if(!error&&lease.method==='mcp_call_tool'&&(result.response.result?.isError===true||result.response.result?.ok===false))error=mcpFailure(result.response.result,requestId);
      if(error)this.lockUnsafeWrite(editor.editorId,error,lease);
      const original=this.uncertain.get(lease.sessionId);
      if(original?.requestId===requestId&&original.editorId===editor.editorId)this.uncertain.delete(lease.sessionId);
      this.cacheResult(`${editor.editorId}:${lease.sessionId}:${requestId}`,{hash:lease.hash,...(error?{error}:{result:result.response.result})});
      this.editorWrites.release(lease);
      this.changed();
      if(error)throw error;
    }
    return result;
  }
  async close(){
    if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);
    for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup();p.reject(new BridgeError('SHUTDOWN','Bridge stopped'));}this.pending.clear();
    for(const ws of this.wss?.clients??[])ws.terminate();
    await new Promise(resolve=>this.wss?this.wss.close(resolve):resolve());
    await new Promise(resolve=>this.server?this.server.close(resolve):resolve());
    try{const stored=JSON.parse(await readFile(this.descriptorPath,'utf8'));if(stored.token===this.token)await unlink(this.descriptorPath);}catch{}
    await this.auditChain.catch(()=>{});
  }
}
