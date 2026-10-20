import React,{useEffect,useRef,useState} from 'react';
const h=React.createElement;
const size=bytes=>`${((bytes??0)/1024/1024).toFixed(1)} MiB`;

/** Explicit page access scans once; the conversation's status poll never does. */
export function CachePanel({read,cleanup}) {
  const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null),[confirm,setConfirm]=useState(false);
  const alive=useRef(false);
  useEffect(()=>{
    alive.current=true;let cancelled=false;setBusy(true);
    read().then(value=>{if(!cancelled)setState(value);},e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setBusy(false);});
    return()=>{cancelled=true;alive.current=false;};
  },[read]);
  const run=async mode=>{
    setBusy(true);setError('');setConfirm(false);
    try{
      const outcome=mode?await cleanup({mode}):null;
      const next=await read();
      if(alive.current){setState(next);setResult(outcome);}
    }catch(e){if(alive.current)setError(e.message??String(e));}
    finally{if(alive.current)setBusy(false);}
  };
  const button=(label,action)=>h('button',{type:'button',disabled:busy,onClick:action,style:{padding:'7px 12px',border:'1px solid var(--dsw-alias-border-l2, #d5d8dc)',borderRadius:6,background:'var(--dsw-alias-bg-layer-2, #fff)',color:'inherit',font:'inherit',cursor:busy?'wait':'pointer'}},label);
  return h('section',{'aria-label':'缓存管理',style:{marginTop:24,paddingTop:16,borderTop:'1px solid var(--dsw-alias-border-l2, #ddd)',fontSize:13}},
    h('h3',null,'缓存管理'),
    h('p',null,'管理本机视觉证据和审计归档。正在生成、读取、比较或生成结果待确认的证据会保留；当前审计日志、连接信息和项目知识缓存不在清理范围内。'),
    state?h('div',null,
      h('p',null,`视觉证据 ${size(state.visual.bytes)} · ${state.visual.entries} 组；审计归档 ${size(state.audit.bytes)} · ${state.audit.archives} 份`),
      state.visual.overBudgetBytes>0?h('p',null,`超出容量目标 ${size(state.visual.overBudgetBytes)}。仍在保留期或正在使用的证据暂不自动删除。`):null,
      state.partial?h('p',null,'本次统计达到扫描上限，仅显示已扫描部分。'):null,
      state.skippedUnsafe?h('p',null,'发现不属于安全清理范围的路径，已跳过。'):null):null,
    h('div',{style:{display:'flex',flexWrap:'wrap',gap:8}},
      button(busy?'处理中…':'刷新统计',()=>run()),
      button('按已保存策略清理',()=>run('policy')),
      button('清空闲置证据和归档',()=>setConfirm(true))),
    confirm?h('div',{style:{marginTop:10}},
      h('p',null,'这会提前删除保留期内的闲置视觉证据和审计归档，旧截图编号将失效。对话中已保存的图片附件不受影响。'),
      button('确认清空闲置缓存',()=>run('all_idle')),button('取消',()=>setConfirm(false))):null,
    result?h('p',{role:'status'},`已释放 ${size(result.deleted.bytes)}，清理 ${result.deleted.visualEntries} 组视觉证据、${result.deleted.auditArchives} 份归档。`):null,
    error?h('p',{role:'alert'},error):null);
}
