import {randomUUID,createHash} from 'node:crypto';
import {writeFile,copyFile,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import sharp from 'sharp';
import {compareImages} from './visual-compare.mjs';
import {analyzeImage} from './image-analyze.mjs';
import {visualCaptureSchema,visualCompareSchema,imageAnalyzeSchema,fail} from './protocol.mjs';
import {CacheManager} from './cache-manager.mjs';
import {DEFAULTS} from './settings-spec.mjs';

const keyFor=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const checkAbort=signal=>{if(signal?.aborted)fail('CANCELLED','Visual operation cancelled');};

// Generated evidence stays outside the bounded bridge messages. The optional
// source reader lets the DSH integration enforce its own filesystem policy.
export class VisualService {
  constructor(bridge,{readReference,cache,getConfig=()=>bridge.config}={}) {
    this.bridge=bridge;
    this.getConfig=getConfig;
    this.ownsCache=!cache;
    this.cache=cache??new CacheManager({stateDir:bridge.config.stateDir,getConfig});
    this.root=join(bridge.config.stateDir,'visual');
    this.captures=new Map();
    this.pendingCaptures=new Set();
    this.captureRequests=new Map();
    this.quarantine=new Map();
    this.disposed=false;
    this.requestSettled=({editor,id})=>{
      const request=this.captureRequests.get(id)??this.quarantine.get(id);
      if(!request||request.editor!==editor)return;
      request.settled=true;
      if(this.quarantine.delete(id))request.release();
    };
    bridge.on('request-settled',this.requestSettled);
    this.expired=new Map();
    this.unsubscribe=this.cache.subscribeEvictions(({path,reason})=>{
      for(const [id,capture] of this.captures)if(this.cache.entryPath(capture.cropPath)===path)this.expire(id,reason);
    });
    this.queues=new Map();
    this.comparisonQueue=Promise.resolve();
    this.readReference=readReference??(async(source,destination)=>{
      const info=await stat(source);if(!info.isFile()||info.size>20*1024*1024)fail('INVALID_IMAGE','Reference must be an image file no larger than 20 MiB');
      await copyFile(source,destination);
    });
  }
  async directory(sessionId,id) {
    return this.cache.createDirectory(keyFor(sessionId),id);
  }
  expire(id,reason){
    const capture=this.captures.get(id);if(!capture)return;
    this.captures.delete(id);this.expired.set(id,{sessionId:capture.sessionId,reason});
    if(this.expired.size>2048)this.expired.delete(this.expired.keys().next().value);
  }
  async capture(sessionId,input={},signal,{onCapture}={}) {
    const args=visualCaptureSchema.parse(input);
    const editor=this.bridge.target(sessionId);
    if(!editor.capabilities.includes('visual_capture'))fail('VISUAL_UNAVAILABLE','The bound UE plugin needs updating to support visual capture');
    let targetPath=args.targetPath;
    if(!targetPath&&!args.region&&!args.fullViewport){
      const selection=editor.selection??[];
      if(selection.length!==1)fail('TARGET_REQUIRED','Select one level Actor/component, supply targetPath/region, or set fullViewport=true');
      const selected=selection[0];
      if(!['actor','component'].includes(selected.kind)||selected.source==='blueprint_editor'||!selected.worldPath)fail('SCENE_INSTANCE_REQUIRED','Select a placed level Actor/component; a Blueprint asset or component template has no scene capture region');
      targetPath=selected.path;
    }
    for(const [id,capture] of this.captures)if(Date.parse(capture.expiresAt)<=this.cache.now())this.expire(id,'retention_expired');
    if(this.captures.size+this.pendingCaptures.size+this.quarantine.size>=512)fail('CAPTURE_LIMIT','Too many retained or unresolved captures; clear idle evidence or wait for pending editor responses');
    const captureId=randomUUID();
    this.pendingCaptures.add(captureId);
    const previous=this.queues.get(editor.editorId)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      checkAbort(signal);
      if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed before capture');
      const release=this.cache.protect([join(this.root,keyFor(sessionId),captureId)]);
      const request={editor,release,settled:false};
      try{
        const outputDir=await this.directory(sessionId,captureId),config=this.getConfig()??{};
        const timeoutMs=Number.isSafeInteger(config.visualTimeoutMs)&&config.visualTimeoutMs>=1000&&config.visualTimeoutMs<=300000?config.visualTimeoutMs:DEFAULTS.visualTimeoutMs;
        const retentionDays=this.cache.policy().visualCacheRetentionDays;
        this.captureRequests.set(captureId,request);
        const result=await this.bridge.request(editor,'visual_capture',{
          outputDir,source:args.source,padding:args.padding,
          ...(targetPath?{targetPath}:{}),...(args.region?{region:args.region}:{})
        },{id:captureId,signal,timeoutMs});
        request.settled=true;
        if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed during capture');
        // Never accept an editor-supplied path outside the directory we allocated.
        for(const [field,name] of [['fullPath','viewport.png'],['cropPath','crop.png'],['metadataPath','capture.json']]){
          if(result[field]?.replaceAll('\\','/').toLowerCase()!==join(outputDir,name).replaceAll('\\','/').toLowerCase())fail('INVALID_CAPTURE','Editor returned an unexpected evidence path');
        }
        const previewPath=join(outputDir,'preview.png');
        await sharp(result.cropPath,{limitInputPixels:16777216}).resize({width:1440,height:1000,fit:'inside',withoutEnlargement:true}).png().toFile(previewPath);
        checkAbort(signal);
        if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed while preparing capture evidence');
        const expiresAt=this.cache.now()+retentionDays*86400000;
        const capture={...result,captureId,sessionId,editorId:editor.editorId,project:editor.project,previewPath,expiresAt:new Date(expiresAt).toISOString()};
        this.cache.retain(outputDir,expiresAt);
        this.captures.set(captureId,capture);
        onCapture?.(capture);
        return capture;
      }catch(error){
        // Timeout/cancellation ends the caller's wait, not necessarily UE's file
        // writes. Keep its pin until that same connection replies or we dispose.
        if(!this.disposed&&!request.settled&&error?.details?.requestId===captureId&&['TIMEOUT','CANCELLED','DISCONNECTED'].includes(error.code))
          this.quarantine.set(captureId,request);
        throw error;
      }finally{
        this.captureRequests.delete(captureId);
        if(!this.quarantine.has(captureId))release();
      }
    });
    this.queues.set(editor.editorId,operation);
    try{return await operation;}finally{this.pendingCaptures.delete(captureId);if(this.queues.get(editor.editorId)===operation)this.queues.delete(editor.editorId);}
  }
  getCapture(sessionId,captureId){
    const capture=this.captures.get(captureId);
    if(!capture||capture.sessionId!==sessionId){
      if(this.expired.get(captureId)?.sessionId===sessionId)fail('CAPTURE_EXPIRED','Capture evidence has expired or was cleared; capture the target again');
      fail('CAPTURE_NOT_FOUND','Capture is unavailable in this conversation; capture the target again');
    }
    if(Date.parse(capture.expiresAt)<=this.cache.now()){this.expire(captureId,'retention_expired');fail('CAPTURE_EXPIRED','Capture retention expired; capture the target again');}
    if(this.bridge.target(sessionId).editorId!==capture.editorId)fail('INSTANCE_CHANGED','Capture belongs to a different editor instance');
    return capture;
  }
  /** Keep evidence pinned through host attachment reads after an operation. */
  async withEvidence(result,callback){
    const paths=[result.previewPath,result.reportPath,...Object.values(result.evidence??{})].filter(value=>typeof value==='string');
    const release=this.cache.protect(paths);
    try{return await callback();}finally{release();}
  }
  async compare(sessionId,input,exec={}){
    const args=visualCompareSchema.parse(input);
    if(!isAbsolute(args.referencePath))fail('INVALID_REFERENCE','referencePath must be an absolute local image path');
    checkAbort(exec.signal);
    const editorId=this.bridge.target(sessionId).editorId;
    const existingCapture=args.captureId?this.getCapture(sessionId,args.captureId):null;
    const comparisonId=randomUUID();
    const release=this.cache.protect([join(this.root,keyFor(sessionId),comparisonId),args.referencePath,...(existingCapture?[existingCapture.cropPath]:[])]);
    let releaseCapture;
    try{
      const outputDir=await this.directory(sessionId,comparisonId);
      const referencePath=join(outputDir,'reference-source.image');
      await this.readReference(args.referencePath,referencePath,exec);
      checkAbort(exec.signal);
      if(this.bridge.target(sessionId).editorId!==editorId)fail('INSTANCE_CHANGED','Editor binding changed while reading the reference image');
      const capture=existingCapture??await this.capture(sessionId,args.capture??{},exec.signal,{onCapture:value=>{releaseCapture=this.cache.protect([value.cropPath]);}});
      // Native-resolution 4K analysis uses hundreds of MiB; bound memory across
      // simultaneous chats by allowing one comparison per DSH host at a time.
      const comparison=this.comparisonQueue.catch(()=>{}).then(()=>{
        checkAbort(exec.signal);
        if(this.bridge.target(sessionId).editorId!==editorId)fail('INSTANCE_CHANGED','Editor binding changed before comparison');
        return compareImages({referencePath,currentPath:capture.cropPath,outputDir,mode:args.mode,analysis:args.analysis,
          referenceRegion:args.referenceRegion,currentRegion:args.currentRegion,checks:args.checks,thresholds:args.thresholds,signal:exec.signal});
      });
      this.comparisonQueue=comparison;
      const result=await comparison;
      checkAbort(exec.signal);
      if(this.bridge.target(sessionId).editorId!==capture.editorId)fail('INSTANCE_CHANGED','Editor binding changed during comparison');
      if(args.analysis==='spatial'&&args.mode==='regression'&&!args.alignmentConfirmed){
        result.verdict='unknown';
        result.checks=result.checks.map(({passed,...check})=>({...check,withinThreshold:passed}));
        result.reasons=[...(result.reasons??[]),'Camera, scale and exposure equivalence have not been confirmed; metrics are advisory.'];
      }
      const report={...result,comparisonId,captureId:capture.captureId,
        conditions:{alignmentConfirmed:args.alignmentConfirmed,confirmationSource:args.alignmentConfirmed?'caller':'unconfirmed',targetMask:false},
        capture:{editorId:capture.editorId,project:capture.project,source:capture.source,camera:capture.camera,viewport:capture.viewport,crop:capture.crop,target:capture.target,render:capture.render,warnings:capture.warnings,metadataPath:capture.metadataPath},
        hypotheses:[],reportPath:join(outputDir,'report.json')};
      await writeFile(report.reportPath,JSON.stringify(report,null,2),{flag:'wx'});
      checkAbort(exec.signal);
      if(this.bridge.target(sessionId).editorId!==capture.editorId)fail('INSTANCE_CHANGED','Editor binding changed while saving comparison evidence');
      return report;
    }finally{releaseCapture?.();release();}
  }
  async analyze(sessionId,input,exec={}){
    const args=imageAnalyzeSchema.parse(input);
    if(!isAbsolute(args.imagePath))fail('INVALID_REFERENCE','imagePath must be an absolute local image path');
    checkAbort(exec.signal);
    const analysisId=randomUUID(),directory=join(this.root,keyFor(sessionId),analysisId);
    const release=this.cache.protect([directory,args.imagePath]);
    try{
      const outputDir=await this.directory(sessionId,analysisId),sourcePath=join(outputDir,'analysis-source.image');
      await this.readReference(args.imagePath,sourcePath,exec);
      const queued=this.comparisonQueue.catch(()=>{}).then(()=>{
        checkAbort(exec.signal);
        return analyzeImage({...args,imagePath:sourcePath},{signal:exec.signal});
      });
      this.comparisonQueue=queued;
      const result=await queued;
      const report={...result,analysisId,source:{...result.source,path:args.imagePath},reportPath:join(outputDir,'analysis.json')};
      await writeFile(report.reportPath,JSON.stringify(report,null,2),{flag:'wx'});
      checkAbort(exec.signal);
      return report;
    }finally{release();}
  }
  dispose(){
    this.disposed=true;this.unsubscribe();this.bridge.off('request-settled',this.requestSettled);
    for(const request of this.quarantine.values())request.release();
    this.quarantine.clear();
    if(this.ownsCache)return this.cache.dispose();
  }
}
