import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {VisualToolCard,visualCardModel,registerVisualToolviews} from '../src/visual-client.mjs';

const image=(attachmentId,name='evidence.png')=>({attachmentId,mediaType:'image/png',bytes:90,width:100,height:50,name});
const result=(value,images=[])=>({kind:'tool-result',seq:1,time:1,callId:'call-1',name:'unreal_visual_compare',args:{},call:{name:'unreal_visual_compare',argsRaw:'{}'},callTime:0,isError:false,subCalls:[],content:[{type:'text',text:JSON.stringify(value)},...images.map(attachment=>({type:'image',attachment}))]});
const makeProps=(block,overrides={})=>({toolName:'unreal_visual_compare',phase:'result',callId:'call-1',block,openFile:()=>{},loadImage:async()=>assert.fail('the view must delegate loading to the official gallery'),...overrides});
const text=tree=>JSON.stringify(tree.toJSON());

test('registers both tool names in the existing session toolview slot without claiming the read_image child',()=>{
  const entries=[],deferred=[];
  const ctx={slots:{inject:(name,callback)=>{assert.equal(name,'tool.call.toolview');deferred.push(callback);},register:(definition,component)=>{
    assert.equal(definition.children,undefined,'tool.call.images already has an exclusive declaring owner');
    entries.push({definition,component});return()=>{};
  }}};
  registerVisualToolviews(ctx);
  assert.equal(entries.length,0);
  deferred.forEach(callback=>callback());
  assert.deepEqual(entries.map(entry=>entry.definition.key),['unreal_visual_capture','unreal_visual_compare']);
  assert.ok(entries.every(entry=>entry.definition.name==='tool.call.toolview'&&entry.component===VisualToolCard));
});

test('renders comparison, heatmap and numeric summary through the authorized official gallery',async()=>{
  const comparison=image('comparison'),heatmap=image('heatmap'),stale=image('stale-json-copy');
  const block=result({ok:true,comparisonId:'comparison-1',verdict:'fail',metrics:{structure:{ssim:0.98765},color:{meanDeltaE:2.3456},pixels:{changedRatio:0.035},edges:{symmetricP95DistancePx:2.25}},reportPath:'F:/evidence/report.json',visualOutput:{mode:'images',images:[{attachment:stale}] }},[comparison,heatmap]);
  const galleryCalls=[],opened=[];
  const props=makeProps(block,{openFile:path=>opened.push(path)});
  props.renderFactorySlot=(name,owner,options)=>{
    galleryCalls.push({name,owner,options});
    return React.createElement('div',{'data-gallery':name},owner.images.map(item=>React.createElement('span',{key:item.attachment.attachmentId},item.attachment.attachmentId)));
  };
  let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(VisualToolCard,props));});
  assert.equal(galleryCalls.length,2);
  assert.ok(galleryCalls.every(call=>call.name==='conversation.images.content'&&call.owner.loadImage===props.loadImage&&call.owner.align==='start'));
  assert.deepEqual(galleryCalls.map(call=>call.owner.images.map(entry=>entry.attachment.attachmentId)),[['comparison'],['heatmap']]);
  assert.match(text(tree),/差异超出阈值/);
  for(const snippet of ['0.9877','2.35','3.50%','2.25 px','对比图','差异热图','点击图片查看大图'])assert.ok(text(tree).includes(snippet),snippet);
  assert.equal(text(tree).includes('stale-json-copy'),false);
  assert.equal(text(tree).includes('参考图（左）'),false,'the comparison itself already contains left/right labels');
  await act(async()=>tree.root.findByType('button').props.onClick());
  assert.deepEqual(opened,['F:/evidence/report.json']);
  await act(async()=>tree.unmount());
});

test('regional color results show descriptive statistics despite different dimensions without implying an exposure difference',()=>{
  const block=result({ok:true,analysis:'color_distribution',verdict:'unknown',dimensions:{reference:{width:100,height:20},current:{width:60,height:30}},metrics:{colorDistribution:{reference:{relativeLuminance:{mean:0.05}},current:{relativeLuminance:{mean:0.12}},difference:{meanLabDeltaE76:5.1}}},visualOutput:{mode:'images'}},[image('comparison')]);
  const model=visualCardModel(makeProps(block));
  assert.deepEqual(model.metrics.map(metric=>metric.value),['5.10','0.0500','0.1200']);
  assert.match(model.message,/不要求像素对齐/);assert.match(model.message,/不代表曝光差/);assert.equal(model.status,'待确认');
  assert.equal(model.metrics.some(metric=>/SSIM|P95|变化像素/.test(metric.label)),false);
});

test('preparing, running, cancelled and failed calls remain usable without a gallery',async()=>{
  for(const [phase,block,expected] of [
    ['preparing',{phase:'preparing',name:'unreal_visual_compare',args:{}},'准备中'],
    ['start',{phase:'start',name:'unreal_visual_compare',argsRaw:'{}',args:{}},'处理中'],
    ['result',result({ok:false,error:{code:'CANCELLED',message:'用户取消了截图'}}),'已取消'],
    ['result',result({ok:false,error:{code:'FS_DENIED',message:'参考图片不可读取'}},[image('unexpected-image')]),'参考图片不可读取'],
    ['result',{...result(null),isError:true,error:{name:'Error',code:'TIMEOUT',reason:'截图超时'}},'截图超时'],
  ]){
    let tree;
    await act(async()=>{tree=Renderer.create(React.createElement(VisualToolCard,makeProps(block,{phase,renderFactorySlot:()=>assert.fail('no gallery for pending/error outcomes')})));});
    assert.match(text(tree),new RegExp(expected));
    assert.equal(tree.root.findAllByType('figure').length,0);
    await act(async()=>tree.unmount());
  }
});

test('text fallback retains metric summary and the exact image-delivery reason',async()=>{
  const block=result({ok:true,verdict:'unknown',metrics:{structure:{ssim:0.9}},visualOutput:{mode:'text',reason:{code:'MODEL_IMAGE_INPUT_UNSUPPORTED',message:'当前模型不支持图片输入，请切换模型。'},images:[{attachment:image('metadata-only')}]}});
  let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(VisualToolCard,makeProps(block,{renderFactorySlot:()=>assert.fail('JSON refs must never become gallery images')})));});
  assert.match(text(tree),/待确认/);
  assert.match(text(tree),/0.9000/);
  assert.match(text(tree),/当前模型不支持图片输入/);
  assert.equal(tree.root.findAllByType('figure').length,0);
  await act(async()=>tree.unmount());
});

test('metadata refs cannot resurrect images removed by post-execute hooks',()=>{
  const block=result({ok:true,verdict:'pass',visualOutput:{mode:'images',images:[{attachment:image('old-result')}]}});
  const model=visualCardModel(makeProps(block));
  assert.equal(model.images.length,0);
  assert.match(model.message,/没有可显示的图片/);
});

test('ignores malformed image blocks and distinguishes pixel dimension uncertainty',()=>{
  const block=result({ok:true,verdict:'unknown',dimensions:{reference:{width:100,height:100},current:{width:90,height:100}},metrics:{structure:{ssim:NaN},edges:{symmetricP95DistancePx:null}}},[{},image('good'),{...image('bad'),width:-1}]);
  const model=visualCardModel(makeProps(block));
  assert.deepEqual(model.images.map(entry=>entry.attachment.attachmentId),['good']);
  assert.deepEqual(model.metrics,[]);
  assert.match(model.message,/尺寸不同/);
});

test('captures show the returned native image and degrade clearly when gallery presentation is absent',async()=>{
  const block=result({ok:true,captureId:'capture-1',visualOutput:{mode:'images'}},[image('capture')]);
  let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(VisualToolCard,makeProps(block,{toolName:'unreal_visual_capture'})));});
  assert.match(text(tree),/UE 视口截图/);
  assert.match(text(tree),/截图完成/);
  assert.match(text(tree),/当前截图/);
  assert.match(text(tree),/图片预览暂不可用/);
  assert.equal(tree.root.findAllByType('img').length,0,'no private attachment URL is fabricated');
  await act(async()=>tree.unmount());
});
