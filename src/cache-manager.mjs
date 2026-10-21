import {lstat,mkdir,opendir,realpath,rmdir,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {DEFAULTS} from './settings-spec.mjs';

const DAY=86400000,MiB=1024*1024;
const SESSION=/^[a-f0-9]{24}$/,ENTRY=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ARCHIVE=/^audit-(\d{13})\.jsonl$/;
const FILES=new Set(['viewport.png','crop.png','capture.json','preview.png','reference-source.image','reference.png','current.png','comparison.png','difference.png','heatmap.png','heatmap-preview.png','report.json','analysis-source.image','analysis.json']);
const SCAN_LIMIT=20000,FILE_LIMIT=100000;
const refusal=(code,message)=>Object.assign(new Error(message),{code});
const same=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
const plus=(a,b)=>Math.min(Number.MAX_SAFE_INTEGER,a+b);
const missing=error=>error?.code==='ENOENT';
const integer=(value,fallback,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback;

/** Own only bridge visual evidence and rotated audit logs, never project caches. */
export class CacheManager {
  constructor({stateDir,getConfig=()=>({}),onError=()=>{},now=()=>Date.now()}){
    if(!isAbsolute(stateDir))throw new TypeError('Cache stateDir must be absolute');
    this.stateDir=resolve(stateDir);this.root=join(this.stateDir,'visual');
    this.getConfig=getConfig;this.onError=onError;this.now=now;
    this.pins=new Map();this.retained=new Map();this.deleting=new Set();this.listeners=new Set();
    this.running=null;this.timer=null;this.disposed=false;this.lastScan=null;this.lastCleanup=null;
  }
  policy(){
    const config=this.getConfig()??{};
    return {
      visualCacheRetentionDays:integer(config.visualCacheRetentionDays,DEFAULTS.visualCacheRetentionDays,1,3650),
      visualCacheMaxMiB:integer(config.visualCacheMaxMiB,DEFAULTS.visualCacheMaxMiB,1,1048576),
      auditRetentionDays:integer(config.auditRetentionDays,DEFAULTS.auditRetentionDays,1,3650),
      auditMaxArchives:integer(config.auditMaxArchives,DEFAULTS.auditMaxArchives,0,10000),
    };
  }
  entryPath(path){
    const absolute=resolve(path),relativePath=relative(this.root,absolute);
    const part=process.platform==='win32'?relativePath.toLowerCase():relativePath,pieces=part.split(sep);
    if(!part||isAbsolute(part)||pieces[0]==='..'||!SESSION.test(pieces[0])||!ENTRY.test(pieces[1]??''))return null;
    return join(this.root,pieces[0],pieces[1]);
  }
  /** Pin owned evidence before any await; cleanup cannot admit its directory. */
  protect(paths){
    if(this.disposed)throw refusal('CACHE_DISPOSED','Evidence cache is closed');
    const entries=[...new Set(paths.map(path=>this.entryPath(path)).filter(Boolean))];
    if(entries.some(path=>this.deleting.has(path)))throw refusal('CAPTURE_EXPIRED','Evidence is being removed; capture the target again');
    for(const path of entries)this.pins.set(path,(this.pins.get(path)??0)+1);
    let active=true;
    return()=>{if(!active)return;active=false;for(const path of entries){const count=this.pins.get(path)??0;if(count<=1)this.pins.delete(path);else this.pins.set(path,count-1);}};
  }
  retain(path,expiresAt){
    const entry=this.entryPath(path);
    if(!entry||!Number.isFinite(expiresAt))throw new TypeError('Invalid retained evidence');
    for(const [key,deadline] of this.retained)if(deadline<=this.now())this.retained.delete(key);
    this.retained.set(entry,Math.max(this.retained.get(entry)??0,expiresAt));
  }
  subscribeEvictions(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  evicted(path,reason){
    this.retained.delete(path);
    for(const listener of this.listeners)listener({path,reason});
  }
  async safeDirectory(path,{optional=false}={}){
    let info;
    try{info=await lstat(path);}catch(error){if(optional&&missing(error))return null;throw error;}
    if(info.isSymbolicLink()||!info.isDirectory()||!same(await realpath(path),path))throw refusal('CACHE_UNSAFE_PATH','Cache directory is a link, reparse redirect, or non-directory');
    return info;
  }
  async ancestors(path,{optional=false}={}){
    if(!await this.safeDirectory(this.stateDir,{optional}))return false;
    if(!await this.safeDirectory(this.root,{optional}))return false;
    const parent=dirname(path);
    if(!same(parent,this.root)&&!await this.safeDirectory(parent,{optional}))return false;
    return true;
  }
  async createDirectory(session,id){
    if(!SESSION.test(session)||!ENTRY.test(id))throw new TypeError('Invalid visual evidence identity');
    await this.safeDirectory(this.stateDir);
    for(const path of [this.root,join(this.root,session)]){
      try{await mkdir(path);}catch(error){if(error.code!=='EEXIST')throw error;}
      await this.safeDirectory(path);
    }
    const path=join(this.root,session,id);
    await mkdir(path);await this.safeDirectory(path);return path;
  }
  async inspectEntry(path,budget){
    path=this.entryPath(path)??path;
    await this.ancestors(path);const info=await this.safeDirectory(path);
    const record={path,bytes:0,files:[],mtimeMs:info.mtimeMs,unsafe:false};
    for await(const child of await opendir(path)){
      if(++budget.files>FILE_LIMIT){budget.partial=true;record.unsafe=true;break;}
      const file=join(path,child.name),item=await lstat(file);
      if(item.isSymbolicLink()||!item.isFile()||!FILES.has(child.name)||!same(await realpath(file),file)){record.unsafe=true;continue;}
      record.bytes=plus(record.bytes,item.size);record.mtimeMs=Math.max(record.mtimeMs,item.mtimeMs);record.files.push(file);
    }
    return record;
  }
  async scan(){
    const entries=[],archives=[],budget={visited:0,files:0,partial:false};let unsafe=0;
    if(!await this.safeDirectory(this.stateDir,{optional:true}))return {entries,archives,partial:false,unsafe};
    for await(const child of await opendir(this.stateDir)){
      if(++budget.visited>SCAN_LIMIT){budget.partial=true;break;}
      const match=ARCHIVE.exec(child.name);if(!match)continue;
      const path=join(this.stateDir,child.name);
      try{
        const info=await lstat(path);
        if(info.isSymbolicLink()||!info.isFile()||!same(await realpath(path),path)){unsafe++;continue;}
        archives.push({path,bytes:info.size,timestamp:Number(match[1])});
      }catch(error){if(!missing(error))throw error;}
    }
    if(!await this.safeDirectory(this.root,{optional:true}))return {entries,archives,partial:budget.partial,unsafe};
    for await(const session of await opendir(this.root)){
      if(++budget.visited>SCAN_LIMIT){budget.partial=true;break;}
      if(!SESSION.test(session.name))continue;
      const parent=join(this.root,session.name);
      try{await this.safeDirectory(parent);}catch(error){if(missing(error))continue;if(error.code==='CACHE_UNSAFE_PATH'){unsafe++;continue;}throw error;}
      for await(const entry of await opendir(parent)){
        if(++budget.visited>SCAN_LIMIT||budget.files>=FILE_LIMIT){budget.partial=true;break;}
        if(!ENTRY.test(entry.name))continue;
        try{const record=await this.inspectEntry(join(parent,entry.name),budget);entries.push(record);if(record.unsafe)unsafe++;}
        catch(error){if(missing(error))continue;if(error.code==='CACHE_UNSAFE_PATH'){unsafe++;continue;}throw error;}
      }
      if(budget.partial)break;
    }
    return {entries,archives,partial:budget.partial,unsafe};
  }
  snapshot(scan,policy=this.policy()){
    const time=this.now(),bytes=scan.entries.reduce((sum,row)=>plus(sum,row.bytes),0);
    return {
      busy:!!this.running,policy,
      visual:{bytes,entries:scan.entries.length,files:scan.entries.reduce((sum,row)=>sum+row.files.length,0),protectedEntries:scan.entries.filter(row=>this.pins.has(row.path)).length,retainedEntries:scan.entries.filter(row=>(this.retained.get(row.path)??0)>time).length,overBudgetBytes:Math.max(0,bytes-policy.visualCacheMaxMiB*MiB)},
      audit:{bytes:scan.archives.reduce((sum,row)=>plus(sum,row.bytes),0),archives:scan.archives.length},
      partial:scan.partial,skippedUnsafe:scan.unsafe,scannedAt:new Date(time).toISOString(),lastCleanup:this.lastCleanup,
    };
  }
  async status(){
    if(this.running&&this.lastScan)return this.snapshot(this.lastScan);
    this.lastScan=await this.scan();return this.snapshot(this.lastScan);
  }
  async deleteEntry(path){
    await this.ancestors(path);const record=await this.inspectEntry(path,{files:0,partial:false});
    if(record.unsafe)throw refusal('CACHE_UNSAFE_PATH','Evidence contains an unowned file or redirected path');
    let files=0,bytes=0;
    try{
      for(const file of record.files){
        await this.ancestors(path);await this.safeDirectory(path);
        const info=await lstat(file);
        if(info.isSymbolicLink()||!info.isFile()||!same(await realpath(file),file))throw refusal('CACHE_UNSAFE_PATH','Evidence path changed during cleanup');
        await unlink(file);files++;bytes=plus(bytes,info.size);
      }
      await this.ancestors(path);await this.safeDirectory(path);await rmdir(path);
      return {files,bytes};
    }finally{this.evicted(path,'cache_cleanup');}
  }
  async cleanup({mode='policy'}={}){
    if(!['policy','all_idle'].includes(mode))throw new TypeError('Invalid cache cleanup mode');
    if(this.disposed)throw refusal('CACHE_DISPOSED','Evidence cache is closed');
    if(this.running)throw refusal('CACHE_BUSY','A cache cleanup is already running');
    const operation=this.clean(mode);this.running=operation;
    try{return await operation;}finally{if(this.running===operation)this.running=null;}
  }
  async clean(mode){
    const policy=this.policy(),time=this.now(),scan=await this.scan();this.lastScan=scan;
    for(const [key,deadline] of this.retained)if(deadline<=time)this.retained.delete(key);
    const result={mode,deleted:{visualEntries:0,auditArchives:0,files:0,bytes:0},skipped:{busy:0,retained:0,unsafe:scan.unsafe},partial:scan.partial,finishedAt:null};
    let bytes=scan.entries.reduce((sum,row)=>plus(sum,row.bytes),0);
    for(const entry of scan.entries.sort((a,b)=>a.mtimeMs-b.mtimeMs)){
      if(this.disposed)break;
      if(entry.unsafe)continue;
      if(this.pins.has(entry.path)){result.skipped.busy++;continue;}
      // Capacity is a collection target: published capture deadlines take priority.
      if(mode==='policy'&&(this.retained.get(entry.path)??0)>time){result.skipped.retained++;continue;}
      if(mode==='policy'&&entry.mtimeMs>time-policy.visualCacheRetentionDays*DAY&&bytes<=policy.visualCacheMaxMiB*MiB)continue;
      this.deleting.add(entry.path);
      try{const removed=await this.deleteEntry(entry.path);result.deleted.visualEntries++;result.deleted.files+=removed.files;result.deleted.bytes=plus(result.deleted.bytes,removed.bytes);bytes=Math.max(0,bytes-entry.bytes);}
      catch(error){if(!missing(error)){if(error.code==='CACHE_UNSAFE_PATH')result.skipped.unsafe++;else throw error;}}
      finally{this.deleting.delete(entry.path);}
    }
    const archives=scan.archives.sort((a,b)=>b.timestamp-a.timestamp);
    for(let index=0;index<archives.length&&!this.disposed;index++){
      const archive=archives[index];
      if(mode==='policy'&&index<policy.auditMaxArchives&&archive.timestamp>time-policy.auditRetentionDays*DAY)continue;
      await this.safeDirectory(this.stateDir);
      try{
        const info=await lstat(archive.path);
        if(info.isSymbolicLink()||!info.isFile()||!same(await realpath(archive.path),archive.path)){result.skipped.unsafe++;continue;}
        await unlink(archive.path);result.deleted.auditArchives++;result.deleted.files++;result.deleted.bytes=plus(result.deleted.bytes,info.size);
      }catch(error){if(!missing(error))throw error;}
    }
    result.finishedAt=new Date(this.now()).toISOString();this.lastCleanup=result;
    this.lastScan=null;return result;
  }
  /** Explicit lifecycle hook; constructing or inspecting the service never deletes. */
  start(){
    if(this.timer||this.disposed)return;
    const run=()=>this.cleanup({mode:'policy'}).catch(error=>{if(error.code!=='CACHE_BUSY'&&error.code!=='CACHE_DISPOSED')this.onError(error);});
    this.timer=setInterval(run,3600000);this.timer.unref?.();void run();
  }
  dispose(){
    this.disposed=true;if(this.timer)clearInterval(this.timer);this.timer=null;
    return this.running?.catch(()=>{});
  }
}
