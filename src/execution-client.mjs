import React from 'react';
const h=React.createElement;
const muted='var(--dsw-alias-label-secondary, #62666d)';
const warning='var(--dsw-alias-state-warn-label, #a16207)';
const phases={idle:'等待任务',active:'执行中',warning:'预算即将耗尽',summary:'正在收尾',halted:'执行已停止',completed:'本轮已结束'};
const duration=ms=>`${Math.floor(Math.max(0,ms)/60000)} 分 ${Math.floor(Math.max(0,ms)%60000/1000)} 秒`;
const metric=(label,used,limit,remaining)=>h('div',{key:label,style:{flex:'1 1 120px'}},
  h('div',null,`${label} ${used} / ${limit}`),
  h('progress',{'aria-label':label,value:used,max:limit,style:{width:'100%',height:5,accentColor:'var(--dsw-alias-brand-primary, #4b67df)'}}),
  h('div',{style:{color:muted,fontSize:11}},`剩余 ${remaining}`));

export function ExecutionStatus({state}) {
  const status=state.executionSafety;
  const write=state.editorWrite;
  return h('div',{'aria-label':'执行状态',style:{marginTop:8,borderTop:'1px solid var(--dsw-alias-border-l2, #ddd)',paddingTop:8}},
    status?h('details',null,
      h('summary',{style:{cursor:'pointer'}},`任务：${phases[status.phase]??'等待任务'} · 工具 ${status.toolCalls}/${status.limits.guardMaxToolCalls}`,
        status.active?` · 剩余 ${duration(status.remaining.timeMs)}`:status.startedAt?` · 用时 ${duration(status.elapsedMs??0)}`:null),
      h('div',{style:{display:'flex',flexWrap:'wrap',gap:12,marginTop:8}},
        metric('工具调用',status.toolCalls,status.limits.guardMaxToolCalls,status.remaining.toolCalls),
        metric('模型步骤',status.steps,status.limits.guardMaxSteps,status.remaining.steps),
        metric('累计错误',status.errors,status.limits.guardMaxErrors,status.remaining.errors)),
      status.reason?h('p',{style:{color:warning,overflowWrap:'anywhere'}},status.reason):null,
      status.lastError?h('div',{style:{marginTop:6,color:muted,overflowWrap:'anywhere'}},`最近失败：${status.lastError.code} · ${status.lastError.message}`):null,
      status.repairs?.issues?.length?h('div',{'aria-label':'单问题修复',style:{marginTop:8}},
        h('div',null,`单问题修复上限 ${status.limits.guardMaxRepairAttempts} 次 · 同一错误连续上限 ${status.limits.guardMaxRepeatedErrors} 次`),
        h('ul',{style:{maxHeight:160,overflowY:'auto',paddingLeft:18}},status.repairs.issues.map((issue,i)=>h('li',{key:issue.key??i,style:{overflowWrap:'anywhere',marginTop:5}},
          `${issue.target} · 修复 ${issue.attempts??issue.repairAttempts??0}/${status.limits.guardMaxRepairAttempts}`,
          issue.status==='blocked'?' · 已达限制，请保留证据并处理其他问题':issue.status==='resolved'?' · 已修复':null)))):null):h('span',{style:{color:muted}},'任务：等待 Unreal 操作'),
    state.settings?.nextTurnPending?h('div',{style:{color:muted,marginTop:5}},'预算设置已保存，将从下一轮任务生效；本轮继续使用启动时的限制。'):null,
    state.writeLock?h('div',{role:'status',style:{color:warning,marginTop:5,overflowWrap:'anywhere'}},`写入已锁定：回滚未通过核验（${state.writeLock.code}）。请先检查编辑器中的修改。`):
      write?h('div',{role:'status',style:{color:warning,marginTop:5,overflowWrap:'anywhere'}},
        write.phase==='uncertain'?`写入结果待确认：${write.requestId}`:`编辑器正在写入${write.sessionId!==state.sessionId?'（其他对话）':''}：${write.method}`,
        write.assetPath?` · ${write.assetPath}`:null):null);
}
