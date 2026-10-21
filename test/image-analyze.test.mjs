import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,copyFile,open,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import sharp from 'sharp';
import {analyzeImage} from '../src/image-analyze.mjs';
import {VisualService} from '../src/visual.mjs';
import {imageAnalyzeSchema} from '../src/protocol.mjs';
import {IMAGE_LIMITS} from '../src/visual-compare.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'dsh-image-analysis-')),disposals=[];
  t.after(async()=>{
    for(const dispose of disposals)await dispose();
    const target=await realpath(dir),root=await realpath(tmpdir()),child=relative(root,target);
    assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child),'Only remove this test directory beneath the resolved temporary root');
    await rm(target,{recursive:true,force:true});
  });
  return {dir,disposals};
}

async function image(file,width,height,pixel,{channels=4,orientation,format='png'}={}){
  const data=Buffer.alloc(width*height*channels);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const rgba=pixel(x,y);
    for(let c=0;c<channels;c++)data[(y*width+x)*channels+c]=rgba[c];
  }
  let pipeline=sharp(data,{raw:{width,height,channels}});
  if(orientation)pipeline=pipeline.withMetadata({orientation});
  await pipeline.toFormat(format,format==='webp'?{lossless:true}:{}).toFile(file);
}

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} should equal ${expected}`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function service(f,options={}){
  const bridge=new EventEmitter();
  bridge.config={stateDir:f.dir};
  bridge.target=()=>assert.fail('Image analysis must not require an editor binding');
  bridge.request=()=>assert.fail('Image analysis must not send editor requests');
  const visual=new VisualService(bridge,options);
  f.disposals.push(()=>visual.dispose());
  return visual;
}

test('RGBA measurements preserve hidden RGB, source alpha, histogram, and original bytes',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'rgba.png');
  const pixels=[[200,10,20,0],[10,20,30,64],[40,50,60,128],[70,80,90,255]];
  await image(imagePath,4,1,x=>pixels[x]);
  const original=await readFile(imagePath);
  const result=await analyzeImage({imagePath,samples:pixels.map((_,x)=>({x,y:0})),includeAlphaHistogram:true});
  assert.deepEqual(result.samples.map(sample=>sample.rgba),pixels);
  assert.deepEqual(result.sourceRgb.allPixels.mean,[80,40,50]);
  assert.deepEqual(result.sourceRgb.nontransparentPixels.mean,[40,50,60]);
  assert.equal(result.sourceRgb.nontransparentPixels.pixelCount,3);
  assert.equal(result.alpha.transparentPixels,1);
  assert.equal(result.alpha.partialPixels,2);
  assert.equal(result.alpha.opaquePixels,1);
  assert.equal(result.alpha.distinctValues,4);
  assert.equal(result.alpha.mean,447/4);
  near(result.alpha.meanOpacity,447/(4*255));
  assert.equal(result.alpha.histogram.length,256);
  for(let value=0;value<256;value++)assert.equal(result.alpha.histogram[value],[0,64,128,255].includes(value)?1:0);
  assert.deepEqual(result.alpha.coverage,{threshold:0,comparison:'alpha > threshold',pixels:3,ratio:0.75,bounds:{x:1,y:0,width:3,height:1}});
  assert.equal(result.source.hasAlpha,true);
  assert.equal(result.source.sha256,hash(original));
  assert.equal(result.source.encodedBytes,original.length);
  assert.deepEqual(result.composites,[]);
  assert.match(result.observations.join(' '),/transparent pixels does not establish visible color/);
  assert.deepEqual(await readFile(imagePath),original);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('fully transparent and alpha-threshold-empty regions have null visible bounds and finite summaries',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'transparent.png');
  await image(imagePath,2,2,(x,y)=>[10+x,20+y,30,0]);
  const transparent=await analyzeImage({imagePath,backgrounds:[[255,255,255]]});
  assert.deepEqual(transparent.sourceRgb.nontransparentPixels,{pixelCount:0,mean:null,min:null,max:null});
  assert.deepEqual(transparent.alpha.coverage,{threshold:0,comparison:'alpha > threshold',pixels:0,ratio:0,bounds:null});
  assert.deepEqual(transparent.composites[0].rgb.mean,[255,255,255]);
  assert.equal(transparent.alpha.histogram,undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(transparent)),transparent);
  await image(imagePath,2,1,x=>[50,60,70,x===0?127:128]);
  const thresholded=await analyzeImage({imagePath,alphaThreshold:128});
  assert.equal(thresholded.alpha.coverage.pixels,0);
  assert.equal(thresholded.alpha.coverage.bounds,null);
  assert.equal(thresholded.sourceRgb.nontransparentPixels.pixelCount,2);
  const lower=await analyzeImage({imagePath,alphaThreshold:127});
  assert.deepEqual(lower.alpha.coverage.bounds,{x:1,y:0,width:1,height:1});
  assert.equal(lower.alpha.coverage.pixels,1);
});

test('images without alpha are explicitly opaque in every supported encoding',async t=>{
  const {dir}=await fixture(t);
  for(const format of ['png','jpeg','webp']){
    const imagePath=join(dir,`opaque.${format}`);
    await image(imagePath,3,2,()=>[90,110,130],{channels:3,format});
    const result=await analyzeImage({imagePath,samples:[{x:2,y:1}]});
    assert.equal(result.source.format,format);
    assert.equal(result.source.hasAlpha,false);
    assert.equal(result.alpha.min,255);
    assert.equal(result.alpha.max,255);
    assert.equal(result.alpha.meanOpacity,1);
    assert.equal(result.alpha.opaquePixels,6);
    assert.equal(result.samples[0].rgba[3],255);
    assert.deepEqual(result.sourceRgb.allPixels,result.sourceRgb.nontransparentPixels);
    assert.match(result.observations.join(' '),/no alpha channel/);
  }
});

test('ROI measurements and samples use full source coordinates and never resize',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'region.png');
  await image(imagePath,5,4,(x,y)=>[x*20,y*30,x+y,x===3&&y===2?120:0]);
  const region={x:2,y:1,width:2,height:2};
  const result=await analyzeImage({imagePath,region,samples:[{x:2,y:1},{x:3,y:2}]});
  assert.deepEqual(result.region,region);
  assert.equal(result.pixelCount,4);
  assert.equal(result.source.width,5);
  assert.equal(result.source.height,4);
  assert.deepEqual(result.samples.map(sample=>sample.rgba),[[40,30,3,0],[60,60,5,120]]);
  assert.deepEqual(result.sourceRgb.allPixels.mean,[50,45,4]);
  assert.deepEqual(result.alpha.coverage.bounds,{x:3,y:2,width:1,height:1});
  await assert.rejects(analyzeImage({imagePath,region:{x:4,y:3,width:2,height:1}}),{code:'IMAGE_ANALYSIS_REGION'});
  for(const sample of [{x:0,y:0},{x:4,y:1},{x:2,y:3}])
    await assert.rejects(analyzeImage({imagePath,region,samples:[sample]}),{code:'IMAGE_ANALYSIS_SAMPLE'});
});

test('all EXIF orientations including mirrors map samples and ROI bounds into oriented coordinates',async t=>{
  const {dir}=await fixture(t);
  // Stored rows are A B C / D E F. Each value also has a distinct alpha.
  const pixels=Array.from({length:6},(_,index)=>[20+index*20,40,80,25+index*40]);
  const maps=[
    [[0,1,2],[3,4,5]],[[2,1,0],[5,4,3]],[[5,4,3],[2,1,0]],[[3,4,5],[0,1,2]],
    [[0,3],[1,4],[2,5]],[[3,0],[4,1],[5,2]],[[5,2],[4,1],[3,0]],[[2,5],[1,4],[0,3]]
  ];
  for(let orientation=1;orientation<=8;orientation++){
    const imagePath=join(dir,`orientation-${orientation}.png`),map=maps[orientation-1];
    await image(imagePath,3,2,(x,y)=>pixels[y*3+x],{orientation});
    const samples=map.flatMap((row,y)=>row.map((_,x)=>({x,y})));
    const result=await analyzeImage({imagePath,samples});
    assert.equal(result.source.orientation,orientation);
    assert.equal(result.source.storedWidth,3);
    assert.equal(result.source.storedHeight,2);
    assert.equal(result.source.width,map[0].length);
    assert.equal(result.source.height,map.length);
    assert.deepEqual(result.samples.map(sample=>sample.rgba),map.flat().map(index=>pixels[index]));
    const region={x:1,y:1,width:1,height:1};
    const cropped=await analyzeImage({imagePath,region,samples:[{x:1,y:1}]});
    assert.deepEqual(cropped.samples[0].rgba,pixels[map[1][1]]);
    assert.deepEqual(cropped.alpha.coverage.bounds,region);
  }
});

test('explicit background composites are separate display-space results and do not alter source statistics',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'composites.png');
  const pixels=[[200,0,20,0],[40,80,120,128],[10,20,30,255]];
  await image(imagePath,3,1,x=>pixels[x]);
  const plain=await analyzeImage({imagePath,samples:[{x:1,y:0}]});
  const backgrounds=[[0,0,0],[255,255,255],[25,50,75]];
  const result=await analyzeImage({imagePath,backgrounds,samples:[{x:1,y:0}]});
  assert.deepEqual(result.sourceRgb,plain.sourceRgb);
  assert.deepEqual(result.alpha,plain.alpha);
  assert.deepEqual(result.samples,plain.samples);
  assert.deepEqual(result.source,plain.source);
  for(let index=0;index<backgrounds.length;index++){
    const {background,rgb}=result.composites[index];
    assert.deepEqual(background,backgrounds[index]);
    assert.equal(rgb.pixelCount,3);
    for(let channel=0;channel<3;channel++){
      const values=pixels.map(pixel=>pixel[channel]*(pixel[3]/255)+background[channel]*(1-pixel[3]/255));
      near(rgb.mean[channel],values.reduce((sum,value)=>sum+value,0)/3);
      near(rgb.min[channel],Math.min(...values));
      near(rgb.max[channel],Math.max(...values));
    }
  }
  assert.match(result.method.composition,/not linear-light or UE rendering/);
  assert.match(result.method.coverage,/no semantic shape, angle, or material inference/);
});

test('schema rejects excessive samples, composites, unsafe values, and unknown fields before reading',async()=>{
  const base={imagePath:'does-not-exist.png'};
  const invalid=[
    {samples:Array.from({length:65},()=>({x:0,y:0}))},
    {backgrounds:Array.from({length:5},()=>[0,0,0])},
    {backgrounds:[[0,256,0]]},{backgrounds:[[0,1]]},
    {alphaThreshold:255},{alphaThreshold:-1},{alphaThreshold:0.5},
    {region:{x:0,y:0,width:0,height:1}},
    {region:{x:0.5,y:0,width:1,height:1}},
    {samples:[{x:0,y:Infinity}]},{unexpected:true}
  ];
  for(const extra of invalid){
    assert.equal(imageAnalyzeSchema.safeParse({...base,...extra}).success,false);
    await assert.rejects(analyzeImage({...base,...extra}),{name:'ZodError'});
  }
});

test('invalid formats, corrupt payloads, dimensions, pixel limits, and byte limits are rejected',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'invalid.image');
  await writeFile(imagePath,'not an image');
  await assert.rejects(analyzeImage({imagePath}),{code:'IMAGE_ANALYSIS_FORMAT'});
  await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).tiff().toFile(imagePath);
  await assert.rejects(analyzeImage({imagePath}),{code:'IMAGE_ANALYSIS_FORMAT'});
  const encoded=await sharp({create:{width:10,height:10,channels:4,background:{r:12,g:30,b:44,alpha:0.5}}}).png().toBuffer();
  const corrupt=encoded.subarray(0,encoded.length-20);
  assert.equal((await sharp(corrupt).metadata()).width,10,'Exercise payload decoding after valid metadata');
  await writeFile(imagePath,corrupt);
  await assert.rejects(analyzeImage({imagePath}),{code:'IMAGE_ANALYSIS_FORMAT'});
  assert.deepEqual(await readFile(imagePath),corrupt);
  await image(imagePath,IMAGE_LIMITS.maxDimension+1,1,()=>[10,20,30,255]);
  await assert.rejects(analyzeImage({imagePath}),{code:'IMAGE_ANALYSIS_LIMIT'});
  await sharp({create:{width:4096,height:2049,channels:3,background:'#123456'}}).png().toFile(imagePath);
  await assert.rejects(analyzeImage({imagePath}),error=>['IMAGE_ANALYSIS_FORMAT','IMAGE_ANALYSIS_LIMIT'].includes(error.code));
  const handle=await open(imagePath,'w');
  try{await handle.truncate(IMAGE_LIMITS.maxInputBytes+1);}finally{await handle.close();}
  await assert.rejects(analyzeImage({imagePath}),{code:'IMAGE_ANALYSIS_LIMIT'});
  await assert.rejects(analyzeImage({imagePath:dir}),{code:'IMAGE_ANALYSIS_LIMIT'});
});

test('analysis handles cancellation before I/O and while an operation is active without altering its source',async t=>{
  const {dir}=await fixture(t),imagePath=join(dir,'cancel.png');
  const before=new AbortController();before.abort();
  await assert.rejects(analyzeImage({imagePath},{signal:before.signal}),{name:'AbortError'});
  await sharp({create:{width:2048,height:1024,channels:4,background:{r:50,g:90,b:130,alpha:0.5}}}).png().toFile(imagePath);
  const original=await readFile(imagePath),during=new AbortController();
  const operation=analyzeImage({imagePath,backgrounds:[[0,0,0],[255,255,255]]},{signal:during.signal});
  const timer=setTimeout(()=>during.abort(),10);
  try{await assert.rejects(operation,{name:'AbortError'});}finally{clearTimeout(timer);}
  assert.deepEqual(await readFile(imagePath),original);
});

test('service uses the host reader without editor access, writes an accurate report, and owns its disposable cache files',async t=>{
  const f=await fixture(t),imagePath=join(f.dir,'original.png'),calls=[];
  await image(imagePath,2,1,x=>x?[30,60,90,128]:[240,20,10,0]);
  const original=await readFile(imagePath),exec={marker:'filesystem policy context'};
  const visual=service(f,{readReference:async(source,destination,context)=>{
    calls.push({source,destination,context});
    await copyFile(source,destination);
  }});
  const result=await visual.analyze('unbound-chat',{imagePath,samples:[{x:1,y:0}]},exec);
  assert.equal(calls.length,1);
  assert.equal(calls[0].source,imagePath);
  assert.equal(calls[0].context,exec);
  assert.equal(result.source.path,imagePath);
  assert.equal(result.source.sha256,hash(original));
  assert.deepEqual(result.samples[0].rgba,[30,60,90,128]);
  assert.deepEqual(JSON.parse(await readFile(result.reportPath,'utf8')),result);
  assert.deepEqual(await readFile(calls[0].destination),original);
  const status=await visual.cache.status();
  assert.equal(status.skippedUnsafe,0);
  assert.equal(status.visual.files,2);
  assert.equal(status.visual.entries,1);
  assert.ok(status.visual.bytes>original.length);
  assert.equal(visual.cache.pins.size,0);
  const cleanup=await visual.cache.cleanup({mode:'all_idle'});
  assert.equal(cleanup.deleted.visualEntries,1);
  assert.equal(cleanup.deleted.files,2);
  await assert.rejects(access(result.reportPath),{code:'ENOENT'});
  assert.deepEqual(await readFile(imagePath),original);
});

test('service enforces absolute paths and host read limits, releases pins on error, and recovers its queue',async t=>{
  const f=await fixture(t),visual=service(f),imagePath=join(f.dir,'input.image');
  await assert.rejects(visual.analyze('chat',{imagePath:'relative.png'}),{code:'INVALID_REFERENCE'});
  await writeFile(imagePath,'invalid');
  await assert.rejects(visual.analyze('chat',{imagePath}),{code:'IMAGE_ANALYSIS_FORMAT'});
  assert.equal(visual.cache.pins.size,0);
  await image(imagePath,1,1,()=>[1,2,3,64]);
  assert.equal((await visual.analyze('chat',{imagePath})).alpha.mean,64);
  const handle=await open(imagePath,'w');
  try{await handle.truncate(20*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(visual.analyze('chat',{imagePath}),{code:'INVALID_IMAGE'});
  assert.equal(visual.cache.pins.size,0);
});

test('service cancellation while queued returns CANCELLED and does not poison later analyses',async t=>{
  const f=await fixture(t),imagePath=join(f.dir,'queued.png');
  await image(imagePath,1,1,()=>[10,20,30,128]);
  const copied=Promise.withResolvers(),gate=Promise.withResolvers();
  const visual=service(f,{readReference:async(source,destination)=>{
    await copyFile(source,destination);copied.resolve();
  }});
  visual.comparisonQueue=gate.promise;
  const controller=new AbortController();
  const operation=visual.analyze('chat',{imagePath},{signal:controller.signal});
  await copied.promise;
  controller.abort();gate.resolve();
  await assert.rejects(operation,{code:'CANCELLED'});
  assert.equal(visual.cache.pins.size,0);
  assert.equal((await visual.analyze('chat',{imagePath})).alpha.mean,128);
});
