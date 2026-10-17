import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,copyFile,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import sharp from 'sharp';
import {compareImages} from './visual-compare.mjs';
import {visualCaptureSchema,visualCompareSchema,fail} from './protocol.mjs';

const keyFor=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const checkAbort=signal=>{if(signal?.aborted)fail('CANCELLED','Visual operation cancelled');};

// Generated evidence stays outside the bounded bridge messages. The optional
// source reader lets the DSH integration enforce its own filesystem policy.
export class VisualService {
  constructor(bridge,{readReference}={}) {
    this.bridge=bridge;
    this.root=join(bridge.config.stateDir,'visual');
    this.captures=new Map();
    this.queues=new Map();
    this.comparisonQueue=Promise.resolve();
    this.readReference=readReference??(async(source,destination)=>{
      const info=await stat(source);if(!info.isFile()||info.size>20*1024*1024)fail('INVALID_IMAGE','Reference must be an image file no larger than 20 MiB');
      await copyFile(source,destination);
    });
  }
  async directory(sessionId,id) {
    const parent=join(this.root,keyFor(sessionId));
    await mkdir(parent,{recursive:true});
    const path=join(parent,id);await mkdir(path);return path;
  }
  async capture(sessionId,input={},signal) {
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
    const captureId=randomUUID();
    const previous=this.queues.get(editor.editorId)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      checkAbort(signal);
      if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed before capture');
      const outputDir=await this.directory(sessionId,captureId);
      const result=await this.bridge.request(editor,'visual_capture',{
        outputDir,source:args.source,padding:args.padding,
        ...(targetPath?{targetPath}:{}),...(args.region?{region:args.region}:{})
      },{signal,timeoutMs:60000});
      if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed during capture');
      // Never accept an editor-supplied path outside the directory we allocated.
      for(const [field,name] of [['fullPath','viewport.png'],['cropPath','crop.png'],['metadataPath','capture.json']]){
        if(result[field]?.replaceAll('\\','/').toLowerCase()!==join(outputDir,name).replaceAll('\\','/').toLowerCase())fail('INVALID_CAPTURE','Editor returned an unexpected evidence path');
      }
      const previewPath=join(outputDir,'preview.png');
      await sharp(result.cropPath,{limitInputPixels:16777216}).resize({width:1440,height:1000,fit:'inside',withoutEnlargement:true}).png().toFile(previewPath);
      checkAbort(signal);
      if(this.bridge.target(sessionId).editorId!==editor.editorId)fail('INSTANCE_CHANGED','Editor binding changed while preparing capture evidence');
      const capture={...result,captureId,sessionId,editorId:editor.editorId,project:editor.project,previewPath};
      this.captures.set(captureId,capture);
      if(this.captures.size>512)this.captures.delete(this.captures.keys().next().value);
      return capture;
    });
    this.queues.set(editor.editorId,operation);
    try{return await operation;}finally{if(this.queues.get(editor.editorId)===operation)this.queues.delete(editor.editorId);}
  }
  getCapture(sessionId,captureId){
    const capture=this.captures.get(captureId);
    if(!capture||capture.sessionId!==sessionId)fail('CAPTURE_NOT_FOUND','Capture is unavailable in this conversation; capture the target again');
    if(this.bridge.target(sessionId).editorId!==capture.editorId)fail('INSTANCE_CHANGED','Capture belongs to a different editor instance');
    return capture;
  }
  async compare(sessionId,input,exec={}){
    const args=visualCompareSchema.parse(input);
    if(!isAbsolute(args.referencePath))fail('INVALID_REFERENCE','referencePath must be an absolute local image path');
    checkAbort(exec.signal);
    const editorId=this.bridge.target(sessionId).editorId;
    const comparisonId=randomUUID(),outputDir=await this.directory(sessionId,comparisonId);
    const referencePath=join(outputDir,'reference-source.image');
    await this.readReference(args.referencePath,referencePath,exec);
    checkAbort(exec.signal);
    if(this.bridge.target(sessionId).editorId!==editorId)fail('INSTANCE_CHANGED','Editor binding changed while reading the reference image');
    const capture=args.captureId?this.getCapture(sessionId,args.captureId):await this.capture(sessionId,args.capture??{},exec.signal);
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
  }
}
