import React,{useEffect,useState} from 'react';
import {TYPERT_REMOTE} from './remote.mjs';
import {registerVisualToolviews} from './visual-client.mjs';

const h=React.createElement;
const colors={
  panel:'var(--dsw-alias-bg-layer-1, #fff)',
  surface:'var(--dsw-alias-bg-layer-2, #fff)',
  border:'var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
  text:'var(--dsw-alias-label-primary, #17191d)',
  muted:'var(--dsw-alias-label-secondary, #62666d)',
  accent:'var(--dsw-alias-brand-primary, #17191d)',
  online:'var(--dsw-alias-state-success-primary, #15803d)',
  warning:'var(--dsw-alias-state-warn-label, #a16207)',
  error:'var(--dsw-alias-state-error-primary, #b91c1c)'
};
const assetName=path=>path.split('/').pop()?.split('.')[0]||path;
const selectionName=item=>item.label||item.name||assetName(item.path);
const selectionType=item=>item.kind==='actor'?(item.runtime?'运行 Actor':'Actor'):item.kind==='component'?(item.runtime?'运行组件':item.source==='blueprint_editor'?'蓝图组件':'组件'):'资产';
const netModeLabel={standalone:'单机',client:'客户端',listen_server:'监听服务器',dedicated_server:'专用服务器'};
const runtimeIdentity=target=>[`PIE 实例 ${target.pieInstance}`,netModeLabel[target.netMode]??target.netMode].filter(Boolean).join(' · ');
const snapshotReason={actor_destroyed:'Actor 已销毁',object_destroyed:'对象已销毁',world_unloaded:'世界已卸载',pie_ended:'本次 PIE 已结束',tracking_evicted:'跟踪句柄已回收',session_changed:'运行会话已变化',editor_disconnected:'编辑器已离线'};
const snapshotStatus=snapshot=>snapshot.status==='disconnected'?'编辑器已离线':snapshot.status==='expired'?(snapshotReason[snapshot.reason]??'运行目标已失效'):'已采集';
const captureTime=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('zh-CN',{hour12:false});};

export const inject=['slots','sessions','remote'];

export function UnrealDock({read,bind}) {
  const [state,setState]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState(false);

  useEffect(()=>{
    let active=true;
    let timer;
    setState(null);
    setExpanded(false);
    const refresh=async()=>{
      try{
        const next=await read();
        if(active){setState(previous=>previous&&previous.version>next.version?previous:next);setError('');}
      }catch(e){if(active)setError(e.message??String(e));}
      finally{if(active)timer=setTimeout(refresh,700);}
    };
    refresh();
    return()=>{active=false;clearTimeout(timer);};
  },[read]);

  const select=async event=>{
    setBusy(true);
    setExpanded(false);
    try{setState(await bind(event.target.value||null));setError('');}
    catch(e){setError(e.message??String(e));}
    finally{setBusy(false);}
  };

  const assets=state?.selection??[];
  const connected=!!state?.connected;
  const count=assets.length;
  const types=[...new Set(assets.map(selectionType))];
  const selectionLabel=types.length===1?types[0]:'对象';
  const runtime=state?.runtime;
  const snapshots=(state?.runtimeSnapshots??[]).slice(-20).reverse();
  const runtimeLabel=!connected?(state?.editorId?'PIE 状态未知 · 编辑器已离线':'PIE 未开始'):!runtime?'PIE 状态暂不可用':runtime.status==='paused'?'PIE 已暂停':runtime.status==='running'?'PIE 运行中':'PIE 未开始 / 已结束';

  return h('section',{
    'aria-label':'Unreal Editor 工作区',
    style:{boxSizing:'border-box',width:'calc(100% - 16px)',maxWidth:712,margin:'0 auto 8px',padding:'10px 14px',border:`1px solid ${colors.border}`,borderRadius:12,backgroundColor:colors.panel,color:colors.text,boxShadow:'var(--dsw-elevation-panel, 0 2px 8px rgba(0,0,0,.08))',fontSize:12}
  },
    h('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',columnGap:12,rowGap:8}},
      h('div',{style:{display:'flex',alignItems:'center',gap:8,flex:'0 0 auto',fontWeight:600,fontSize:13,whiteSpace:'nowrap'}},
        h('span',{'aria-hidden':true,style:{display:'inline-block',width:8,height:8,borderRadius:2,backgroundColor:colors.accent,boxShadow:'0 0 0 3px var(--dsw-alias-border-l1, rgba(0,0,0,.04))'}}),
        'Unreal Editor'),
      h('select',{
        'aria-label':'选择编辑器实例',disabled:busy||!state,value:state?.editorId??'',onChange:select,
        style:{boxSizing:'border-box',flex:'1 1 200px',minWidth:0,height:32,padding:'0 10px',border:`1px solid ${colors.border}`,borderRadius:8,backgroundColor:colors.surface,color:colors.text,font:'inherit',outlineColor:colors.accent,cursor:busy?'wait':'pointer'}
      },
        h('option',{value:''},'选择要连接的项目'),
        ...(state?.editors??[]).map(e=>h('option',{key:e.editorId,value:e.editorId},`${e.project} · UE ${e.engineVersion} · ${e.pid}`)),
        state?.editorId&&!connected?h('option',{value:state.editorId},'已绑定的编辑器离线'):null),
      h('span',{role:'status',style:{display:'inline-flex',alignItems:'center',gap:6,flex:'0 0 auto',color:connected?colors.online:colors.muted,whiteSpace:'nowrap'}},
        h('span',{'aria-hidden':true,style:{width:6,height:6,borderRadius:'50%',backgroundColor:connected?colors.online:colors.muted}}),
        connected?'已连接':state?.editorId?'连接中断':'未连接')),
    state&&Object.hasOwn(state,'runtime')?h('div',{'aria-label':'PIE 运行状态',role:'status',style:{marginTop:8,color:connected&&runtime?.status==='running'?colors.online:runtime?.status==='paused'?colors.warning:colors.muted}},runtimeLabel,runtime?.isSimulating?' · 模拟运行（SIE）':null):null,
    h('div',{style:{display:'flex',alignItems:'center',minHeight:28,marginTop:8,paddingTop:8,borderTop:`1px solid ${colors.border}`}},
      count>0
        ?h('button',{
          type:'button','aria-expanded':expanded,'aria-controls':'unreal-bridge-assets',onClick:()=>setExpanded(value=>!value),
          style:{display:'inline-flex',alignItems:'center',gap:7,padding:0,border:0,background:'none',color:colors.text,font:'inherit',fontWeight:500,cursor:'pointer',outlineColor:colors.accent}
        },
          h('span',{'aria-hidden':true,style:{color:colors.accent,fontSize:14}},'▣'),
          `已选择 ${count} 个${selectionLabel}`,
          h('span',{'aria-hidden':true,style:{color:colors.muted,fontSize:10,transform:expanded?'rotate(180deg)':'none',transition:'transform 150ms'}},'▼'))
        :h('span',{style:{color:colors.muted}},connected?'未选择对象 · 可在内容浏览器或关卡中选择':'连接项目后可查看所选对象')),
    count>0&&expanded?h('ul',{
      id:'unreal-bridge-assets','aria-label':'已选择的对象',
      style:{boxSizing:'border-box',maxHeight:160,overflowY:'auto',overscrollBehavior:'contain',margin:'8px 0 0',padding:'4px 8px',listStyle:'none',border:`1px solid ${colors.border}`,borderRadius:8,backgroundColor:colors.surface}
    },assets.map((asset,index)=>h('li',{key:`${asset.path}-${index}`,style:{padding:'7px 5px',borderBottom:index<count-1?`1px solid ${colors.border}`:0,overflowWrap:'anywhere'}},
      h('div',{style:{fontWeight:500,color:colors.text}},`${selectionType(asset)} · ${selectionName(asset)}`),
      asset.kind==='component'?h('div',{style:{marginTop:2,color:colors.muted,fontSize:11}},`${asset.source==='blueprint_editor'?'所属蓝图':'所属 Actor'}：${asset.ownerLabel||asset.ownerPath}`):null,
      asset.runtime?h('div',{style:{marginTop:2,color:colors.muted,fontSize:11,lineHeight:1.4}},
        h('div',null,`${runtimeIdentity(asset.runtime)} · ${asset.runtime.status==='paused'?'已暂停':'运行中'}`),
        h('div',null,`世界：${asset.worldPath||asset.runtime.worldId}`)):null,
      h('div',{style:{marginTop:2,color:colors.muted,fontSize:11,lineHeight:1.4}},asset.path)))):null,
    snapshots.length>0?h('div',{'aria-label':'运行历史快照',style:{marginTop:8,paddingTop:8,borderTop:`1px solid ${colors.border}`}},
      h('div',{style:{fontWeight:500}},'运行历史快照'),
      h('div',{style:{marginTop:3,color:colors.muted,fontSize:11,lineHeight:1.4}},'以下为按需采集的历史数据，不随运行自动更新；可继续分析已失效或离线目标。'),
      h('ul',{'aria-label':'最近采集的运行快照',style:{maxHeight:180,overflowY:'auto',overscrollBehavior:'contain',margin:'6px 0 0',padding:0,listStyle:'none'}},
        snapshots.map(snapshot=>h('li',{key:snapshot.snapshotId,style:{padding:'5px 0',overflowWrap:'anywhere'}},
          h('div',{style:{fontWeight:500}},snapshot.label||assetName(snapshot.path),
            h('span',{style:{marginLeft:6,fontWeight:400,color:snapshot.status==='available'?colors.muted:colors.warning}},snapshotStatus(snapshot))),
          h('div',{style:{marginTop:2,color:colors.muted,fontSize:11,lineHeight:1.4}},
            h('time',{dateTime:snapshot.capturedAt},captureTime(snapshot.capturedAt)),` · 帧 ${snapshot.sampledFrame}`,
            snapshot.target?` · ${runtimeIdentity(snapshot.target)}`:null),
          h('div',{style:{marginTop:2,color:colors.muted,fontSize:11,lineHeight:1.4}},[snapshot.project,snapshot.path].filter(Boolean).join(' · ')))))):null,
    state?.uncertain?h('div',{role:'status',style:{color:colors.warning,marginTop:7,overflowWrap:'anywhere'}},`上次操作结果待确认：${state.uncertain.requestId}`):null,
    error?h('div',{role:'alert',style:{color:colors.error,marginTop:7,overflowWrap:'anywhere'}},error):null);
}

export async function apply(ctx) {
  await ctx.remote.$mount(TYPERT_REMOTE);
  registerVisualToolviews(ctx);
  ctx.inject(['remote.unrealBridge'],child=>{
    const using=(sessionId,call)=>child.sessions.using(sessionId,{source:'unrealBridge'},async reference=>{const state=reference.binding.session.getSnapshot();if(state.openState!=='open')throw state.openError??new Error('对话尚未就绪');const result=await call();if(!result.ok)throw new Error(result.error.message);return result.value;});
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'unreal-bridge',order:20,inject:sessionId=>({read:()=>using(sessionId,()=>child.remote.unrealBridge.state(sessionId)),bind:editorId=>using(sessionId,()=>child.remote.unrealBridge.bind(sessionId,editorId))})},UnrealDock));
  });
}
