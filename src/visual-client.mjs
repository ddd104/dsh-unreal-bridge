import React from 'react';

const h=React.createElement;
const TOOLS=['unreal_visual_capture','unreal_visual_compare'];
const color={text:'var(--dsw-alias-label-primary, #17191d)',muted:'var(--dsw-alias-label-secondary, #62666d)',border:'var(--dsw-alias-border-l2, rgba(0,0,0,.1))',panel:'var(--dsw-alias-bg-layer-1, #fff)',success:'var(--dsw-alias-state-success-primary, #15803d)',warning:'var(--dsw-alias-state-warn-label, #a16207)',error:'var(--dsw-alias-state-error-primary, #b91c1c)'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const number=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):null;

function resultValue(content){
  for(const part of content??[]){
    if(part?.type!=='text'||typeof part.text!=='string')continue;
    try{
      const value=JSON.parse(part.text);
      if(object(value)&&(typeof value.ok==='boolean'||value.visualOutput||value.comparisonId||value.captureId))return value;
    }catch{}
  }
  return null;
}

function imageReference(ref){
  if(!object(ref)||typeof ref.attachmentId!=='string'||ref.attachmentId.length===0
    ||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mediaType)
    ||![ref.bytes,ref.width,ref.height].every(value=>Number.isSafeInteger(value)&&value>0))return null;
  return ref;
}

export function visualCardModel({toolName,phase,block}){
  const comparison=toolName==='unreal_visual_compare';
  const title=comparison?'UE 视觉对比':'UE 视口截图';
  const settled=phase==='result'||block?.kind==='tool-result';
  if(!settled)return {title,status:phase==='preparing'?'准备中':'处理中',state:'pending',metrics:[],images:[],message:comparison?'正在截取目标并分析参考图。':'正在截取当前目标区域。'};
  const content=Array.isArray(block?.content)?block.content:[];
  const value=resultValue(content);
  if(block?.isError||value?.ok===false){
    const code=value?.error?.code??block?.error?.code;
    const cancelled=['CANCELLED','ABORTED','AbortError'].includes(code);
    const rawText=content.find(part=>part?.type==='text'&&typeof part.text==='string')?.text;
    return {title,status:cancelled?'已取消':'操作失败',state:cancelled?'warning':'error',metrics:[],images:[],message:value?.error?.message??block?.error?.reason??rawText??'未能完成本次视觉操作。'};
  }
  const metrics=[];
  const ssim=number(value?.metrics?.structure?.ssim,4);
  const delta=number(value?.metrics?.color?.meanDeltaE);
  const changed=number(typeof value?.metrics?.pixels?.changedRatio==='number'?value.metrics.pixels.changedRatio*100:undefined);
  const edges=number(value?.metrics?.edges?.symmetricP95DistancePx);
  if(ssim!==null)metrics.push({label:'结构相似度',value:ssim});
  if(delta!==null)metrics.push({label:'平均色差 ΔE',value:delta});
  if(changed!==null)metrics.push({label:'变化像素',value:`${changed}%`});
  if(edges!==null)metrics.push({label:'边缘偏移 P95',value:`${edges} px`});
  const distribution=value?.metrics?.colorDistribution;
  if(distribution){
    const regionalDelta=number(distribution.difference?.meanLabDeltaE76);
    if(regionalDelta!==null)metrics.push({label:'区域均值色差 ΔE',value:regionalDelta});
    const referenceLuminance=number(distribution.reference?.relativeLuminance?.mean,4),currentLuminance=number(distribution.current?.relativeLuminance?.mean,4);
    if(referenceLuminance!==null)metrics.push({label:'参考区域线性相对亮度',value:referenceLuminance});
    if(currentLuminance!==null)metrics.push({label:'当前区域线性相对亮度',value:currentLuminance});
  }
  // The native image blocks are the authoritative returned evidence. Never
  // reconstruct images from JSON metadata: a post-execute hook may replace
  // content, leaving an obsolete copy of a previously produced reference.
  const images=content.filter(part=>part?.type==='image').map(part=>imageReference(part.attachment)).filter(Boolean).map((attachment,index)=>({attachment,label:comparison?(index===0?'对比图':index===1?'差异热图':`证据图 ${index+1}`):'当前截图'}));
  const verdict=value?.verdict;
  const status=!comparison?'截图完成':verdict==='pass'?'检查通过':verdict==='fail'?'差异超出阈值':'待确认';
  const state=verdict==='pass'?'success':verdict==='fail'?'error':comparison?'warning':'success';
  let message='';
  if(value?.visualOutput?.mode==='text')message=value.visualOutput.reason?.message??'当前模型未接收图片，数值和本机证据仍可使用。';
  else if(comparison&&verdict==='unknown'){
    const a=value?.dimensions?.reference,b=value?.dimensions?.current;
    message=value?.analysis==='color_distribution'?'按各自选定区域比较颜色分布；不要求像素对齐。构图和云层占比仍可能影响统计，图像相对亮度不代表曝光差。':a&&b&&(a.width!==b.width||a.height!==b.height)?'参考区域与当前区域的尺寸不同，不能按像素给出通过结论。':'视角、比例或曝光等对比条件尚未确认，请结合图片判断。';
  }
  if(!images.length&&!message)message='本次记录中没有可显示的图片。';
  return {title,status,state,metrics,images,message,reportPath:typeof value?.reportPath==='string'?value.reportPath:undefined};
}

/** One tool card using the same official gallery Factory as DSH read_image. */
export function VisualToolCard(props){
  const model=visualCardModel(props);
  const tone=color[model.state]??color.muted;
  const galleryUnavailable=h('p',{style:{margin:'6px 0',color:color.muted}},'图片预览暂不可用。');
  return h('section',{'aria-label':model.title,style:{margin:'8px 0',padding:'12px 14px',border:`1px solid ${color.border}`,borderRadius:10,background:color.panel,color:color.text,fontSize:12,overflowWrap:'anywhere'}},
    h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
      h('strong',{style:{fontSize:13}},model.title),
      h('span',{role:model.state==='error'?'alert':'status',style:{fontWeight:500,color:tone}},model.status)),
    model.metrics.length?h('dl',{'aria-label':'对比指标',style:{display:'flex',flexWrap:'wrap',gap:'12px 22px',margin:'12px 0'}},model.metrics.map(metric=>h('div',{key:metric.label},h('dt',{style:{color:color.muted,fontSize:11,marginBottom:3}},metric.label),h('dd',{style:{margin:0,fontVariantNumeric:'tabular-nums'}},metric.value)))):null,
    model.message?h('p',{role:model.state==='error'?'alert':undefined,style:{margin:'9px 0 0',lineHeight:1.5,color:model.state==='error'?color.error:color.muted}},model.message):null,
    model.images.length?h('div',{'aria-label':'截图证据',style:{display:'flex',flexWrap:'wrap',alignItems:'start',gap:16,marginTop:12}},model.images.map((image,index)=>h('figure',{key:`${image.attachment.attachmentId}-${index}`,style:{margin:0,minWidth:0,maxWidth:'100%'}},
      typeof props.renderFactorySlot==='function'&&typeof props.loadImage==='function'
        ?props.renderFactorySlot('conversation.images.content',{images:[image],loadImage:props.loadImage,align:'start'},{fallback:galleryUnavailable})
        :galleryUnavailable,
      h('figcaption',{style:{color:color.muted,fontSize:11,marginTop:5}},image.label)))):null,
    model.images.length?h('p',{style:{color:color.muted,fontSize:11,margin:'8px 0 0'}},'点击图片查看大图。'):null,
    model.reportPath&&typeof props.openFile==='function'?h('button',{type:'button',onClick:()=>props.openFile(model.reportPath),style:{marginTop:10,padding:0,border:0,background:'none',color:color.text,textDecoration:'underline',font:'inherit',cursor:'pointer'}},'打开对比报告'):null);
}

/**
 * tool.call.images has one existing declaring owner (DSH read_image). Reusing
 * its public conversation.images.content Factory avoids duplicate child-slot
 * declarations and preserves the session-authorized loadImage capability.
 */
export function registerVisualToolviews(ctx){
  for(const key of TOOLS)ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key},VisualToolCard));
}
