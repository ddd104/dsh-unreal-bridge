import sharp from 'sharp';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setImmediate as yieldImmediate} from 'node:timers/promises';

export const VISUAL_CHECKS=Object.freeze(['color','structure','edges','pixels']);
export const DEFAULT_THRESHOLDS=Object.freeze({
  minSsim:0.98,maxMeanDeltaE:2.3,maxChangedPixelRatio:0.01,pixelDeltaE:3,
  maxEdgeDistancePx:2,maxMissingEdgeRatio:0.02,edgeTolerancePx:1,edgeThreshold:20
});
export const IMAGE_LIMITS=Object.freeze({maxInputBytes:64*1024*1024,maxPixels:8*1024*1024,maxDimension:16384});
const THRESHOLD_BOUNDS={minSsim:[-1,1],maxMeanDeltaE:[0,400],maxChangedPixelRatio:[0,1],pixelDeltaE:[0,400],maxEdgeDistancePx:[0,16384],maxMissingEdgeRatio:[0,1],edgeTolerancePx:[0,16384],edgeThreshold:[0,255]};
const SUPPORTED_FORMATS=new Set(['png','jpeg','webp']);
const LINEAR=Float64Array.from({length:256},(_,v)=>{const s=v/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});

function invalid(message,code='VISUAL_INVALID_INPUT'){const e=new Error(message);e.code=code;throw e;}
function abort(signal){signal?.throwIfAborted();}
async function checkpoint(signal){abort(signal);await yieldImmediate(undefined,{signal});}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function requiredPath(value,name){if(typeof value!=='string'||!value.trim()||value.includes('\0'))invalid(`${name} must be a nonempty local path`);return path.resolve(value);}

export function validateComparisonOptions(options){
  if(!object(options))invalid('Comparison options must be an object');
  const {referencePath,currentPath,outputDir,mode='regression',analysis='spatial',referenceRegion,currentRegion,checks=analysis==='color_distribution'?['color']:VISUAL_CHECKS,thresholds={},signal}=options;
  if(!['regression','assessment'].includes(mode))invalid('mode must be regression or assessment');
  if(!['spatial','color_distribution'].includes(analysis))invalid('analysis must be spatial or color_distribution');
  if(!Array.isArray(checks)||checks.length<1||checks.length>VISUAL_CHECKS.length||checks.some(v=>!VISUAL_CHECKS.includes(v))||new Set(checks).size!==checks.length)invalid(`checks must contain unique values from ${VISUAL_CHECKS.join(', ')}`);
  if(analysis==='color_distribution'&&checks.some(check=>check!=='color'))invalid('color_distribution supports only color checks; structure, edges, and pixels require spatial correspondence');
  if(!object(thresholds))invalid('thresholds must be an object');
  for(const [name,value] of Object.entries(thresholds)){
    const bounds=THRESHOLD_BOUNDS[name];
    if(!bounds||!Number.isFinite(value)||value<bounds[0]||value>bounds[1])invalid(`Invalid threshold ${name}`);
  }
  for(const [name,region] of Object.entries({referenceRegion,currentRegion})){
    if(region===undefined)continue;
    if(!object(region)||Object.keys(region).sort().join(',')!=='height,width,x,y'||['x','y','width','height'].some(k=>!Number.isSafeInteger(region[k]))||region.x<0||region.y<0||region.width<1||region.height<1)invalid(`${name} must be {x,y,width,height} with integer pixel coordinates and positive dimensions`);
  }
  if(signal!==undefined&&(!(signal instanceof AbortSignal)))invalid('signal must be an AbortSignal');
  return {referencePath:requiredPath(referencePath,'referencePath'),currentPath:requiredPath(currentPath,'currentPath'),outputDir:requiredPath(outputDir,'outputDir'),mode,analysis,referenceRegion,currentRegion,checks:[...checks],thresholds:{...DEFAULT_THRESHOLDS,...thresholds},signal};
}

async function decode(file,region,signal){
  abort(signal);
  const info=await stat(file);
  if(!info.isFile()||info.size>IMAGE_LIMITS.maxInputBytes)invalid('Image must be a regular file no larger than 64 MiB','VISUAL_IMAGE_LIMIT');
  const encoded=await readFile(file,{signal});
  if(encoded.length>IMAGE_LIMITS.maxInputBytes)invalid('Image exceeds 64 MiB','VISUAL_IMAGE_LIMIT');
  let metadata;
  try{metadata=await sharp(encoded,{limitInputPixels:IMAGE_LIMITS.maxPixels}).metadata();}catch{invalid('Cannot decode image or image exceeds the pixel limit','VISUAL_IMAGE_FORMAT');}
  if(!SUPPORTED_FORMATS.has(metadata.format)||metadata.depth!=='uchar'||(metadata.pages??1)>1)invalid('Use a single-frame 8-bit PNG, JPEG, or WebP image','VISUAL_IMAGE_FORMAT');
  const swap=[5,6,7,8].includes(metadata.orientation);
  const width=swap?metadata.height:metadata.width,height=swap?metadata.width:metadata.height;
  if(!width||!height||width>IMAGE_LIMITS.maxDimension||height>IMAGE_LIMITS.maxDimension||width*height>IMAGE_LIMITS.maxPixels)invalid('Image exceeds the 8 megapixel or 16384 pixel dimension limit','VISUAL_IMAGE_LIMIT');
  if(region&&(region.x+region.width>width||region.y+region.height>height))invalid('Region lies outside its EXIF-oriented image','VISUAL_REGION_OUT_OF_BOUNDS');
  let pipeline=sharp(encoded,{limitInputPixels:IMAGE_LIMITS.maxPixels}).rotate().toColourspace('srgb').flatten({background:'#ffffff'}).removeAlpha();
  if(region)pipeline=pipeline.extract({left:region.x,top:region.y,width:region.width,height:region.height});
  const {data,info:decoded}=await pipeline.raw().toBuffer({resolveWithObject:true});
  abort(signal);
  return {data,width:decoded.width,height:decoded.height,source:{width,height},region:region??{x:0,y:0,width,height},hasAlpha:metadata.hasAlpha===true};
}

function lab(r,g,b){
  const R=LINEAR[r],G=LINEAR[g],B=LINEAR[b];
  const f=t=>t>216/24389?Math.cbrt(t):(24389/27*t+16)/116;
  const x=f((0.4124564*R+0.3575761*G+0.1804375*B)/0.95047);
  const y=f(0.2126729*R+0.7151522*G+0.072175*B);
  const z=f((0.0193339*R+0.119192*G+0.9503041*B)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}

// Fixed-size histograms bound memory independently of the number of pixels.
// RGB quantiles are exact; the others round each sample to the nearest bin.
function distributionHistogram(maximum,bins){return {counts:new Uint32Array(bins),maximum};}
function addSample(histogram,value){histogram.counts[Math.round(Math.max(0,Math.min(histogram.maximum,value))/histogram.maximum*(histogram.counts.length-1))]++;}
function quantile(histogram,count,fraction){
  const rank=(count-1)*fraction,lower=Math.floor(rank),upper=Math.ceil(rank);let cumulative=0,lowValue,highValue;
  for(let i=0;i<histogram.counts.length;i++){
    cumulative+=histogram.counts[i];
    if(lowValue===undefined&&cumulative>lower)lowValue=i*histogram.maximum/(histogram.counts.length-1);
    if(cumulative>upper){highValue=i*histogram.maximum/(histogram.counts.length-1);break;}
  }
  return lowValue+(highValue-lowValue)*(rank-lower);
}
function summarize(histogram,count,total){return {mean:total/count,p10:quantile(histogram,count,0.1),p50:quantile(histogram,count,0.5),p90:quantile(histogram,count,0.9)};}
function rgbObject(values){return {r:values[0],g:values[1],b:values[2]};}
function labObject(values){return {l:values[0],a:values[1],b:values[2]};}
async function colorDistribution(image,signal){
  const count=image.width*image.height,rgb=Array.from({length:3},()=>distributionHistogram(255,256));
  const luminance=distributionHistogram(1,65536),lightness=distributionHistogram(100,16385),chroma=distributionHistogram(200,16385);
  const totalRgb=[0,0,0],totalLab=[0,0,0];let totalLuminance=0,totalChroma=0;
  for(let y=0;y<image.height;y++){
    if(y%64===0)await checkpoint(signal);
    for(let x=0;x<image.width;x++){
      const i=(y*image.width+x)*3,r=image.data[i],g=image.data[i+1],b=image.data[i+2];
      const values=lab(r,g,b),Y=0.2126*LINEAR[r]+0.7152*LINEAR[g]+0.0722*LINEAR[b],C=Math.hypot(values[1],values[2]);
      for(let c=0;c<3;c++){totalRgb[c]+=image.data[i+c];addSample(rgb[c],image.data[i+c]);totalLab[c]+=values[c];}
      totalLuminance+=Y;totalChroma+=C;addSample(luminance,Y);addSample(lightness,values[0]);addSample(chroma,C);
    }
  }
  return {sampleCount:count,meanRgb:rgbObject(totalRgb.map(value=>value/count)),medianRgb:rgbObject(rgb.map(histogram=>quantile(histogram,count,0.5))),meanLab:labObject(totalLab.map(value=>value/count)),relativeLuminance:summarize(luminance,count,totalLuminance),lightness:summarize(lightness,count,totalLab[0]),chroma:summarize(chroma,count,totalChroma)};
}
function summaryRatio(current,reference,reason){return reference===0?{value:null,reason}:{value:current/reference,reason:null};}
function summaryDifference(reference,current){return {meanDifference:current.mean-reference.mean,medianDifference:current.p50-reference.p50};}
function distributionDifference(reference,current){
  const subtract=(a,b)=>Object.fromEntries(Object.keys(a).map(key=>[key,b[key]-a[key]]));
  return {direction:'current_minus_reference',meanRgb:subtract(reference.meanRgb,current.meanRgb),medianRgb:subtract(reference.medianRgb,current.medianRgb),meanLab:subtract(reference.meanLab,current.meanLab),meanLabDeltaE76:Math.hypot(...Object.values(reference.meanLab).map((value,i)=>Object.values(current.meanLab)[i]-value)),relativeLuminance:{...summaryDifference(reference.relativeLuminance,current.relativeLuminance),p10Difference:current.relativeLuminance.p10-reference.relativeLuminance.p10,p90Difference:current.relativeLuminance.p90-reference.relativeLuminance.p90,meanRatio:summaryRatio(current.relativeLuminance.mean,reference.relativeLuminance.mean,'REFERENCE_MEAN_RELATIVE_LUMINANCE_ZERO'),medianRatio:summaryRatio(current.relativeLuminance.p50,reference.relativeLuminance.p50,'REFERENCE_MEDIAN_RELATIVE_LUMINANCE_ZERO')},lightness:summaryDifference(reference.lightness,current.lightness),chroma:summaryDifference(reference.chroma,current.chroma)};
}

async function colorMetrics(reference,current,width,height,thresholds,signal){
  const count=width*height,difference=Buffer.alloc(count*3),heatmap=Buffer.alloc(count*3);
  const grayReference=new Uint8Array(count),grayCurrent=new Uint8Array(count);
  let deltaTotal=0,deltaMax=0,rgbTotal=0,changed=0;
  for(let y=0;y<height;y++){
    if(y%64===0)await checkpoint(signal);
    for(let x=0;x<width;x++){
      const p=y*width+x,i=p*3;
      const ar=reference[i],ag=reference[i+1],ab=reference[i+2],br=current[i],bg=current[i+1],bb=current[i+2];
      const a=lab(ar,ag,ab),b=lab(br,bg,bb),delta=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
      deltaTotal+=delta;deltaMax=Math.max(deltaMax,delta);if(delta>thresholds.pixelDeltaE)changed++;
      for(let c=0;c<3;c++){const d=Math.abs(reference[i+c]-current[i+c]);difference[i+c]=d;rgbTotal+=d;}
      // Sequential black-red-yellow scale: black means no CIE76 color difference.
      const intensity=Math.min(1,delta/20);
      heatmap[i]=Math.round(Math.min(1,intensity*2)*255);heatmap[i+1]=Math.round(Math.max(0,intensity*2-1)*255);
      grayReference[p]=Math.round(0.2126*ar+0.7152*ag+0.0722*ab);
      grayCurrent[p]=Math.round(0.2126*br+0.7152*bg+0.0722*bb);
    }
  }
  return {color:{meanDeltaE:deltaTotal/count,maxDeltaE:deltaMax,meanAbsoluteRgbError:rgbTotal/(count*3)},pixels:{changedPixels:changed,totalPixels:count,changedRatio:changed/count,pixelDeltaE:thresholds.pixelDeltaE},difference,heatmap,grayReference,grayCurrent};
}

// Uniform 11x11 local SSIM at every pixel, clipped at image boundaries. Running
// column sums keep memory proportional to image width rather than image area.
async function localSsim(a,b,width,height,signal){
  const columns=Array.from({length:5},()=>new Float64Array(width));
  const update=(row,sign)=>{if(row<0||row>=height)return;for(let x=0;x<width;x++){const p=row*width+x,A=a[p],B=b[p];columns[0][x]+=sign*A;columns[1][x]+=sign*B;columns[2][x]+=sign*A*A;columns[3][x]+=sign*B*B;columns[4][x]+=sign*A*B;}};
  for(let y=0;y<Math.min(height,6);y++)update(y,1);
  let sum=0,min=1;
  for(let y=0;y<height;y++){
    if(y%64===0)await checkpoint(signal);
    if(y>0){update(y-6,-1);update(y+5,1);}
    const rows=Math.min(height-1,y+5)-Math.max(0,y-5)+1,sums=new Float64Array(5);
    for(let x=0;x<Math.min(width,6);x++)for(let k=0;k<5;k++)sums[k]+=columns[k][x];
    for(let x=0;x<width;x++){
      if(x>0)for(let k=0;k<5;k++){if(x>=6)sums[k]-=columns[k][x-6];if(x+5<width)sums[k]+=columns[k][x+5];}
      const n=rows*(Math.min(width-1,x+5)-Math.max(0,x-5)+1),ma=sums[0]/n,mb=sums[1]/n;
      const va=Math.max(0,sums[2]/n-ma*ma),vb=Math.max(0,sums[3]/n-mb*mb),cov=sums[4]/n-ma*mb;
      const score=Math.max(-1,Math.min(1,((2*ma*mb+6.5025)*(2*cov+58.5225))/((ma*ma+mb*mb+6.5025)*(va+vb+58.5225))));
      sum+=score;min=Math.min(min,score);
    }
  }
  return {ssim:sum/(width*height),minimumLocalSsim:min,windowSize:11};
}

async function edges(gray,width,height,threshold,signal){
  const mask=new Uint8Array(width*height);let count=0;
  for(let y=1;y<height-1;y++){
    if(y%64===0)await checkpoint(signal);
    for(let x=1;x<width-1;x++){
      const p=y*width+x,tl=gray[p-width-1],t=gray[p-width],tr=gray[p-width+1],l=gray[p-1],r=gray[p+1],bl=gray[p+width-1],b=gray[p+width],br=gray[p+width+1];
      const gx=-tl+tr-2*l+2*r-bl+br,gy=-tl-2*t-tr+bl+2*b+br;
      if(Math.hypot(gx,gy)/4>threshold){mask[p]=1;count++;}
    }
  }
  return {mask,count};
}

// Exact squared Euclidean distance transform (lower envelope of parabolas).
function distanceLine(f,n,out,v,z){
  let k=0;v[0]=0;z[0]=-Infinity;z[1]=Infinity;
  for(let q=1;q<n;q++){
    let s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]));
    while(s<=z[k]&&k>0){k--;s=((f[q]+q*q)-(f[v[k]]+v[k]*v[k]))/(2*(q-v[k]));}
    k++;v[k]=q;z[k]=s;z[k+1]=Infinity;
  }
  k=0;for(let q=0;q<n;q++){while(z[k+1]<q)k++;const d=q-v[k];out[q]=d*d+f[v[k]];}
}
async function distanceTransform(mask,width,height,signal){
  const distance=new Float32Array(width*height),length=Math.max(width,height),f=new Float64Array(length),out=new Float64Array(length),v=new Int32Array(length),z=new Float64Array(length+1);
  const far=width*width+height*height+1;
  for(let x=0;x<width;x++){
    if(x%64===0)await checkpoint(signal);
    for(let y=0;y<height;y++)f[y]=mask[y*width+x]?0:far;
    distanceLine(f,height,out,v,z);for(let y=0;y<height;y++)distance[y*width+x]=out[y];
  }
  for(let y=0;y<height;y++){
    if(y%64===0)await checkpoint(signal);
    for(let x=0;x<width;x++)f[x]=distance[y*width+x];
    distanceLine(f,width,out,v,z);for(let x=0;x<width;x++)distance[y*width+x]=out[x];
  }
  return distance;
}
function percentile95(values){
  let lo=0,hi=values.length-1;const target=Math.max(0,Math.ceil(values.length*0.95)-1);
  while(lo<hi){const pivot=values[(lo+hi)>>>1];let i=lo,j=hi;while(i<=j){while(values[i]<pivot)i++;while(values[j]>pivot)j--;if(i<=j){const t=values[i];values[i++]=values[j];values[j--]=t;}}if(target<=j)hi=j;else if(target>=i)lo=i;else break;}
  return values[target];
}
async function directionalEdges(source,target,width,height,tolerance,signal){
  if(source.count===0)return {edgeCount:0,meanDistancePx:0,p95DistancePx:0,unmatchedRatio:0};
  if(target.count===0)return {edgeCount:source.count,meanDistancePx:null,p95DistancePx:null,unmatchedRatio:1};
  const distance=await distanceTransform(target.mask,width,height,signal),values=new Float32Array(source.count);let total=0,unmatched=0,j=0;
  for(let y=0;y<height;y++){
    if(y%64===0)await checkpoint(signal);
    for(let x=0;x<width;x++){const p=y*width+x;if(!source.mask[p])continue;const d=Math.sqrt(distance[p]);values[j++]=d;total+=d;if(d>tolerance)unmatched++;}
  }
  return {edgeCount:source.count,meanDistancePx:total/source.count,p95DistancePx:percentile95(values),unmatchedRatio:unmatched/source.count};
}
async function edgeMetrics(a,b,width,height,thresholds,signal){
  const reference=await edges(a,width,height,thresholds.edgeThreshold,signal),current=await edges(b,width,height,thresholds.edgeThreshold,signal);
  const referenceToCurrent=await directionalEdges(reference,current,width,height,thresholds.edgeTolerancePx,signal),currentToReference=await directionalEdges(current,reference,width,height,thresholds.edgeTolerancePx,signal);
  const unavailable=referenceToCurrent.p95DistancePx===null||currentToReference.p95DistancePx===null;
  return {referenceEdgeCount:reference.count,currentEdgeCount:current.count,referenceToCurrent,currentToReference,symmetricP95DistancePx:unavailable?null:Math.max(referenceToCurrent.p95DistancePx,currentToReference.p95DistancePx),missingEdgeRatio:Math.max(referenceToCurrent.unmatchedRatio,currentToReference.unmatchedRatio),edgeThreshold:thresholds.edgeThreshold,edgeTolerancePx:thresholds.edgeTolerancePx};
}

function rawImage(image){return sharp(image.data,{raw:{width:image.width,height:image.height,channels:3}});}
async function evidenceImages(reference,current,outputDir,color,signal){
  abort(signal);await mkdir(outputDir,{recursive:true});
  const save=async(image,file)=>{const encoded=await image.png().toBuffer();abort(signal);await writeFile(file,encoded,{flag:'wx',signal});};
  const evidence={reference:path.join(outputDir,'reference.png'),current:path.join(outputDir,'current.png'),comparison:path.join(outputDir,'comparison.png')};
  await save(rawImage(reference),evidence.reference);
  await save(rawImage(current),evidence.current);
  const preview=[];
  for(const image of [reference,current])preview.push(await rawImage(image).resize({width:780,height:950,fit:'inside',withoutEnlargement:true}).png().toBuffer({resolveWithObject:true}));
  const [a,b]=preview,panelWidth=Math.max(200,a.info.width,b.info.width),width=panelWidth*2+16,height=Math.max(a.info.height,b.info.height)+32;
  const leftA=Math.floor((panelWidth-a.info.width)/2),leftB=panelWidth+16+Math.floor((panelWidth-b.info.width)/2);
  const labels=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32"><g fill="#f9fafb" font-family="sans-serif" font-size="15"><text x="12" y="22">Reference</text><text x="${panelWidth+28}" y="22">Current</text></g></svg>`);
  await save(sharp({create:{width,height,channels:3,background:'#1f2937'}}).composite([{input:a.data,left:leftA,top:32},{input:b.data,left:leftB,top:32},{input:labels,left:0,top:0}]),evidence.comparison);
  evidence.comparisonLayout={reference:{x:leftA,y:32,width:a.info.width,height:a.info.height},current:{x:leftB,y:32,width:b.info.width,height:b.info.height},scaledForPreview:a.info.width!==reference.width||a.info.height!==reference.height||b.info.width!==current.width||b.info.height!==current.height};
  if(color){
    evidence.difference=path.join(outputDir,'difference.png');evidence.heatmap=path.join(outputDir,'heatmap.png');
    await save(sharp(color.difference,{raw:{width:reference.width,height:reference.height,channels:3}}),evidence.difference);
    await save(sharp(color.heatmap,{raw:{width:reference.width,height:reference.height,channels:3}}),evidence.heatmap);
    evidence.heatmapPreview=path.join(outputDir,'heatmap-preview.png');
    await save(sharp(color.heatmap,{raw:{width:reference.width,height:reference.height,channels:3}}).resize({width:1560,height:950,fit:'inside',withoutEnlargement:true}),evidence.heatmapPreview);
  }
  abort(signal);return evidence;
}

/** Compare native-resolution, EXIF-oriented LDR images. Regions never resize or
 * register the image. Spatial regression assumes matching capture conditions;
 * assessment and independent color distributions always require review. */
export async function compareImages(options){
  const {referencePath,currentPath,outputDir,mode,analysis,referenceRegion,currentRegion,checks,thresholds,signal}=validateComparisonOptions(options);
  abort(signal);
  const reference=await decode(referencePath,referenceRegion,signal),current=await decode(currentPath,currentRegion,signal);
  const sameDimensions=reference.width===current.width&&reference.height===current.height;
  const result={mode,analysis,verdict:'unknown',dimensions:{reference:{width:reference.width,height:reference.height,source:reference.source,region:reference.region},current:{width:current.width,height:current.height,source:current.source,region:current.region}},thresholds,metrics:{},checks:[],observations:[],reasons:[],method:{color:'CIE76 Delta E in sRGB/D65',structure:'11x11 sliding uniform-window luminance SSIM',edges:'Sobel edges; maximum of both directional 95th-percentile Euclidean distances',alpha:'Composited on white',registration:'None; native-resolution pixels',heatmap:'Black-red-yellow; CIE76 Delta E 0 to 20, saturated above 20'}};
  if(reference.hasAlpha||current.hasAlpha)result.observations.push('Transparency was composited on white before comparison.');
  let color;
  if(analysis==='color_distribution'){
    const a=await colorDistribution(reference,signal),b=await colorDistribution(current,signal);
    result.metrics.colorDistribution={reference:a,current:b,difference:distributionDifference(a,b)};
    result.method={color:'Independent native-resolution ROI distributions in 8-bit sRGB and CIELAB/D65; mean Lab averages per-pixel Lab values. meanLabDeltaE76 compares those distribution means, not paired pixels.',relativeLuminance:'Unitless display-referred relative luminance: inverse sRGB transfer then 0.2126 R + 0.7152 G + 0.0722 B. Does not measure scene exposure or physical luminance.',chroma:'CIELAB C*ab = sqrt(a*^2 + b*^2), per pixel.',quantiles:'Linear interpolation at ranks (sampleCount - 1) * p; RGB exact. Relative luminance rounded to 1/65535; L* to 100/16384; C*ab to 200/16384.',alpha:'Composited on white',registration:'None; each ROI is sampled independently without resizing or pixel correspondence.',regionSelection:'Every pixel in the explicit rectangular ROI, or whole image when omitted; no semantic or color-based mask inferred.'};
    result.reasons.push('COLOR_DISTRIBUTION_REQUIRES_REVIEW: Descriptive ROI distributions do not establish semantic identity, aligned pixels, or a pass/fail verdict.');
    result.observations.push('Different framing, clouds, occlusion, post-processing, or selected regions may change these statistics. Relative luminance ratios cannot identify exposure or a material/light parameter change.');
    result.evidence=await evidenceImages(reference,current,outputDir,undefined,signal);
    return result;
  }
  if(sameDimensions){
    color=await colorMetrics(reference.data,current.data,reference.width,reference.height,thresholds,signal);
    result.metrics.color=color.color;result.metrics.pixels=color.pixels;
    if(checks.includes('structure'))result.metrics.structure=await localSsim(color.grayReference,color.grayCurrent,reference.width,reference.height,signal);
    if(checks.includes('edges'))result.metrics.edges=await edgeMetrics(color.grayReference,color.grayCurrent,reference.width,reference.height,thresholds,signal);
    const add=(name,passed,observation)=>{result.checks.push(mode==='regression'?{name,passed}:{name,withinThreshold:passed});if(!passed)result.observations.push(observation);};
    for(const check of checks){
      if(check==='color')add(check,color.color.meanDeltaE<=thresholds.maxMeanDeltaE,'Mean perceptual color difference exceeds its threshold.');
      if(check==='pixels')add(check,color.pixels.changedRatio<=thresholds.maxChangedPixelRatio,'The fraction of pixels above the color-difference tolerance exceeds its threshold.');
      if(check==='structure')add(check,result.metrics.structure.ssim>=thresholds.minSsim,'Local luminance structure similarity is below its threshold.');
      if(check==='edges'){const e=result.metrics.edges;add(check,e.symmetricP95DistancePx!==null&&e.symmetricP95DistancePx<=thresholds.maxEdgeDistancePx&&e.missingEdgeRatio<=thresholds.maxMissingEdgeRatio,'Detected luminance edge distances or the unmatched-edge ratio exceed configured tolerances.');if(!e.referenceEdgeCount&&!e.currentEdgeCount)result.observations.push('Neither image contains detected interior edges; the edge check provides no shape evidence.');}
    }
    if(mode==='regression')result.verdict=result.checks.every(c=>c.passed)?'pass':'fail';
    if(mode==='regression'&&checks.length===1&&checks[0]==='edges'&&!result.metrics.edges.referenceEdgeCount&&!result.metrics.edges.currentEdgeCount){
      result.verdict='unknown';result.checks[0].passed=null;
      result.reasons.push('NO_SHAPE_EVIDENCE: No detected edges are available for the requested shape-only comparison.');
    }
  }else result.reasons.push('DIMENSION_MISMATCH: ROI dimensions differ; no pixel alignment, resizing, or threshold verdict was applied.');
  if(mode==='assessment')result.reasons.push('ASSESSMENT_REQUIRES_REVIEW: Capture conditions and semantic correspondence are not established; metric thresholds do not determine the verdict.');
  else if(sameDimensions)result.reasons.push('REGRESSION_ASSUMES_MATCHING_CAPTURE: The verdict measures only the selected checks under the caller’s matching-capture assumption.');
  result.evidence=await evidenceImages(reference,current,outputDir,color,signal);
  return result;
}
