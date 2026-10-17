import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {compareImages,validateComparisonOptions,DEFAULT_THRESHOLDS,IMAGE_LIMITS} from '../src/visual-compare.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-visual-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function image(file,width,height,pixel){
  const data=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const value=pixel(x,y);for(let c=0;c<3;c++)data[(y*width+x)*3+c]=value[c];}
  await sharp(data,{raw:{width,height,channels:3}}).png().toFile(file);
}
const box=(x,y)=>x>=8&&x<24&&y>=8&&y<24?[220,80,30]:[12,20,36];
const options=dir=>({referencePath:path.join(dir,'ref.png'),currentPath:path.join(dir,'cur.png'),outputDir:path.join(dir,'evidence')});

test('identical native images pass all checks and produce valid evidence',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,32,32,box);await image(args.currentPath,32,32,box);
  const result=await compareImages(args);
  assert.equal(result.verdict,'pass');assert.equal(result.metrics.structure.ssim,1);
  assert.equal(result.metrics.color.meanDeltaE,0);assert.equal(result.metrics.pixels.changedRatio,0);
  assert.equal(result.metrics.edges.symmetricP95DistancePx,0);assert.equal(result.metrics.edges.missingEdgeRatio,0);
  assert.equal(result.checks.length,4);assert.ok(result.checks.every(check=>check.passed));
  for(const file of Object.values(result.evidence).filter(value=>typeof value==='string'))assert.equal((await sharp(file).metadata()).format,'png');
  const diff=await sharp(result.evidence.difference).raw().toBuffer();assert.ok(diff.every(v=>v===0));
  assert.equal(result.dimensions.reference.width,32);assert.equal(result.evidence.comparisonLayout.scaledForPreview,false);
  assert.doesNotThrow(()=>JSON.parse(JSON.stringify(result)));
});

test('a known changed patch fails and the full-resolution heatmap localizes it',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,40,40,()=>[100,100,100]);
  await image(args.currentPath,40,40,(x,y)=>x>=10&&x<20&&y>=10&&y<20?[240,20,20]:[100,100,100]);
  const result=await compareImages(args);
  assert.equal(result.verdict,'fail');assert.equal(result.metrics.pixels.changedPixels,100);
  assert.equal(result.metrics.pixels.changedRatio,100/1600);
  assert.ok(result.metrics.color.meanDeltaE>2.3);assert.ok(result.metrics.structure.ssim<0.98);
  const heat=await sharp(result.evidence.heatmap).raw().toBuffer();
  assert.deepEqual([...heat.subarray(0,3)],[0,0,0]);assert.ok(heat[(10*40+10)*3]>0);
  assert.equal(result.metrics.edges.referenceEdgeCount,0);assert.ok(result.metrics.edges.currentEdgeCount>0);
  assert.equal(result.metrics.edges.symmetricP95DistancePx,null);assert.equal(result.metrics.edges.missingEdgeRatio,1);
});

test('edge distances detect a translated shape and are symmetric',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,40,32,box);
  await image(args.currentPath,40,32,(x,y)=>box(x-4,y));
  const result=await compareImages({...args,checks:['edges'],thresholds:{maxEdgeDistancePx:1,maxMissingEdgeRatio:0.01}});
  assert.equal(result.verdict,'fail');assert.ok(result.metrics.edges.symmetricP95DistancePx>=4);
  assert.ok(result.metrics.edges.referenceToCurrent.p95DistancePx>=4);assert.ok(result.metrics.edges.currentToReference.p95DistancePx>=4);
  assert.ok(result.metrics.edges.missingEdgeRatio>0.1);
});

test('dimension mismatch stays unknown without resizing or pixel metrics',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,32,32,box);await image(args.currentPath,64,32,box);
  const result=await compareImages(args);
  assert.equal(result.verdict,'unknown');assert.deepEqual(result.metrics,{});assert.deepEqual(result.checks,[]);
  assert.match(result.reasons.join(' '),/DIMENSION_MISMATCH/);assert.equal(result.evidence.heatmap,undefined);
  assert.equal((await sharp(result.evidence.reference).metadata()).width,32);
  assert.equal((await sharp(result.evidence.current).metadata()).width,64);
});

test('assessment remains unknown even when dimensions and all thresholds match',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,32,32,box);await image(args.currentPath,32,32,box);
  const result=await compareImages({...args,mode:'assessment'});
  assert.equal(result.verdict,'unknown');assert.equal(result.metrics.color.meanDeltaE,0);
  assert.ok(result.checks.every(check=>check.passed===undefined&&check.withinThreshold===true));
  assert.match(result.reasons.join(' '),/ASSESSMENT_REQUIRES_REVIEW/);
});

test('blank images provide pixel evidence but cannot pass a shape-only comparison',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,24,24,()=>[70,80,90]);await image(args.currentPath,24,24,()=>[70,80,90]);
  const shape=await compareImages({...args,checks:['edges']});
  assert.equal(shape.verdict,'unknown');assert.equal(shape.checks[0].passed,null);
  assert.match(shape.reasons.join(' '),/NO_SHAPE_EVIDENCE/);
  const pixels=await compareImages({...args,outputDir:path.join(dir,'all-checks')});
  assert.equal(pixels.verdict,'pass');assert.equal(pixels.metrics.pixels.changedRatio,0);
  assert.match(pixels.observations.join(' '),/no shape evidence/);
});

test('explicit regions compare their native pixels and reject out-of-bounds coordinates',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,32,32,box);
  await image(args.currentPath,48,40,(x,y)=>box(x-5,y-3));
  const result=await compareImages({...args,referenceRegion:{x:4,y:4,width:24,height:24},currentRegion:{x:9,y:7,width:24,height:24}});
  assert.equal(result.verdict,'pass');assert.equal(result.dimensions.current.width,24);assert.deepEqual(result.dimensions.current.source,{width:48,height:40});
  await assert.rejects(compareImages({...args,referenceRegion:{x:31,y:0,width:2,height:2}}),{code:'VISUAL_REGION_OUT_OF_BOUNDS'});
});

test('previews are bounded while analysis and evidence retain original resolution',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,2048,128,(x,y)=>[(x+y)%256,x%256,y%256]);
  await writeFile(args.currentPath,await readFile(args.referencePath));
  const result=await compareImages({...args,checks:['pixels']});
  const original=await sharp(result.evidence.reference).metadata(),preview=await sharp(result.evidence.comparison).metadata(),heat=await sharp(result.evidence.heatmapPreview).metadata();
  assert.equal(original.width,2048);assert.equal(result.metrics.pixels.totalPixels,2048*128);
  assert.ok(preview.width<=1600&&preview.height<=1000);assert.ok(heat.width<=1600&&heat.height<=1000);
  assert.equal(result.evidence.comparisonLayout.scaledForPreview,true);
});

test('options reject invalid thresholds, checks, and fractional regions before reading files',()=>{
  const args={referencePath:'missing-a.png',currentPath:'missing-b.png',outputDir:'out'};
  for(const extra of [{mode:'automatic'},{checks:[]},{checks:['pixels','pixels']},{thresholds:{maxMeanDeltaE:NaN}},{thresholds:{unexpected:1}},{thresholds:{maxChangedPixelRatio:2}},{referenceRegion:{x:0.5,y:0,width:1,height:1}}])assert.throws(()=>validateComparisonOptions({...args,...extra}),{code:'VISUAL_INVALID_INPUT'});
  assert.deepEqual(validateComparisonOptions(args).thresholds,DEFAULT_THRESHOLDS);
});

test('unsupported, oversized-dimension, and aborted inputs fail without creating evidence',async t=>{
  const dir=await fixture(t),args=options(dir);
  await writeFile(args.referencePath,'not an image');
  await image(args.currentPath,1,1,()=>[1,2,3]);
  await assert.rejects(compareImages(args),{code:'VISUAL_IMAGE_FORMAT'});
  await image(args.referencePath,IMAGE_LIMITS.maxDimension+1,1,()=>[1,2,3]);
  await assert.rejects(compareImages(args),{code:'VISUAL_IMAGE_LIMIT'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(compareImages({...args,signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(access(args.outputDir));
});

test('existing evidence and source files are never overwritten',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,8,8,()=>[100,110,120]);await image(args.currentPath,8,8,()=>[100,110,120]);
  const source=await readFile(args.referencePath);
  // An output directory coinciding with the input directory must fail exclusive
  // creation rather than replace a potentially alpha-bearing source image.
  const collision=path.join(dir,'reference.png');await writeFile(collision,source);
  await assert.rejects(compareImages({...args,referencePath:collision,outputDir:dir}),{code:'EEXIST'});
  assert.deepEqual(await readFile(collision),source);
});

test('color distributions compare different native dimensions without paired pixel verdicts or heatmaps',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,16,12,()=>[86,112,154]);await image(args.currentPath,2048,3,()=>[86,112,154]);
  const result=await compareImages({...args,analysis:'color_distribution'}),{reference,current,difference}=result.metrics.colorDistribution;
  assert.equal(result.analysis,'color_distribution');assert.equal(result.verdict,'unknown');assert.deepEqual(result.checks,[]);
  assert.equal(reference.sampleCount,192);assert.equal(current.sampleCount,6144);
  assert.deepEqual(reference.meanRgb,{r:86,g:112,b:154});assert.deepEqual(current.medianRgb,reference.meanRgb);
  assert.ok(difference.meanLabDeltaE76<1e-10);assert.ok(Math.abs(difference.relativeLuminance.meanRatio.value-1)<1e-10);
  assert.deepEqual(Object.keys(result.metrics),['colorDistribution']);assert.equal(result.evidence.heatmap,undefined);assert.equal(result.evidence.difference,undefined);
  assert.equal((await sharp(result.evidence.current).metadata()).width,2048);assert.equal(result.evidence.comparisonLayout.scaledForPreview,true);
  assert.doesNotMatch(result.reasons.join(' '),/DIMENSION_MISMATCH/);assert.match(result.reasons.join(' '),/COLOR_DISTRIBUTION_REQUIRES_REVIEW/);
});

test('brightness distributions use linear relative luminance and robust quantiles rather than gamma-coded RGB',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,10,10,()=>[128,128,128]);
  await image(args.currentPath,10,10,(x,y)=>x===9&&y===9?[255,255,255]:[64,64,64]);
  const result=await compareImages({...args,analysis:'color_distribution',mode:'assessment'}),{reference,current,difference}=result.metrics.colorDistribution;
  const linear=v=>((v/255+0.055)/1.055)**2.4;
  assert.ok(Math.abs(reference.relativeLuminance.mean-linear(128))<1e-12);
  assert.ok(Math.abs(current.relativeLuminance.mean-(99*linear(64)+1)/100)<1e-12);
  assert.ok(Math.abs(current.relativeLuminance.p50-linear(64))<1/65535);
  assert.ok(Math.abs(difference.relativeLuminance.medianRatio.value-linear(64)/linear(128))<0.0001);
  assert.ok(difference.relativeLuminance.medianRatio.value<0.25);
  assert.deepEqual(current.medianRgb,{r:64,g:64,b:64});assert.ok(difference.lightness.medianDifference<0);
  assert.match(result.method.relativeLuminance,/inverse sRGB/);assert.match(result.observations.join(' '),/cannot identify exposure/);
});

test('Lab means average per-pixel Lab and distribution summaries ignore pixel ordering',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,10,2,x=>x<5?[0,0,0]:[255,255,255]);
  await image(args.currentPath,5,4,(x,y)=>(x+y*5)%2?[0,0,0]:[255,255,255]);
  const result=await compareImages({...args,analysis:'color_distribution'}),{reference,current,difference}=result.metrics.colorDistribution;
  assert.equal(reference.meanRgb.r,127.5);assert.equal(reference.medianRgb.r,127.5);
  assert.ok(Math.abs(reference.meanLab.l-50)<0.001);assert.ok(Math.abs(current.meanLab.l-50)<0.001);
  assert.equal(reference.relativeLuminance.p10,0);assert.equal(reference.relativeLuminance.p50,0.5);assert.equal(reference.relativeLuminance.p90,1);
  assert.ok(difference.meanLabDeltaE76<1e-10);assert.equal(difference.relativeLuminance.medianDifference,0);
});

test('chroma and channel differences describe a more saturated current region',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,8,8,()=>[100,100,100]);await image(args.currentPath,9,9,()=>[190,80,30]);
  const result=await compareImages({...args,analysis:'color_distribution'}),{reference,current,difference}=result.metrics.colorDistribution;
  assert.deepEqual(difference.meanRgb,{r:90,g:-20,b:-70});assert.equal(difference.direction,'current_minus_reference');
  assert.ok(reference.chroma.mean<0.001);assert.ok(current.chroma.mean>50);assert.ok(difference.chroma.medianDifference>50);
  assert.ok(difference.meanLab.a>0);assert.ok(difference.meanLab.b>0);assert.ok(difference.meanLabDeltaE76>50);
});

test('black reference luminance produces explicit unavailable ratios and lossless JSON values',async t=>{
  const dir=await fixture(t),args=options(dir);
  await image(args.referencePath,4,4,()=>[0,0,0]);await image(args.currentPath,5,5,()=>[100,100,100]);
  const result=await compareImages({...args,analysis:'color_distribution'}),difference=result.metrics.colorDistribution.difference;
  assert.deepEqual(difference.relativeLuminance.meanRatio,{value:null,reason:'REFERENCE_MEAN_RELATIVE_LUMINANCE_ZERO'});
  assert.deepEqual(difference.relativeLuminance.medianRatio,{value:null,reason:'REFERENCE_MEDIAN_RELATIVE_LUMINANCE_ZERO'});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('color distributions use every requested ROI pixel without inferring a color or sky mask',async t=>{
  const dir=await fixture(t),args=options(dir),sky=[100,140,180],ground=[180,60,20];
  await image(args.referencePath,10,10,(x,y)=>y<2?sky:ground);
  await image(args.currentPath,20,10,(x,y)=>y<6?sky:ground);
  const full=await compareImages({...args,analysis:'color_distribution'}),stats=full.metrics.colorDistribution;
  assert.equal(stats.reference.sampleCount,100);assert.equal(stats.current.sampleCount,200);
  assert.deepEqual(stats.reference.meanRgb,{r:164,g:76,b:52});assert.ok(stats.difference.meanLabDeltaE76>0);
  assert.match(full.method.regionSelection,/no semantic or color-based mask inferred/);
  const cropped=await compareImages({...args,analysis:'color_distribution',outputDir:path.join(dir,'cropped'),referenceRegion:{x:1,y:0,width:7,height:2},currentRegion:{x:2,y:1,width:13,height:4}});
  assert.equal(cropped.metrics.colorDistribution.reference.sampleCount,14);assert.equal(cropped.metrics.colorDistribution.current.sampleCount,52);
  assert.ok(cropped.metrics.colorDistribution.difference.meanLabDeltaE76<1e-10);
  assert.deepEqual(cropped.dimensions.current.region,{x:2,y:1,width:13,height:4});
  assert.equal((await sharp(cropped.evidence.current).metadata()).width,13);
});

test('analysis options default to spatial and distribution rejects incompatible checks',()=>{
  const args={referencePath:'missing-a.png',currentPath:'missing-b.png',outputDir:'out'};
  assert.equal(validateComparisonOptions(args).analysis,'spatial');
  assert.deepEqual(validateComparisonOptions({...args,analysis:'color_distribution'}).checks,['color']);
  assert.deepEqual(validateComparisonOptions({...args,analysis:'color_distribution',checks:['color']}).checks,['color']);
  for(const extra of [{analysis:'sky'},{analysis:'color_distribution',checks:['color','structure']},{analysis:'color_distribution',checks:['pixels']},{analysis:'color_distribution',checks:['edges']}])assert.throws(()=>validateComparisonOptions({...args,...extra}),{code:'VISUAL_INVALID_INPUT'});
});
