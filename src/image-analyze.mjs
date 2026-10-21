import sharp from 'sharp';
import {readFile,stat} from 'node:fs/promises';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {imageAnalyzeSchema,fail} from './protocol.mjs';
import {IMAGE_LIMITS} from './visual-compare.mjs';

const average=(sum,count)=>count?sum.map(value=>value/count):null;
const extrema=()=>({min:[255,255,255],max:[0,0,0],sum:[0,0,0],count:0});
function accumulate(stats,values){
  stats.count++;
  for(let c=0;c<3;c++){
    stats.min[c]=Math.min(stats.min[c],values[c]);
    stats.max[c]=Math.max(stats.max[c],values[c]);
    stats.sum[c]+=values[c];
  }
}
const summarize=stats=>({pixelCount:stats.count,mean:average(stats.sum,stats.count),min:stats.count?stats.min:null,max:stats.count?stats.max:null});

/** Read source alpha before any background composition. No shape or material inference. */
export async function analyzeImage(options,{signal}={}){
  const args=imageAnalyzeSchema.parse(options);
  signal?.throwIfAborted();
  const file=await stat(args.imagePath);
  if(!file.isFile()||file.size>IMAGE_LIMITS.maxInputBytes)fail('IMAGE_ANALYSIS_LIMIT','Use an image file no larger than 64 MiB');
  const encoded=await readFile(args.imagePath,{signal});
  if(encoded.length>IMAGE_LIMITS.maxInputBytes)fail('IMAGE_ANALYSIS_LIMIT','Image exceeds 64 MiB');
  let metadata;
  try{metadata=await sharp(encoded,{limitInputPixels:IMAGE_LIMITS.maxPixels}).metadata();}
  catch{signal?.throwIfAborted();fail('IMAGE_ANALYSIS_FORMAT','Cannot decode the image or it exceeds the pixel limit');}
  if(!['png','jpeg','webp'].includes(metadata.format)||metadata.depth!=='uchar'||(metadata.pages??1)!==1)
    fail('IMAGE_ANALYSIS_FORMAT','Use a single-frame 8-bit PNG, JPEG, or WebP image');
  const rotated=[5,6,7,8].includes(metadata.orientation);
  const width=rotated?metadata.height:metadata.width,height=rotated?metadata.width:metadata.height;
  if(!width||!height||width>IMAGE_LIMITS.maxDimension||height>IMAGE_LIMITS.maxDimension||width*height>IMAGE_LIMITS.maxPixels)
    fail('IMAGE_ANALYSIS_LIMIT','Image exceeds 8 megapixels or a 16384 pixel dimension');
  const region=args.region??{x:0,y:0,width,height};
  if(region.x+region.width>width||region.y+region.height>height)
    fail('IMAGE_ANALYSIS_REGION','Region lies outside the EXIF-oriented image');
  for(const {x,y} of args.samples){
    if(x<region.x||y<region.y||x>=region.x+region.width||y>=region.y+region.height)
      fail('IMAGE_ANALYSIS_SAMPLE','Each sample must lie inside the selected region in source coordinates');
  }
  // Decode to straight/unassociated 8-bit RGBA. Colour conversion never flattens alpha.
  let decoded;
  try{
    decoded=await sharp(encoded,{limitInputPixels:IMAGE_LIMITS.maxPixels})
      .rotate().toColourspace('srgb').ensureAlpha()
      .extract({left:region.x,top:region.y,width:region.width,height:region.height})
      .raw().toBuffer({resolveWithObject:true});
  }catch{signal?.throwIfAborted();fail('IMAGE_ANALYSIS_FORMAT','Cannot decode the image pixel payload');}
  const {data,info}=decoded;
  signal?.throwIfAborted();
  if(info.channels!==4)fail('IMAGE_ANALYSIS_FORMAT','Decoder did not produce RGBA');
  const histogram=new Array(256).fill(0),all=extrema(),visible=extrema();
  const composed=args.backgrounds.map(background=>({background,stats:extrema()}));
  let alphaSum=0,minX=region.width,minY=region.height,maxX=-1,maxY=-1,covered=0;
  for(let y=0;y<region.height;y++){
    if(y%32===0){signal?.throwIfAborted();await yieldImmediate(undefined,{signal});}
    for(let x=0;x<region.width;x++){
      const offset=(y*region.width+x)*4,rgba=data.subarray(offset,offset+4),a=rgba[3];
      histogram[a]++;alphaSum+=a;accumulate(all,rgba);
      if(a>0)accumulate(visible,rgba);
      if(a>args.alphaThreshold){
        covered++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
      for(const item of composed){
        // Explicit display-space interpolation, not physical/linear-light rendering.
        const opacity=a/255;
        accumulate(item.stats,[0,1,2].map(c=>rgba[c]*opacity+item.background[c]*(1-opacity)));
      }
    }
  }
  const count=region.width*region.height;
  const levels=histogram.map((pixelCount,value)=>({value,pixelCount})).filter(level=>level.pixelCount>0);
  const samples=args.samples.map(({x,y})=>{
    const offset=((y-region.y)*region.width+x-region.x)*4,rgba=[...data.subarray(offset,offset+4)];
    return {x,y,rgba,opacity:rgba[3]/255};
  });
  return {
    source:{sha256:createHash('sha256').update(encoded).digest('hex'),format:metadata.format,encodedBytes:encoded.length,
      storedWidth:metadata.width,storedHeight:metadata.height,width,height,orientation:metadata.orientation??1,
      sourceColorSpace:metadata.space??'unknown',hasEmbeddedProfile:!!metadata.icc,hasAlpha:metadata.hasAlpha===true,bitDepth:8},
    region,pixelCount:count,samples,
    sourceRgb:{allPixels:summarize(all),nontransparentPixels:summarize(visible)},
    alpha:{min:levels[0].value,max:levels.at(-1).value,mean:alphaSum/count,meanOpacity:alphaSum/(count*255),
      transparentPixels:histogram[0],opaquePixels:histogram[255],partialPixels:count-histogram[0]-histogram[255],
      distinctValues:levels.length,dominantValues:[...levels].sort((a,b)=>b.pixelCount-a.pixelCount||a.value-b.value).slice(0,8),
      ...(args.includeAlphaHistogram?{histogram}:{}),
      coverage:{threshold:args.alphaThreshold,comparison:'alpha > threshold',pixels:covered,ratio:covered/count,
        bounds:covered?{x:region.x+minX,y:region.y+minY,width:maxX-minX+1,height:maxY-minY+1}:null}},
    composites:composed.map(item=>({background:item.background,rgb:summarize(item.stats)})),
    method:{pixels:'EXIF-oriented, unassociated 8-bit sRGB RGBA; no resizing or alpha flattening',
      color:'Decoded and converted to sRGB; these are decoded pixels, not encoded file bytes or Unreal material inputs',
      composition:'C = source_sRGB * alpha + background_sRGB * (1-alpha); unrounded display-space values, not linear-light or UE rendering',
      coordinates:'Full EXIF-oriented source pixels, including region bounds and samples',
      coverage:'Alpha-threshold bounding rectangle only; no semantic shape, angle, or material inference'},
    observations:[
      ...(metadata.hasAlpha?[]:['Source has no alpha channel; all decoded pixels have alpha 255.']),
      ...(histogram[0]?['RGB stored under fully transparent pixels does not establish visible color.']:[]),
      'Source measurements and optional background composites do not independently establish the final engine-rendered appearance.'
    ]
  };
}
