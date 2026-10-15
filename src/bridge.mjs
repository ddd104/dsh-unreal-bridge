import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { VERSION, helloSchema, selectionSchema, patchSchema, createSchema, readSchema, catalogSchema, fail, BridgeError } from './protocol.mjs';

export function defaultStateDir() {
  return process.platform==='win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(),'AppData','Local'),'DSHUnrealBridge') : join(process.env.XDG_STATE_HOME ?? join(homedir(),'.local','state'),'dsh-unreal-bridge');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secureEquals = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };

export class UnrealBridge extends EventEmitter {
  constructor(config={}) {
    super();
    this.config={port:17891, stateDir:defaultStateDir(), requestTimeoutMs:30000, heartbeatMs:10000, allowWrites:true, ...config};
    this.editors=new Map(); this.sessions=new Map(); this.pending=new Map(); this.previews=new Map(); this.inflight=new Map(); this.results=new Map(); this.uncertain=new Map(); this.eventVersion=0; this.closed=false;
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
          editor={...hello,ws,selection:[],lastSequence:0,connectedAt:Date.now(),revisions:new Map()}; this.editors.set(editor.editorId,editor);
          ws.send(JSON.stringify({type:'hello_ack',protocol:VERSION,connectionId:randomUUID()})); this.changed(); return;
        }
        if(message.type==='response') {
          const pending=this.pending.get(message.id);
          if(!pending || pending.editorId!==editor.editorId) return;
          this.pending.delete(message.id); clearTimeout(pending.timer); pending.cleanup();
          if(message.ok===true) pending.resolve(message.result); else pending.reject(new BridgeError(message.error?.code ?? 'EDITOR_ERROR',message.error?.message ?? 'Editor rejected request',message.error?.details));
        } else if(message.type==='event') {
          if(!Number.isSafeInteger(message.sequence)||message.sequence<=editor.lastSequence) return;
          editor.lastSequence=message.sequence;
          if(message.event==='selection_changed') editor.selection=selectionSchema.parse(message.data).assets;
          else if(message.event==='blueprint_changed') { if(typeof message.data?.assetPath!=='string'||typeof message.data?.revision!=='string') return; editor.revisions.set(message.data.assetPath,message.data.revision); this.invalidate(editor.editorId,message.data.assetPath); }
          this.changed();
        }
      } catch(e) { this.emit('diagnostic',`Rejected editor message: ${e.message}`); ws.close(1008,'Invalid protocol message'); }
    });
    ws.on('close',()=>{
      clearTimeout(helloTimer); if(!editor||this.editors.get(editor.editorId)!==editor)return;
      this.editors.delete(editor.editorId); this.invalidate(editor.editorId);
      for(const [key,p] of this.pending) if(p.editorId===editor.editorId){clearTimeout(p.timer);p.cleanup();this.pending.delete(key);p.reject(new BridgeError('DISCONNECTED','Editor disconnected; check request status before retrying a write'));}
      this.changed();
    });
  }
  changed(){this.eventVersion++;this.emit('change');}
  list(){return [...this.editors.values()].map(({editorId,project,projectPath,engineVersion,pid,capabilities})=>({editorId,project,projectPath,engineVersion,pid,capabilities}));}
  state(sessionId){const editorId=this.sessions.get(sessionId);const e=this.editors.get(editorId);return {version:this.eventVersion,sessionId,editorId:editorId??null,connected:!!e,editors:this.list(),selection:e?.selection??[],allowWrites:this.config.allowWrites,uncertain:this.uncertain.get(sessionId)??null};}
  bind(sessionId,editorId){if(editorId!==null&&!this.editors.has(editorId))fail('INSTANCE_NOT_FOUND','Editor is not connected'); if(this.inflight.has(sessionId))fail('BUSY','A request is still executing for this conversation');editorId===null?this.sessions.delete(sessionId):this.sessions.set(sessionId,editorId);this.changed();return this.state(sessionId);}
  target(sessionId){const editorId=this.sessions.get(sessionId);if(!editorId)fail('NOT_BOUND','Select an Unreal Editor instance for this conversation first');const editor=this.editors.get(editorId);if(!editor)fail('DISCONNECTED','The bound editor is offline; reconnect it or choose another instance');return editor;}
  async request(editor,method,params={},options={}) {
    if(editor.ws.readyState!==WebSocket.OPEN)fail('DISCONNECTED','Editor is offline');
    const id=options.id??randomUUID(); if(this.pending.has(id))fail('DUPLICATE_REQUEST','Request is already pending');
    if(options.signal?.aborted)fail('CANCELLED','Request cancelled before dispatch');
    return new Promise((resolve,reject)=>{
      const cleanup=()=>options.signal?.removeEventListener('abort',abort);
      const finish=e=>{const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);cleanup();reject(e);};
      const abort=()=>finish(new BridgeError('CANCELLED','Request cancelled; editor may have already executed it',{requestId:id}));
      const timer=setTimeout(()=>finish(new BridgeError('TIMEOUT','Editor response timed out; query request status before retrying',{requestId:id})),this.config.requestTimeoutMs); timer.unref();
      this.pending.set(id,{editorId:editor.editorId,resolve,reject,timer,cleanup}); options.signal?.addEventListener('abort',abort,{once:true});
      editor.ws.send(JSON.stringify({type:'request',protocol:VERSION,id,method,params}),e=>{if(e)finish(new BridgeError('DISCONNECTED',e.message,{requestId:id}));});
    });
  }
  async read(sessionId,args,signal){return this.request(this.target(sessionId),'read_blueprint',readSchema.parse(args),{signal});}
  async catalog(sessionId,args={}){return this.request(this.target(sessionId),'catalog',catalogSchema.parse(args));}
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
  async mutate(sessionId,method,params,requestId,signal){
    if(!this.config.allowWrites)fail('READ_ONLY','Writes are disabled in the bridge configuration');
    const editor=this.target(sessionId); const key=`${editor.editorId}:${sessionId}:${requestId}`; const hash=digest({method,params});
    const prior=this.results.get(key);if(prior){if(prior.hash!==hash)fail('IDEMPOTENCY_MISMATCH','Request ID was used for different parameters');if(prior.error)throw prior.error;return prior.result;}
    if(this.uncertain.has(sessionId))fail('OUTCOME_UNKNOWN','Resolve the previous write using unreal_request_status before another write',this.uncertain.get(sessionId));
    if(this.inflight.has(sessionId))fail('BUSY','Another write is in progress');
    this.inflight.set(sessionId,requestId);
    try {
      await this.audit({phase:'requested',sessionId,editorId:editor.editorId,requestId,method,assetPath:params.assetPath,paramsHash:hash});
      const result=await this.request(editor,method,params,{id:requestId,signal});
      this.results.set(key,{hash,result}); if(this.results.size>1000)this.results.delete(this.results.keys().next().value);
      await this.audit({phase:'completed',sessionId,editorId:editor.editorId,requestId,method,revision:result?.revision}).catch(e=>this.emit('diagnostic',`Audit completion failed: ${e.message}`));
      return result;
    }catch(e){
      if(['TIMEOUT','CANCELLED','DISCONNECTED'].includes(e.code)){this.uncertain.set(sessionId,{editorId:editor.editorId,requestId,method,assetPath:params.assetPath});this.results.set(key,{hash,error:e});}
      await this.audit({phase:'failed',sessionId,editorId:editor.editorId,requestId,method,code:e.code??'ERROR'}).catch(()=>{});throw e;
    }finally{this.inflight.delete(sessionId);this.changed();}
  }
  async apply(sessionId,previewId,requestId,signal){const p=this.previewRecord(sessionId,previewId);return this.mutate(sessionId,p.kind==='patch'?'apply_patch':'create_blueprint',p.params,requestId,signal);}
  async requestStatus(sessionId,requestId){const editor=this.target(sessionId);const result=await this.request(editor,'request_status',{requestId}); const u=this.uncertain.get(sessionId);if(u?.requestId===requestId&&u.editorId===editor.editorId&&result.status==='completed'){this.uncertain.delete(sessionId);const key=`${editor.editorId}:${sessionId}:${requestId}`;const old=this.results.get(key);if(old)this.results.set(key,{hash:old.hash,...(result.response.ok?{result:result.response.result}:{error:new BridgeError(result.response.error.code,result.response.error.message)})});this.changed();}return result;}
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
