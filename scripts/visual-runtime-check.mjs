// Run with the installed DSH Electron in Node mode (ELECTRON_RUN_AS_NODE=1):
//   "DeepSeek Harness.exe" scripts/visual-runtime-check.mjs [--runtime <dsh directory>]
//     [--capture <existing capture.json>] [--output <verification.json>]
// In PowerShell, append `2>&1 | Out-String` to wait for the GUI executable and
// collect its diagnostics. Require both a PASS record and a zero exit code.
// Uses the actual installed runtime and synthetic model/attachment services. No
// provider requests, real profile access, editor capture or scene writes occur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {normalizeVisualValue,prepareVisualOutput,renderVisualOutput} from '../src/visual-output.mjs';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index];
  if(!['--runtime','--capture','--output'].includes(key)||!process.argv[index+1])throw new Error('Expected --runtime, --capture or --output followed by a path');
  args[key]=resolve(process.argv[index+1]);
}
const sourceRoot=args['--runtime']??join(dirname(process.execPath),'resources','app.asar','dsh');
const tempRoot=fs.mkdtempSync(join(tmpdir(),'dsh-visual-runtime-'));
const versions={};
let context;
try{
  const runtimeRequire=createRequire(join(sourceRoot,'package.json'));
  for(const name of ['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-util-values']){
    versions[name]=JSON.parse(fs.readFileSync(join(sourceRoot,'node_modules',name,'package.json'),'utf8')).version;
  }
  const {Context}=runtimeRequire('@deepseek-ai/cordis');
  const {ToolRuntime}=runtimeRequire('@deepseek-ai/dsh-tools');
  const {snapshotJsonValue}=runtimeRequire('@deepseek-ai/dsh-util-values');
  context=new Context();
  context.provide('systemPrompt',{tools(){}});
  const tools=new ToolRuntime(context);
  const metadata=args['--capture']?JSON.parse(fs.readFileSync(args['--capture'],'utf8')):{
    source:'editor',camera:{rotation:[-7,272,-0],viewProjectionMatrix:[[1,-0],[0,1]]},
    viewport:{x:0,y:0,width:1084,height:512},crop:{x:0,y:0,width:1084,height:512},warnings:[],
  };
  assert.equal(snapshotJsonValue(metadata),undefined,'capture fixture must reproduce the installed lossless-JSON rejection');
  const signal=new AbortController().signal;
  const run=async(name,execute)=>{
    tools.register({name,description:'Offline visual output regression fixture',
      parameters:{type:'object',properties:{},additionalProperties:false},
      output:{schema:{type:'object',properties:{},additionalProperties:true},render:renderVisualOutput},execute});
    return tools.execute({name,arguments:{},callId:`runtime-check-${name}`,signal});
  };
  const before=await run('visual_capture_before',async()=>({ok:true,...metadata}));
  assert.equal(before.isError,true);
  assert.equal(before.error.info.code,'INVALID_TOOL_OUTPUT');
  assert.match(before.error.message,/value is not lossless JSON/);

  const previewPath=join(tempRoot,'preview.png');
  fs.writeFileSync(previewPath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4MCHhwIQEBggFADDOBsF0/3kGAAAAAElFTkSuQmCC','base64'));
  const providerRequests=0;
  let attachmentCommits=0;
  const testServices={
    attachments:{imageLimits:{mediaTypes:['image/png'],maxImageBytes:1024,maxImagesPerMessage:4,maxMessageImageBytes:4096},
      async saveImages(inputs){return inputs.map(input=>({attachmentId:`offline-image-${++attachmentCommits}`,mediaType:input.mediaType,bytes:input.data.length,width:2,height:2,name:input.name}));}},
    llm:{async resolveModelInfo(provider,model){assert.equal(provider,'offline');assert.equal(model,'vision-fixture');return {inputModalities:['text','image']};}},
  };
  const ctx={get:key=>testServices[key]};
  const exec={signal,agent:{session:{requestHeader:()=>({config:{provider:'offline',model:'vision-fixture'}})}}};
  const capture=await run('visual_capture_after',async()=>prepareVisualOutput(ctx,exec,{ok:true,...metadata,captureId:'offline-capture',optional:undefined},[previewPath]));
  assert.equal(capture.isError,false,JSON.stringify(capture));
  assert.equal(capture.value.visualOutput.mode,'images');
  assert.equal(capture.content.filter(block=>block.type==='image').length,1);
  assert.deepEqual(capture.value,JSON.parse(JSON.stringify(capture.value)));
  const comparison=await run('visual_compare_after',async()=>prepareVisualOutput(ctx,exec,{ok:true,verdict:'unknown',capture:metadata,
    metrics:{ssim:null,color:{delta:0.2}},conditions:{alignmentConfirmed:false},optional:undefined},[previewPath,previewPath]));
  assert.equal(comparison.isError,false,JSON.stringify(comparison));
  assert.equal(comparison.content.filter(block=>block.type==='image').length,2);
  assert.equal(comparison.value.metrics.ssim,null);
  assert.equal(comparison.value.verdict,'unknown');
  assert.deepEqual(comparison.value,JSON.parse(JSON.stringify(comparison.value)));
  assert.throws(()=>normalizeVisualValue({metrics:{delta:NaN}}),{code:'INVALID_VISUAL_OUTPUT'});
  const record={result:'PASS',checkedAt:new Date().toISOString(),node:process.versions.node,
    versions,metadataSource:args['--capture']?'existing-capture':'synthetic-signed-zero',
    assertions:['installed ToolRuntime.execute reproduces signed-zero rejection before fix',
      'capture passes installed output schema and render gate after fix',
      'comparison passes installed output schema and render gate after fix',
      'native image blocks remain attached to both successful values',
      'unknown metric and verdict are preserved; NaN is rejected'],
    attachmentCommits,providerRequests,realProfileAccess:false};
  if(args['--output'])fs.writeFileSync(args['--output'],`${JSON.stringify(record,null,2)}\n`);
  console.log(JSON.stringify(record));
}finally{
  await context?.stop?.();
  if(!resolve(tempRoot).startsWith(resolve(tmpdir())+sep)||!basename(tempRoot).startsWith('dsh-visual-runtime-'))throw new Error('Refusing unexpected cleanup path');
  fs.rmSync(tempRoot,{recursive:true,force:true});
}
