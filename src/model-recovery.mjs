import {randomUUID} from 'node:crypto';

const SOURCE='unreal-model-recovery';
const FAILURE='DeepSeek Messages stream: tool input is invalid JSON';

function invalidTool(attempt){
  for(const entry of attempt.data.stream){
    const block=entry.type==='chunk'&&entry.chunk.type==='block-end'?entry.chunk.block:null;
    if(block?.type!=='tool-call'||!/^unreal_[a-z0-9_]+$/.test(block.name))continue;
    try{JSON.parse(block.arguments);}
    catch(error){
      const position=/position (\d+)/.exec(error.message);
      return {name:block.name,position:position?Number(position[1])+1:null};
    }
  }
  return null;
}

/** Regenerate malformed, undispatched UE calls through the host request-error hook. */
export function registerModelRecovery(ctx,guard){
  let disposed=false;
  const pending=new WeakSet();
  const remove=ctx.on?.('agent/request-error',async(payload,next)=>{
    const delegated=await next();
    if(delegated!==undefined||disposed||payload.signal.aborted)return delegated;
    if(payload.failure.code!=='MALFORMED_RESPONSE'||payload.failure.message!==FAILURE)return;
    const session=payload.agent.session,state=guard.status(session.id);
    if(!state?.active||state.halted||state.budgetExhausted||state.summaryOnly||state.remaining?.timeMs===0||state.turn!==payload.turn)return;
    const limit=state.limits.guardMaxMalformedRetries;
    if(!limit||pending.has(session))return;
    const events=session.snapshotEvents();
    let start=-1;
    for(let index=events.length-1;index>=0;index--){
      if(events[index].type==='turn/end')return;
      if(events[index].type==='turn/start'){
        if(events[index].data.turn!==payload.turn)return;
        start=index;break;
      }
    }
    if(start<0)return;
    const current=events.slice(start+1),attempt=current.findLast(event=>event.type==='assistant/attempt');
    if(!attempt||attempt.data.turn!==payload.turn||attempt.data.step!==payload.step)return;
    const subsequent=current.slice(current.indexOf(attempt)+1);
    if(subsequent.some(event=>event.type==='tool/call'||event.type==='assistant/message'||event.type==='step/end'))return;
    const notices=current.filter(event=>event.type==='user/message'&&event.data.source.kind===SOURCE);
    if(notices.length>=limit||notices.some(event=>event.data.source.attemptSeq===attempt.seq))return;
    const tool=invalidTool(attempt);
    if(!tool)return;
    const location=tool.position===null?'':`（第 ${tool.position} 个字符附近）`;
    const message={id:randomUUID(),role:'user',source:{kind:SOURCE,form:'notice',summary:'UE 工具参数 JSON 无效，重新生成尚未执行的调用',attemptSeq:attempt.seq},
      content:[{type:'text',text:`上一次模型响应中的 ${tool.name} 参数不是合法 JSON${location}，已在工具派发前拒绝；该响应中的工具均未执行。请按已公布的参数 schema 重新生成本次尚未执行的调用，检查括号、逗号和字符串。不要重放更早已完成的工具；不要换工具、目标或脚本绕过现有保护。材质补丁应保持每批改动完整且可编译，先 dryRun 验证，通过后再按原流程应用。此次为本轮第 ${notices.length+1}/${limit} 次参数重新生成；现有任务预算、请求去重及写入保护继续有效。`}]};
    pending.add(session);
    try{
      if(disposed||payload.signal.aborted)return;
      session.append('user/message',message,{surfaceOp:'append'});
      return {kind:'retry'};
    }finally{pending.delete(session);}
  });
  return ()=>{if(disposed)return;disposed=true;remove?.();};
}
