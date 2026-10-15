import React,{useEffect,useState} from 'react';
import {TYPERT_REMOTE} from './remote.mjs';
const h=React.createElement;
export const inject=['slots','sessions','remote'];
export function UnrealDock({read,bind}) {
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;let timer;setState(null);const refresh=async()=>{try{const s=await read();if(active){setState(previous=>previous&&previous.version>s.version?previous:s);setError('');}}catch(e){if(active)setError(e.message??String(e));}finally{if(active)timer=setTimeout(refresh,700);}};refresh();return()=>{active=false;clearTimeout(timer);};},[read]);
  const select=async event=>{setBusy(true);try{setState(await bind(event.target.value||null));setError('');}catch(e){setError(e.message??String(e));}finally{setBusy(false);}};
  return h('section',{style:{margin:'6px auto',padding:'10px 12px',border:'1px solid var(--dsw-alias-border-l4,#69717d)',borderRadius:10,maxWidth:760,fontSize:12,color:'inherit',background:'var(--dsw-alias-bg-base,transparent)'},'aria-label':'Unreal Editor'},
    h('div',{style:{display:'flex',gap:10,alignItems:'center'}},h('strong',null,'Unreal Editor'),
      h('select',{'aria-label':'选择编辑器实例',disabled:busy||!state,value:state?.editorId??'',onChange:select,style:{flex:1,minWidth:100,color:'inherit',background:'inherit',padding:4,borderRadius:5}},
        h('option',{value:''},'选择要连接的项目'),...(state?.editors??[]).map(e=>h('option',{key:e.editorId,value:e.editorId},`${e.project} · UE ${e.engineVersion} · ${e.pid}`)),
        state?.editorId&&!state.connected?h('option',{value:state.editorId},'已绑定的编辑器离线'):null),
      h('span',{style:{color:state?.connected?'#36a76b':'#a0a0a0'}},state?.connected?'已连接':'未连接')),
    h('div',{style:{marginTop:6,overflowWrap:'anywhere'}},state?.selection?.length?`已选资产：${state.selection.map(x=>x.path).join('、')}`:'在内容浏览器选择资产后，可在此对话中提出修改要求。'),
    state?.uncertain?h('div',{role:'status',style:{color:'#d99234',marginTop:4}},`上次操作结果待确认：${state.uncertain.requestId}`):null,
    error?h('div',{role:'alert',style:{color:'#db6565',marginTop:4}},error):null);
}
export async function apply(ctx) {
  await ctx.remote.$mount(TYPERT_REMOTE);
  ctx.inject(['remote.unrealBridge'],child=>{
    const using=(sessionId,call)=>child.sessions.using(sessionId,{source:'unrealBridge'},async reference=>{const state=reference.binding.session.getSnapshot();if(state.openState!=='open')throw state.openError??new Error('对话尚未就绪');const result=await call();if(!result.ok)throw new Error(result.error.message);return result.value;});
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'unreal-bridge',order:20,inject:sessionId=>({read:()=>using(sessionId,()=>child.remote.unrealBridge.state(sessionId)),bind:editorId=>using(sessionId,()=>child.remote.unrealBridge.bind(sessionId,editorId))})},UnrealDock));
  });
}
