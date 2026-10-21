import {BridgeError} from './protocol.mjs';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isUnsafeWriteError} from './write-safety.mjs';
import {RepairTracker,operationEvidence,REPAIR_STOP_CONSTRAINTS,REPAIR_STOP_INSTRUCTION} from './repair-tracker.mjs';
import {DEFAULTS} from './settings-spec.mjs';

export const EXECUTION_LIMIT_DEFAULTS=Object.freeze(Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>key.startsWith('guard'))));
const RECOVERY_TOOLS=new Set(['unreal_state','unreal_request_status']);
const RECOVERY_CALL_LIMIT=2;
const MATERIAL_EDITOR_CONFLICT_CONSTRAINTS=Object.freeze({
  retainPendingEdits:true,
  prohibitedWorkarounds:Object.freeze(['apply_pending_edits','discard_pending_edits','close_editor','switch_tools','replace_asset']),
  independentWork:'reads_and_already_requested_unrelated_targets',
  resumeSameTarget:'after_editor_conflict_resolved_and_fresh_read',
});
const nonnegative=value=>Number.isFinite(value)?Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.trunc(value))):0;
const SHELL_TOOL=/(?:^|[_./-])(?:pwsh|powershell|bash|shell|exec_command|run_command|terminal|run_code)(?:$|[_./-])/i;
const DIRECT_INPUT_API=/(?:\b(?:Get|Set)-Clipboard\b|\b(?:System\.)?Windows\.Forms\.Clipboard\b|\b(?:mouse_event|SetCursorPos|SendInput)\s*\(|\bDllImport\s*\(\s*['"]user32(?:\.dll)?['"]|\b(?:windll\s*\.\s*user32|user32\s*(?:\.|::))|\b(?:WinDLL|LoadLibrary|CDLL)\s*\(\s*['"]user32(?:\.dll)?['"]|\bpyautogui\s*\.\s*(?:click|doubleClick|rightClick|moveTo|moveRel|mouseDown|mouseUp|dragTo|dragRel|press|hotkey)\s*\(|\bpynput\s*\.\s*mouse\b|\bpyperclip\s*\.\s*(?:copy|paste)\s*\()/i;
const READ_STAGE=/^\s*(?:rg|grep|cat|head|tail|findstr|Get-Content|Select-String|Select-Object|Format-Table|Format-List|Out-String)\b/i;

function statements(text){
  const result=[];let start=0,quote=null;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(quote){
      if(quote==='"'&&(char==='\\'||char==='`')){index++;continue;}
      if(char===quote)quote=null;
    }else if(char==='"'||char==="'")quote=char;
    else if(char===';'||char==='\n'||(char==='&'&&text[index+1]==='&')){
      result.push(text.slice(start,index));if(char==='&')index++;start=index+1;
    }
  }
  result.push(text.slice(start));return result;
}

function commandText(args){
  if(typeof args==='string')return args;
  if(!args||typeof args!=='object')return '';
  return ['command','cmd','script','code','commands'].flatMap(key=>{
    const value=args[key];return typeof value==='string'?[value]:Array.isArray(value)?value.filter(item=>typeof item==='string'):[];
  }).join('\n');
}

/** Match explicit input APIs in shell code while leaving ordinary source searches alone. */
function prohibitedInput(exec){
  if(!SHELL_TOOL.test(exec.name??''))return false;
  return statements(commandText(exec.arguments)).some(line=>{
    if(!line.trim()||/^\s*#/.test(line))return false;
    const unquoted=line.replace(/'(?:[^']|'')*'|"(?:\\.|`.|[^"\\])*"/g,'""');
    if(unquoted.split('|').every(stage=>READ_STAGE.test(stage)))return false;
    return DIRECT_INPUT_API.test(line);
  });
}

/** Install a per-turn guard; before/after also support hosts without global tool hooks. */
export function registerExecutionGuard(ctx,configOrGetter={},options={}){
  function readLimits(){
    const config=typeof configOrGetter==='function'?configOrGetter():configOrGetter;
    const limits={...EXECUTION_LIMIT_DEFAULTS};
    for(const key of Object.keys(EXECUTION_LIMIT_DEFAULTS)){
      if(config?.[key]!==undefined)limits[key]=config[key];
      const minimum=['guardMaxRepairAttempts','guardMaxMalformedRetries'].includes(key)?0:1;
      if(!Number.isSafeInteger(limits[key])||limits[key]<minimum)throw new TypeError(`${key} must be a ${minimum?'positive':'nonnegative'} safe integer`);
    }
    return Object.freeze(limits);
  }
  readLimits();
  const rounds=new Map(),removers=[],executions=new WeakMap(),operations=new WeakMap();
  const executing=new AsyncLocalStorage();
  let disposed=false;
  const service=key=>{
    try{return typeof options.getService==='function'?options.getService(key):ctx.get?.(key)??ctx[key];}
    catch{return undefined;}
  };
  const sessionOf=exec=>exec?.agent?.session;
  function notify(state){
    if(disposed||!state||rounds.get(state.sessionId)!==state)return;
    try{options.onChange?.(state.sessionId,status(state.sessionId));}catch(error){service('logger')?.warn?.(`Unreal execution status notification failed: ${error.message}`);}
  }
  function clearTimer(state){if(state.timer){clearTimeout(state.timer);state.timer=undefined;}}
  function armTimer(state){
    clearTimer(state);
    state.timer=setTimeout(()=>{
      if(rounds.get(state.sessionId)===state&&state.active&&!state.ended&&!state.halted&&state.pausedAt===null)halt(state,`Unreal 任务已超过 ${state.limits.guardTimeoutMs/1000} 秒，已停止本轮执行，请检查已完成的修改后重新发起任务。`);
    },Math.max(0,state.deadlineAt-Date.now()));
    state.timer.unref?.();
  }
  function pausedTime(state,now=Date.now()){
    return state.pausedMs+(state.pausedAt===null?0:nonnegative(now-state.pausedAt));
  }
  function updateWaitTimer(state){
    if(disposed||!state.active||state.ended||state.halted||rounds.get(state.sessionId)!==state)return;
    const waiting=state.waits.size>0&&[...state.running].every(record=>record.waits>0);
    if(waiting===(state.pausedAt!==null))return;
    const now=Date.now();
    if(waiting){
      // Starting a question at an exhausted deadline cannot extend the budget.
      if(now>=state.deadlineAt){halt(state,`Unreal 任务已超过 ${state.limits.guardTimeoutMs/1000} 秒，已停止本轮执行。`);return;}
      clearTimer(state);state.pausedAt=now;
    }else{
      const duration=nonnegative(now-state.pausedAt);
      state.pausedMs+=duration;state.deadlineAt+=duration;state.pausedAt=null;
      armTimer(state);
    }
    notify(state);
  }
  function create(sessionId,turn,boundary,boundarySource){
    const old=rounds.get(sessionId);if(old)clearTimer(old);
    const state={sessionId,turn:turn??null,boundary,boundarySource,active:false,ended:false,endedAt:null,limits:null,repairs:null,halted:false,reason:null,calls:0,errors:0,lastError:null,errorNoticeCount:0,currentStep:0,activationStep:0,steps:0,roots:new Set(),failedRoots:new Set(),tokenRoots:new Map(),budgetExhausted:false,exhaustedBy:null,summaryOnly:false,recoveryTokens:new Set(),recoveryStep:null,summaryStep:null,pausedAt:null,pausedMs:0,waits:new Set(),running:new Set()};
    rounds.delete(sessionId);rounds.set(sessionId,state);
    // Preserve all live turns, while bounding retained completed/idle history.
    for(const [key,prior] of rounds){
      if(rounds.size<=128)break;
      if(key!==sessionId&&(!prior.active||prior.ended||prior.halted)){clearTimer(prior);rounds.delete(key);}
    }
    notify(state);return state;
  }
  function stateFor(exec){
    const session=sessionOf(exec);if(!session?.id||disposed)return undefined;
    let state=rounds.get(session.id);
    const boundary=service('sessionProjections')?.stateOf?.(session,'turnBoundary');
    if(boundary?.openTurnStartSeq!==null&&boundary?.openTurnStartSeq!==undefined){
      const key=`seq:${boundary.openTurnStartSeq}`;
      if(!state||state.boundary!==key)state=create(session.id,boundary.lastTurn,key,'projection');
    }else if(state?.boundarySource==='projection'&&boundary?.openTurnStartSeq===null&&boundary.lastTurn===state.turn){
      end(state);
    }
    // A host without either boundary API cannot prove that a fresh turn began.
    // Keep its fallback guard latched rather than reset on a model-controlled ID.
    state??=create(session.id,null,'fallback','unavailable');
    state.agent=exec.agent;return state;
  }
  function end(state){
    if(state.ended)return;
    clearTimer(state);state.ended=true;state.endedAt=Date.now();state.active=false;notify(state);
  }
  function halt(state,reason){
    if(state.halted||disposed)return;
    state.halted=true;state.reason=reason;state.stoppedAt=Date.now();clearTimer(state);
    notify(state);
    state.agent?.cancel?.({kind:'hook',reason},{keepInbox:true});
  }
  function haltedError(state){return new BridgeError('EXECUTION_HALTED',state.reason,{retryable:false,turn:state.turn,toolCalls:state.calls,errors:state.errors});}
  function exhaust(state,by,reason){
    if(state.halted||state.budgetExhausted)return;
    state.budgetExhausted=true;state.exhaustedBy=by;state.reason=reason;
    notify(state);
  }
  function budgetError(state){return new BridgeError('EXECUTION_BUDGET_EXHAUSTED',`${state.reason} 请停止修改，根据已有证据总结已完成、未完成、验证与保存状态。`,{retryable:false,execution:'not_started',turn:state.turn,exhaustedBy:state.exhaustedBy,remaining:remaining(state),summaryOnly:state.summaryOnly});}
  // Pre-step messages are persisted by DSH as user/message events. Match its
  // UserMessage contract (also used for model-selection notices), otherwise
  // session validation aborts before the model can receive the closing sample.
  function notice(text){return Object.freeze({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'unreal-execution-budget',form:'notice',summary:'Unreal execution budget: finish with current evidence'}});}
  function canAddNotice(payload,decision){
    return decision.kind==='enter'&&!payload.signal?.aborted&&!(decision.messages.length===0&&(payload.step===1||payload.messages?.length>0));
  }
  function recovery(exec,state){
    const token=exec.token??exec;
    if(!state.summaryOnly&&RECOVERY_TOOLS.has(exec.name)&&(state.recoveryTokens.has(token)||state.recoveryTokens.size<RECOVERY_CALL_LIMIT)){
      state.recoveryTokens.add(token);return;
    }
    throw budgetError(state);
  }
  function activate(state){
    const limits=state.limits=readLimits();state.repairs=new RepairTracker(limits);
    state.active=true;state.activationStep=state.currentStep;state.steps=1;state.startedAt=Date.now();state.deadlineAt=state.startedAt+limits.guardTimeoutMs;
    armTimer(state);updateWaitTimer(state);
    notify(state);
  }
  function rootOf(state,exec){
    const root=exec.rootCallId??(exec.parent?state.tokenRoots.get(exec.parent)??exec.parent:exec.callId??exec.token??exec);
    if(exec.token!==undefined)state.tokenRoots.set(exec.token,root);
    return root;
  }
  function before(exec){
    const state=stateFor(exec);if(!state)return;
    // Retain the owning turn even when a precheck throws before root admission.
    // Its eventual post-execute callback must not be charged to a newer turn.
    let record=executions.get(exec);
    if(record?.state!==state){record={state};executions.set(exec,record);}
    if(state.ended)return;
    if(state.halted)throw haltedError(state);
    if(!state.active&&/^unreal_/.test(exec.name??''))activate(state);
    if(!state.active)return;
    const limits=state.limits;
    if(remaining(state).timeMs===0)halt(state,`Unreal 任务已超过 ${limits.guardTimeoutMs/1000} 秒，已停止本轮执行。`);
    if(!state.halted&&prohibitedInput(exec))throw new BridgeError('MCP_POLICY_BLOCKED','Unreal 任务禁止通过终端调用真实鼠标或剪贴板接口；此调用未执行，请改用允许的编辑器结构化工具。',{execution:'not_started',retryable:false,reason:'desktop_input'});
    if(state.halted)throw haltedError(state);
    if(state.budgetExhausted){
      recovery(exec,state);record.root=rootOf(state,exec);notify(state);return;
    }
    const root=rootOf(state,exec);record.root=root;
    if(!state.roots.has(root)){
      if(state.calls>=limits.guardMaxToolCalls){
        exhaust(state,'tool_calls',`Unreal 本轮已用完 ${limits.guardMaxToolCalls} 次工具调用预算，已保留收尾机会。`);
        return recovery(exec,state);
      }
      state.roots.add(root);state.calls++;
    }
    // Global hooks may run before the wrapper has resolved its editor/target.
    // The wrapper's second before() admits the trusted operation exactly once.
    const operation=operations.get(exec);
    if(operation&&!record.repairAdmitted){
      record.repairAdmitted=true;
      try{record.repairTicket=state.repairs.admit(operation);}
      catch(error){record.repairDenied=error;notify(state);throw error;}
    }
    if(record.repairDenied){
      // A duplicate wrapper invocation cannot turn a previously denied precheck
      // into an allowed execution by reusing the same host execution object.
      throw record.repairDenied;
    }
    notify(state);
  }
  function after(exec,value){
    if(disposed)return value;
    const recorded=executions.get(exec);
    const state=recorded?.state??stateFor(exec);
    if(!state?.active||state.ended||rounds.get(state.sessionId)!==state||state.halted)return value;
    const limits=state.limits;
    const root=recorded?.root??rootOf(state,exec);
    const hostResult=value&&typeof value==='object'&&typeof value.isError==='boolean';
    const body=hostResult&&value.isError===false?value.value:value;
    const failed=value instanceof Error||value?.isError===true||body?.ok===false;
    if(!failed){
      state.repairs.complete(recorded?.repairTicket,null);
      const operation=operations.get(exec);
      if(operation?.statusRequestId)for(const candidate of rounds.values()){
        if(candidate.repairs?.reconcile(operation,body))notify(candidate);
      }
      notify(state);return value;
    }
    const error=body?.error??body;
    const code=error?.code??error?.info?.code;
    const details=error?.details??error?.info?.details??body?.details;
    if(['EXECUTION_BUDGET_EXHAUSTED','REPAIR_BUDGET_EXHAUSTED','REPAIR_TRACKING_LIMIT'].includes(code))return value;
    state.repairs.complete(recorded?.repairTicket,{code:code??'ERROR',message:typeof error?.message==='string'?error.message:'Tool execution failed',details});
    const problem=state.repairs.issueFor(recorded?.repairTicket);
    const unsafe=isUnsafeWriteError(body);
    if(!state.failedRoots.has(root)){
      state.failedRoots.add(root);state.errors++;
      const recovery=unsafe?'stop_writes':['TIMEOUT','CANCELLED','DISCONNECTED','OUTCOME_UNKNOWN'].includes(code)?'check_request_status':code==='MATERIAL_EDITOR_CONFLICT'?'resolve_editor_conflict':problem?.status==='blocked'?'stop_problem':details?.rollback==='not_available'?'verify_before_retry':code==='MCP_POLICY_BLOCKED'||details?.retryable===false&&details?.rollback!=='restored'?'choose_supported_operation':'correct_and_retry';
      const operation=operations.get(exec);
      const recoveryConstraints=recovery==='stop_problem'?REPAIR_STOP_CONSTRAINTS:recovery==='resolve_editor_conflict'
        ?{...MATERIAL_EDITOR_CONFLICT_CONSTRAINTS,...(operation?.target?{target:operation.target}:{})}:null;
      state.lastError={code:code??'ERROR',message:typeof error?.message==='string'?error.message:'Tool execution failed',rollback:unsafe?'failed':details?.rollback??null,recovery,...(problem?{problem}:{}),...(recoveryConstraints?{recoveryConstraints}:{})};
    }
    if(unsafe){
      // A late result from an admitted parallel call may reveal unsafe state
      // after a normal budget was exhausted. Keep that stronger reason visible.
      const reason=`Unreal 工具报告回滚失败或编辑器写入锁定（${code??'回滚失败'}），已停止进一步操作并保留状态查询与总结机会。不得绕过写锁；请说明未验证的资产状态。`;
      if(state.budgetExhausted){state.exhaustedBy='unsafe_state';state.reason=reason;}
      else exhaust(state,'unsafe_state',reason);
    }
    else if(state.errors>=limits.guardMaxErrors)exhaust(state,'errors',`Unreal 本轮已累计 ${state.errors} 次工具错误，已停止进一步修改并保留收尾机会。`);
    notify(state);
    return value;
  }
  function on(name,callback,settings){const remove=ctx.on?.(name,callback,settings);if(typeof remove==='function')removers.push(remove);}
  if(typeof ctx.on==='function'){
    on('session/event',(session,event)=>{
      if(disposed)return;
      if(event.type==='turn/start'){
        const key=event.seq===undefined?`turn:${event.data.turn}`:`seq:${event.seq}`;
        if(rounds.get(session.id)?.boundary!==key)create(session.id,event.data.turn,key,'event');
      }else if(event.type==='turn/end'){
        const state=rounds.get(session.id);
        if(state&&state.turn===event.data.turn)end(state);
      }else if(event.type==='step/start'){
        const state=rounds.get(session.id);if(state&&state.turn===event.data.turn)state.currentStep=nonnegative(event.data.step);
      }
    });
    on('tools/pre-execute',async(exec,next)=>{
      try{before(exec);}catch(error){
        if(error.code==='EXECUTION_HALTED')return {kind:'cancel'};
        if(['EXECUTION_BUDGET_EXHAUSTED','MCP_POLICY_BLOCKED','REPAIR_BUDGET_EXHAUSTED','REPAIR_TRACKING_LIMIT'].includes(error.code))return {kind:'deny',reason:error.message,info:{code:error.code,details:error.details}};
        throw error;
      }
      return next();
    });
    on('tools/post-execute',async(exec,result,next)=>{const decision=await next();after(exec,result);return decision;});
    on('tools/execute',async(exec,next)=>{
      const state=executions.get(exec)?.state??stateFor(exec);
      if(!state||state.ended||state.halted)return next();
      const record={state,waits:0};
      const parents=executing.getStore()??[];
      state.running.add(record);updateWaitTimer(state);
      try{return await executing.run([...parents,record],next);}
      finally{state.running.delete(record);updateWaitTimer(state);}
    },{prepend:true});
    // This trusted seam runs after question and live-agent validation, before
    // an answerer may consume the waterfall without calling next(). Tool names
    // or model-controlled arguments alone must never suspend the deadline.
    on('user-questions/request',async(request,next)=>{
      const stack=executing.getStore()??[],sessionId=request.agent?.session?.id;
      const state=stack.findLast(record=>record.state.sessionId===sessionId)?.state??rounds.get(sessionId);
      if(!state||rounds.get(sessionId)!==state||state.ended||state.halted||request.signal?.aborted)return next();
      const records=stack.filter(record=>record.state===state&&state.running.has(record));
      const wait={};let released=false;
      const release=()=>{
        if(released)return;released=true;
        request.signal?.removeEventListener('abort',release);
        state.waits.delete(wait);
        for(const record of records)record.waits--;
        updateWaitTimer(state);
      };
      state.waits.add(wait);
      for(const record of records)record.waits++;
      request.signal?.addEventListener('abort',release,{once:true});
      updateWaitTimer(state);
      try{return await next();}finally{release();}
    },{prepend:true});
    on('system-prompt/assemble',async(_assembly,context,next)=>{
      const assembled=await next();
      const state=stateFor({agent:context.agent??context.scope});
      if(!state?.active)return assembled;
      const limits=state.limits;
      // Assembly precedes pre-step: predict the next closing stage before its
      // one permitted sample, so that the model is actually offered no tools.
      if(state.steps>=limits.guardMaxSteps){
        exhaust(state,'model_steps',`Unreal 本轮已用完 ${limits.guardMaxSteps} 个模型步骤预算，已保留一次无工具总结。`);
        state.summaryOnly=true;
      }
      if(state.calls>=limits.guardMaxToolCalls)exhaust(state,'tool_calls',`Unreal 本轮已用完 ${limits.guardMaxToolCalls} 次工具调用预算，已保留收尾机会。`);
      if(!state.halted&&!state.budgetExhausted)return assembled;
      const final=state.halted||state.summaryOnly||state.recoveryStep!==null||state.recoveryTokens.size>=RECOVERY_CALL_LIMIT;
      return {...assembled,tools:final?[]:assembled.tools.filter(tool=>RECOVERY_TOOLS.has(tool.name))};
    });
    on('agent/pre-step',async(payload,next)=>{
      const state=stateFor({agent:payload.agent});
      if(state){
        state.currentStep=nonnegative(payload.step);
        if(state.active){
          const limits=state.limits;
          state.steps=nonnegative(state.currentStep-state.activationStep+1);
          notify(state);
          if(state.steps>limits.guardMaxSteps){
            exhaust(state,'model_steps',`Unreal 本轮已用完 ${limits.guardMaxSteps} 个模型步骤预算，已保留一次无工具总结。`);
            state.summaryOnly=true;
          }
          if(state.halted)return {kind:'reject'};
          if(state.budgetExhausted){
            const recoveryStage=!state.summaryOnly&&state.recoveryStep===null&&state.recoveryTokens.size<RECOVERY_CALL_LIMIT;
            if(!recoveryStage&&state.summaryStep!==null)return {kind:'reject'};
            const decision=await next();
            if(!canAddNotice(payload,decision)||rounds.get(state.sessionId)!==state)return decision;
            if(recoveryStage)state.recoveryStep=state.currentStep;
            else{state.summaryOnly=true;state.summaryStep=state.currentStep;}
            notify(state);
            const instruction=state.summaryOnly?'不得再调用工具；只根据已有证据总结已完成、未完成、验证与保存状态。':'只在确有需要时使用剩余的最多两次 unreal_state / unreal_request_status 查询；不得再修改资产。然后总结已完成、未完成、验证与保存状态。';
            return {...decision,messages:[...decision.messages,notice(`${state.reason} ${instruction}`)]};
          }
          const info=status(state.sessionId);
          if(info.warning||state.errors>state.errorNoticeCount){
            const decision=await next();
            if(!canAddNotice(payload,decision)||rounds.get(state.sessionId)!==state)return decision;
            const parts=[];
            if(state.errors>state.errorNoticeCount){
              const error=state.lastError;
              const instruction=error.recovery==='stop_problem'?`该目标的当前操作已达到单问题修复限制；${REPAIR_STOP_INSTRUCTION}`:error.recovery==='resolve_editor_conflict'?`材质编辑器存在未应用的用户修改，或无法可靠检查其状态。保留这些修改；说明错误中的具体目标${error.recoveryConstraints?.target?`（${error.recoveryConstraints.target}）`:''}，等待用户处理现有编辑状态后重新读取目标，再继续当前写入。不得自动 Apply、丢弃修改、关闭编辑器、换工具或创建替代资产绕过冲突。可以继续读取诊断和处理其他已授权且无关的目标。`:error.recovery==='verify_before_retry'?'该写操作未提供回滚保证，先读取目标当前状态，确认是否已部分生效，再根据错误修正操作；不要原样盲重试。':error.recovery==='check_request_status'?'先使用原 requestId 查询 unreal_request_status，确认结果；不要用新编号重复可能已经执行的写入。':error.recovery==='choose_supported_operation'?'此操作不受支持或已被策略拒绝；改用允许的操作继续独立工作，不得换脚本、桌面输入或调度器绕过限制。':'根据原始错误读取必要信息、修正参数或操作后继续验证；不要重复无变化的失败请求。';
              const correctionIdentity=['correct_and_retry','verify_before_retry'].includes(error.recovery)?' 确定失败并完成核实后的修正写入使用新的 requestId。':'';
              parts.push(`Unreal 工具失败（${error.code}）：${error.message.slice(0,1200)}。${instruction} 已累计 ${state.errors}/${limits.guardMaxErrors} 次错误，成功调用不会清零。${correctionIdentity}`);
              state.errorNoticeCount=state.errors;
            }
            if(info.warning)parts.push(info.warning);
            parts.push(`剩余工具调用 ${info.remaining.toolCalls} 次、模型步骤 ${info.remaining.steps} 个、错误额度 ${info.remaining.errors} 次。`);
            return {...decision,messages:[...decision.messages,notice(parts.join(' '))]};
          }
        }
      }
      return next();
    });
  }
  function remaining(state){
    const limits=state.limits??readLimits();
    const now=state.stoppedAt??state.endedAt??Date.now();
    return {toolCalls:nonnegative(limits.guardMaxToolCalls-state.calls),steps:nonnegative(limits.guardMaxSteps-state.steps),errors:nonnegative(limits.guardMaxErrors-state.errors),timeMs:state.startedAt===undefined?limits.guardTimeoutMs:nonnegative(state.deadlineAt-(state.pausedAt??now)),recoveryCalls:state.summaryOnly?0:nonnegative(RECOVERY_CALL_LIMIT-state.recoveryTokens.size)};
  }
  function status(sessionId){
    const state=rounds.get(sessionId);if(!state)return null;
    const limits=state.limits??readLimits();
    const {turn,boundarySource,active,halted,reason,calls,errors,steps,startedAt,deadlineAt}=state;
    const left=remaining(state);
    const near=active&&(calls/limits.guardMaxToolCalls>=0.8||steps/limits.guardMaxSteps>=0.8||errors/limits.guardMaxErrors>=0.8||left.timeMs/limits.guardTimeoutMs<=0.2);
    const warning=state.ended?null:state.budgetExhausted?`${reason} 请准备总结当前结果与未完成部分。`:near?'Unreal 本轮预算接近上限，请优先完成当前验证，并准备报告未完成部分。':null;
    const now=state.stoppedAt??state.endedAt??Date.now(),pausedMs=pausedTime(state,now);
    const elapsedMs=startedAt===undefined?0:nonnegative(now-startedAt-pausedMs);
    const repairs=state.repairs?.status()??{issues:[],total:0,attemptsUsed:0,failures:0,activeCount:0,blockedCount:0,resolvedCount:0,hiddenCount:0,capacityReached:false};
    return {turn,boundarySource,active,halted,reason,calls,toolCalls:calls,errors,lastError:state.lastError,steps,startedAt:startedAt??null,deadlineAt:deadlineAt??null,endedAt:state.endedAt,elapsedMs,pausedMs,waitingForUser:state.pausedAt!==null&&!state.ended&&!state.halted,limits:{...limits},repairs,crossToolEnforcement:typeof ctx.on==='function',phase:state.ended?'completed':halted?'halted':state.budgetExhausted?'summary':warning?'warning':active?'active':'idle',budgetExhausted:state.budgetExhausted,exhaustedBy:state.exhaustedBy,summaryOnly:state.summaryOnly,recoveryCallsUsed:state.recoveryTokens.size,remaining:left,warning};
  }
  function setOperation(exec,evidence){
    if(!exec||typeof exec!=='object')throw new TypeError('Execution must be a host object');
    if(!operations.has(exec))operations.set(exec,operationEvidence(evidence));
  }
  function dispose(){
    if(disposed)return;disposed=true;
    for(const state of rounds.values())clearTimer(state);
    for(const remove of removers.splice(0))remove();
    executing.disable();
    rounds.clear();
  }
  return {before,after,dispose,status,setOperation};
}
