import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeVisualValue,prepareVisualOutput,renderVisualOutput} from '../src/visual-output.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4MCHhwIQEBggFADDOBsF0/3kGAAAAAElFTkSuQmCC','base64');
const limits={mediaTypes:['image/png','image/jpeg','image/webp','image/gif'],maxImageBytes:1024,maxImagesPerMessage:4,maxMessageImageBytes:4096};

function harness({modalities=['text','image'],routed,options={provider:'p',model:'m'},attachment=true}={}){
  const saved=new Map();
  const calls=[];
  const store={imageLimits:{...limits},async saveImage(input){
    const attachmentId=createHash('sha256').update(input.data).digest('hex');
    saved.set(attachmentId,Buffer.from(input.data));
    return {attachmentId,mediaType:input.mediaType,bytes:input.data.byteLength,width:1,height:1,name:input.name};
  },async saveImages(inputs){calls.push({batch:inputs.length});return Promise.all(inputs.map(input=>this.saveImage(input)));}};
  const llm={async resolveModelInfo(provider,model,signal){calls.push({provider,model,signal});return {inputModalities:modalities};}};
  const ctx={get:key=>key==='attachments'?(attachment?store:undefined):key==='llm'?llm:undefined};
  const exec={agent:{session:{requestHeader:()=>routed===undefined?undefined:{config:routed}},options}};
  return {ctx,exec,store,llm,calls,saved};
}

async function fixture(t,count=1){
  const dir=await mkdtemp(join(tmpdir(),'dsh-visual-output-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const paths=[];
  for(let i=0;i<count;i++){
    const path=join(dir,`preview-${i}.png`);
    await writeFile(path,PNG);
    paths.push({path,label:['参考图','当前截图','差异热图'][i]??`图 ${i+1}`});
  }
  return paths;
}

test('normalizes UE signed-zero metadata and absent optional fields before DSH validates output',async t=>{
  const paths=await fixture(t);
  const {ctx,exec}=harness();
  // UE capture.json from the failed sky task contained camera.rotation[2]=-0.
  const result={camera:{rotation:[-7,272,-0],viewProjectionMatrix:[[-0,1],[0,-1]]},capture:{render:undefined},metrics:{ssim:null},optional:undefined};
  const output=await prepareVisualOutput(ctx,exec,result,paths);
  assert.equal(output.visualOutput.mode,'images');
  assert.equal(Object.is(output.camera.rotation[2],-0),false);
  assert.equal(Object.is(output.camera.viewProjectionMatrix[0][0],-0),false);
  assert.equal(Object.hasOwn(output,'optional'),false);
  assert.deepEqual(output.capture,{});
  assert.deepEqual(output,JSON.parse(JSON.stringify(output)));
  assert.equal(Object.is(result.camera.rotation[2],-0),true,'must not alter source metadata');
  assert.equal(Object.hasOwn(result.capture,'render'),true);
  const fallback=await prepareVisualOutput(harness({attachment:false}).ctx,exec,result,paths);
  assert.deepEqual(fallback,JSON.parse(JSON.stringify(fallback)));
});

test('normalizer rejects invalid data with a useful path rather than silently replacing metrics',async()=>{
  const cycle={};cycle.self=cycle;
  const accessor={};Object.defineProperty(accessor,'value',{enumerable:true,get(){assert.fail('must not invoke getters');}});
  const hidden={};Object.defineProperty(hidden,'secret',{value:1});
  const extra=[];extra.label='discarded';
  for(const [value,path] of [
    [{metrics:{delta:NaN}},'value.metrics.delta'],[{metrics:{delta:Infinity}},'value.metrics.delta'],
    [{items:[undefined]},'value.items[0]'],[{items:new Array(1)},'value.items'],
    [{items:extra},'value.items'],[{value:1n},'value.value'],[{value:()=>1},'value.value'],
    [{value:new Date()},'value.value'],[{value:new String('id')},'value.value'],
    [{value:Buffer.from('data')},'value.value'],[{value:Symbol('id')},'value.value'],
    [{value:{[Symbol('id')]:1}},'value.value'],[{value:hidden},'value.value.secret'],
    [{value:accessor},'value.value.value'],[{value:cycle},'value.value.self'],
  ]){
    assert.throws(()=>normalizeVisualValue(value),error=>error.code==='INVALID_VISUAL_OUTPUT'&&error.message.includes(path));
  }
  const {ctx,exec}=harness();
  await assert.rejects(prepareVisualOutput(ctx,exec,{metrics:{ssim:NaN}},[]),{code:'INVALID_VISUAL_OUTPUT'});
});

test('normalizer retains repeated data, nulls and prototype-named data keys as plain JSON',()=>{
  const shared={zero:-0,unknown:null};
  const input=Object.create(null);
  input.left=shared;input.right=shared;
  Object.defineProperty(input,'__proto__',{value:{safe:true},enumerable:true});
  const output=normalizeVisualValue(input);
  assert.deepEqual(output,JSON.parse(JSON.stringify(input)));
  assert.equal(Object.getPrototypeOf(output),Object.prototype);
  assert.equal(Object.hasOwn(output,'__proto__'),true);
  assert.notEqual(output.left,output.right);
});

test('persists every preview before returning native image blocks; refs survive history replay',async t=>{
  const paths=await fixture(t,3);
  const {ctx,exec,saved,calls}=harness();
  const result={ok:true,metrics:{ssim:0.91},evidence:{reportPath:join(tmpdir(),'report.json')}};
  const output=await prepareVisualOutput(ctx,exec,result,paths);
  assert.equal(output.visualOutput.mode,'images');
  assert.deepEqual(output.metrics,result.metrics);
  assert.deepEqual(calls.at(-1),{batch:3});
  const replayed=JSON.parse(JSON.stringify(output));
  const blocks=renderVisualOutput({},replayed);
  assert.equal(blocks.filter(block=>block.type==='image').length,3);
  for(const block of blocks.filter(block=>block.type==='image')){
    assert.deepEqual(saved.get(block.attachment.attachmentId),PNG);
    assert.equal(block.attachment.name.includes('/'),false);
    assert.equal(block.attachment.name.includes('\\'),false);
  }
  assert.match(blocks[0].text,/0\.91/);
  assert.match(blocks[1].text,/参考图/);
  assert.match(output.visualOutput.instruction,/中文/);
  assert.equal(blocks[0].text.includes(PNG.toString('base64')),false);
});

test('checks the latest session route before agent defaults',async t=>{
  const paths=await fixture(t);
  const {ctx,exec,calls}=harness({routed:{provider:'session-provider',model:'session-model'}});
  await prepareVisualOutput(ctx,exec,{},paths);
  assert.deepEqual(calls[0],{provider:'session-provider',model:'session-model',signal:undefined});
});

test('text-only and unknown modalities return metrics and paths without opening evidence',async()=>{
  for(const modalities of [['text'],undefined]){
    const {ctx,exec,store,saved}=harness();
    ctx.get('llm').resolveModelInfo=async()=>({inputModalities:modalities});
    store.saveImage=()=>assert.fail('must not save');
    const missing=join(tmpdir(),'this-file-does-not-exist.png');
    const output=await prepareVisualOutput(ctx,exec,{metrics:{delta:0.3}},[missing]);
    assert.equal(output.visualOutput.mode,'text');
    assert.equal(output.visualOutput.reason.code,'MODEL_IMAGE_INPUT_UNSUPPORTED');
    assert.equal(output.visualOutput.images[0].path,missing);
    assert.deepEqual(output.metrics,{delta:0.3});
    assert.equal(saved.size,0);
    assert.equal(renderVisualOutput({},output).length,1);
    assert.match(output.visualOutput.instruction,/不要声称看过截图/);
  }
});

test('missing services and unresolved route keep useful evidence without inventing images',async()=>{
  const path=join(tmpdir(),'missing-preview.png');
  for(const [setup,code] of [
    [{attachment:false},'ATTACHMENTS_UNAVAILABLE'],
    [{options:{}},'MODEL_ROUTE_UNRESOLVED'],
  ]){
    const {ctx,exec}=harness(setup);
    const output=await prepareVisualOutput(ctx,exec,{ok:true},[path]);
    assert.equal(output.ok,true);
    assert.equal(output.visualOutput.reason.code,code);
    assert.deepEqual(renderVisualOutput({},output).map(block=>block.type),['text']);
  }
});

test('enforces count, individual and aggregate byte limits before committing a batch',async t=>{
  const paths=await fixture(t,2);
  for(const [patch,code] of [
    [{maxImagesPerMessage:1},'TOO_MANY_PREVIEWS'],
    [{maxImageBytes:PNG.length-1},'PREVIEW_TOO_LARGE'],
    [{maxMessageImageBytes:PNG.length+10},'PREVIEW_TOO_LARGE'],
  ]){
    const {ctx,exec,store,saved,calls}=harness();
    Object.assign(store.imageLimits,patch);
    const output=await prepareVisualOutput(ctx,exec,{},paths);
    assert.equal(output.visualOutput.reason.code,code);
    assert.equal(saved.size,0);
    assert.equal(calls.some(call=>call.batch),false);
  }
});

test('uses file signatures and the store admission policy, preserving refusals as text',async t=>{
  const paths=await fixture(t);
  const path=join(join(paths[0].path,'..'),'preview.jpeg');
  await writeFile(path,PNG);
  const {ctx,exec,store}=harness();
  const output=await prepareVisualOutput(ctx,exec,{},[path]);
  assert.equal(output.visualOutput.images[0].attachment.mediaType,'image/png');
  store.imageLimits.mediaTypes=['image/jpeg'];
  const unsupported=await prepareVisualOutput(ctx,exec,{},[path]);
  assert.equal(unsupported.visualOutput.reason.code,'UNSUPPORTED_PREVIEW_TYPE');
  store.imageLimits.mediaTypes=['image/png'];
  store.saveImages=async()=>{throw Object.assign(new Error('invalid PNG decode'),{code:'INVALID_IMAGE'});};
  const invalid=await prepareVisualOutput(ctx,exec,{metrics:{ssim:1}},[path]);
  assert.equal(invalid.visualOutput.reason.code,'INVALID_IMAGE');
  assert.deepEqual(invalid.metrics,{ssim:1});
  assert.equal(renderVisualOutput({},invalid).some(block=>block.type==='image'),false);
});

test('does not serialize malformed, partial, or over-budget stored references into history',async t=>{
  const paths=await fixture(t);
  for(const refs of [[],[{}],[{attachmentId:'id',mediaType:'image/png',bytes:9000,width:1,height:1}]]){
    const {ctx,exec,store}=harness();
    store.saveImages=async()=>refs;
    const output=await prepareVisualOutput(ctx,exec,{},paths);
    assert.equal(output.visualOutput.mode,'text');
    assert.ok(['INVALID_ATTACHMENT_REFERENCE','PREVIEWS_TOO_LARGE'].includes(output.visualOutput.reason.code));
    assert.equal(renderVisualOutput({},output).length,1);
  }
});

test('supports the public single-image store method without embedding binary data',async t=>{
  const paths=await fixture(t);
  const {ctx,exec,store,saved}=harness();
  delete store.saveImages;
  const output=await prepareVisualOutput(ctx,exec,{},paths);
  assert.equal(output.visualOutput.mode,'images');
  assert.equal(saved.size,1);
  assert.equal(JSON.stringify(output).includes('"data"'),false);
});

test('propagates cancellation before reading and after attachment commit',async t=>{
  const paths=await fixture(t);
  for(const duringSave of [false,true]){
    const {ctx,exec,store}=harness();
    const controller=new AbortController();
    exec.signal=controller.signal;
    if(duringSave){
      const save=store.saveImages.bind(store);
      store.saveImages=async inputs=>{const refs=await save(inputs);controller.abort();return refs;};
    }else controller.abort();
    await assert.rejects(prepareVisualOutput(ctx,exec,{},paths),error=>error.name==='AbortError');
  }
});

test('rejects caller misuse rather than reading arbitrary relative evidence paths',async()=>{
  const {ctx,exec}=harness();
  await assert.rejects(prepareVisualOutput(ctx,exec,{},['relative.png']),/absolute plugin-owned/);
  const empty=await prepareVisualOutput(ctx,exec,{ok:true},[]);
  assert.equal(empty.visualOutput.reason.code,'NO_PREVIEW');
});
