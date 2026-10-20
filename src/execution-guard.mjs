import {BridgeError} from './protocol.mjs';
import {randomUUID} from 'node:crypto';

export const EXECUTION_LIMIT_DEFAULTS=Object.freeze({guardMaxToolCalls:300,guardMaxSteps:200,guardMaxErrors:50,guardTimeoutMs:1800000});
const UNSAFE_STATE_CODES=new Set(['DATA_TABLE_ROLLBACK_FAILED','EDITOR_WRITE_LOCKED']);
const RECOVERY_TOOLS=new Set(['unreal_state','unreal_request_status']);
const RECOVERY_CALL_LIMIT=2;
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
export function registerExecutionGuard(ctx,config={}){
  const limits={...EXECUTION_LIMIT_DEFAULTS};
  for(const key of Object.keys(EXECUTION_LIMIT_DEFAULTS)){
    if(config[key]!==undefined)limits[key]=config[key];
    if(!Number.isSafeInteger(limits[key])||limits[key]<1)throw new TypeError(`${key} must be a positive safe integer`);
  }
  const rounds=new Map(),removers=[],executions=new WeakMap();
  let disposed=false;
  const service=key=>{try{return ctx.get?.(key)??ctx[key];}catch{return ctx[key];}};
  const sessionOf=exec=>exec?.agent?.session;
  function clearTimer(state){if(state.timer){clearTimeout(state.timer);state.timer=undefined;}}
  function create(sessionId,turn,boundary,boundarySource){
    const old=rounds.get(sessionId);if(old)clearTimer(old);
    const state={sessionId,turn:turn??null,boundary,boundarySource,active:false,halted:false,reason:null,calls:0,errors:0,lastError:null,errorNoticeCount:0,currentStep:0,activationStep:0,steps:0,roots:new Set(),failedRoots:new Set(),tokenRoots:new Map(),budgetExhausted:false,exhaustedBy:null,summaryOnly:false,recoveryTokens:new Set(),recoveryStep:null,summaryStep:null};
    rounds.set(sessionId,state);return state;
  }
  function stateFor(exec){
    const session=sessionOf(exec);if(!session?.id||disposed)return undefined;
    let state=rounds.get(session.id);
    const boundary=service('sessionProjections')?.stateOf?.(session,'turnBoundary');
    if(boundary?.openTurnStartSeq!==null&&boundary?.openTurnStartSeq!==undefined){
      const key=`seq:${boundary.openTurnStartSeq}`;
      if(!state||state.boundary!==key)state=create(session.id,boundary.lastTurn,key,'projection');
    }
    // A host without either boundary API cannot prove that a fresh turn began.
    // Keep its fallback guard latched rather than reset on a model-controlled ID.
    state??=create(session.id,null,'fallback','unavailable');
    state.agent=exec.agent;return state;
  }
  function halt(state,reason){
    if(state.halted||disposed)return;
    state.halted=true;state.reason=reason;clearTimer(state);
    state.agent?.cancel?.({kind:'hook',reason},{keepInbox:true});
  }
  function haltedError(state){return new BridgeError('EXECUTION_HALTED',state.reason,{retryable:false,turn:state.turn,toolCalls:state.calls,errors:state.errors});}
  function exhaust(state,by,reason){
    if(state.halted||state.budgetExhausted)return;
    state.budgetExhausted=true;state.exhaustedBy=by;state.reason=reason;
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
    state.active=true;state.activationStep=state.currentStep;state.steps=1;state.startedAt=Date.now();state.deadlineAt=state.startedAt+limits.guardTimeoutMs;
    state.timer=setTimeout(()=>{
      if(rounds.get(state.sessionId)===state)halt(state,`Unreal 任务已超过 ${limits.guardTimeoutMs/1000} 秒，已停止本轮执行，请检查已完成的修改后重新发起任务。`);
    },limits.guardTimeoutMs);
    state.timer.unref?.();
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
    executions.set(exec,{state});
    if(state.halted)throw haltedError(state);
    if(!state.active&&/^unreal_/.test(exec.name??''))activate(state);
    if(!state.active)return;
    if(Date.now()>=state.deadlineAt)halt(state,`Unreal 任务已超过 ${limits.guardTimeoutMs/1000} 秒，已停止本轮执行。`);
    if(!state.halted&&prohibitedInput(exec))throw new BridgeError('MCP_POLICY_BLOCKED','Unreal 任务禁止通过终端调用真实鼠标或剪贴板接口；此调用未执行，请改用允许的编辑器结构化工具。',{execution:'not_started',retryable:false,reason:'desktop_input'});
    if(state.halted)throw haltedError(state);
    if(state.budgetExhausted){
      recovery(exec,state);executions.set(exec,{state,root:rootOf(state,exec)});return;
    }
    const root=rootOf(state,exec);executions.set(exec,{state,root});
    if(!state.roots.has(root)){
      if(state.calls>=limits.guardMaxToolCalls){
        exhaust(state,'tool_calls',`Unreal 本轮已用完 ${limits.guardMaxToolCalls} 次工具调用预算，已保留收尾机会。`);
        return recovery(exec,state);
      }
      state.roots.add(root);state.calls++;
    }
  }
  function after(exec,value){
    if(disposed)return value;
    const recorded=executions.get(exec);
    const state=recorded?.state??stateFor(exec);
    if(!state?.active||rounds.get(state.sessionId)!==state||state.halted)return value;
    const root=recorded?.root??rootOf(state,exec);
    const hostResult=value&&typeof value==='object'&&typeof value.isError==='boolean';
    const body=hostResult&&value.isError===false?value.value:value;
    const failed=value instanceof Error||value?.isError===true||body?.ok===false;
    if(!failed)return value;
    const error=body?.error??body;
    const code=error?.code??error?.info?.code;
    const details=error?.details??error?.info?.details??body?.details;
    if(code==='EXECUTION_BUDGET_EXHAUSTED')return value;
    const unsafe=UNSAFE_STATE_CODES.has(code)||details?.rollback==='failed';
    if(!state.failedRoots.has(root)){
      state.failedRoots.add(root);state.errors++;
      const recovery=unsafe?'stop_writes':['TIMEOUT','CANCELLED','DISCONNECTED','OUTCOME_UNKNOWN'].includes(code)?'check_request_status':details?.rollback==='not_available'?'verify_before_retry':code==='MCP_POLICY_BLOCKED'||details?.retryable===false&&details?.rollback!=='restored'?'choose_supported_operation':'correct_and_retry';
      state.lastError={code:code??'ERROR',message:typeof error?.message==='string'?error.message:'Tool execution failed',rollback:details?.rollback??null,recovery};
    }
    if(unsafe){
      // A late result from an admitted parallel call may reveal unsafe state
      // after a normal budget was exhausted. Keep that stronger reason visible.
      const reason=`Unreal 工具报告回滚失败或编辑器写入锁定（${code??'回滚失败'}），已停止进一步操作并保留状态查询与总结机会。不得绕过写锁；请说明未验证的资产状态。`;
      if(state.budgetExhausted){state.exhaustedBy='unsafe_state';state.reason=reason;}
      else exhaust(state,'unsafe_state',reason);
    }
    else if(state.errors>=limits.guardMaxErrors)exhaust(state,'errors',`Unreal 本轮已累计 ${state.errors} 次工具错误，已停止进一步修改并保留收尾机会。`);
    return value;
  }
  function on(name,callback){const remove=ctx.on?.(name,callback);if(typeof remove==='function')removers.push(remove);}
  if(typeof ctx.on==='function'){
    on('session/event',(session,event)=>{
      if(disposed)return;
      if(event.type==='turn/start'){
        const key=event.seq===undefined?`turn:${event.data.turn}`:`seq:${event.seq}`;
        if(rounds.get(session.id)?.boundary!==key)create(session.id,event.data.turn,key,'event');
      }else if(event.type==='turn/end'){
        const state=rounds.get(session.id);
        if(state&&state.turn===event.data.turn){clearTimer(state);state.ended=true;}
      }else if(event.type==='step/start'){
        const state=rounds.get(session.id);if(state&&state.turn===event.data.turn)state.currentStep=nonnegative(event.data.step);
      }
    });
    on('tools/pre-execute',async(exec,next)=>{
      try{before(exec);}catch(error){
        if(error.code==='EXECUTION_HALTED')return {kind:'cancel'};
        if(error.code==='EXECUTION_BUDGET_EXHAUSTED'||error.code==='MCP_POLICY_BLOCKED')return {kind:'deny',reason:error.message,info:{code:error.code,details:error.details}};
        throw error;
      }
      return next();
    });
    on('tools/post-execute',async(exec,result,next)=>{const decision=await next();after(exec,result);return decision;});
    on('system-prompt/assemble',async(_assembly,context,next)=>{
      const assembled=await next();
      const state=stateFor({agent:context.agent??context.scope});
      if(!state?.active)return assembled;
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
          state.steps=nonnegative(state.currentStep-state.activationStep+1);
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
              const instruction=error.recovery==='verify_before_retry'?'该写操作未提供回滚保证，先读取目标当前状态，确认是否已部分生效，再根据错误修正操作；不要原样盲重试。':error.recovery==='check_request_status'?'先使用原 requestId 查询 unreal_request_status，确认结果；不要用新编号重复可能已经执行的写入。':error.recovery==='choose_supported_operation'?'此操作不受支持或已被策略拒绝；改用允许的操作继续独立工作，不得换脚本、桌面输入或调度器绕过限制。':'根据原始错误读取必要信息、修正参数或操作后继续验证；不要重复无变化的失败请求。';
              parts.push(`Unreal 工具失败（${error.code}）：${error.message.slice(0,1200)}。${instruction} 已累计 ${state.errors}/${limits.guardMaxErrors} 次错误，成功调用不会清零；确定失败并完成核实后的修正写入使用新的 requestId。`);
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
  function remaining(state){return {toolCalls:nonnegative(limits.guardMaxToolCalls-state.calls),steps:nonnegative(limits.guardMaxSteps-state.steps),errors:nonnegative(limits.guardMaxErrors-state.errors),timeMs:state.active?nonnegative(state.deadlineAt-Date.now()):limits.guardTimeoutMs,recoveryCalls:state.summaryOnly?0:nonnegative(RECOVERY_CALL_LIMIT-state.recoveryTokens.size)};}
  function status(sessionId){
    const state=rounds.get(sessionId);if(!state)return null;
    const {turn,boundarySource,active,halted,reason,calls,errors,steps,startedAt,deadlineAt}=state;
    const left=remaining(state);
    const near=active&&(calls/limits.guardMaxToolCalls>=0.8||steps/limits.guardMaxSteps>=0.8||errors/limits.guardMaxErrors>=0.8||left.timeMs/limits.guardTimeoutMs<=0.2);
    const warning=state.budgetExhausted?`${reason} 请准备总结当前结果与未完成部分。`:near?'Unreal 本轮预算接近上限，请优先完成当前验证，并准备报告未完成部分。':null;
    return {turn,boundarySource,active,halted,reason,calls,toolCalls:calls,errors,lastError:state.lastError,steps,startedAt:startedAt??null,deadlineAt:deadlineAt??null,limits:{...limits},crossToolEnforcement:typeof ctx.on==='function',phase:halted?'halted':state.budgetExhausted?'summary':warning?'warning':active?'active':'idle',budgetExhausted:state.budgetExhausted,exhaustedBy:state.exhaustedBy,summaryOnly:state.summaryOnly,recoveryCallsUsed:state.recoveryTokens.size,remaining:left,warning};
  }
  function dispose(){
    if(disposed)return;disposed=true;
    for(const state of rounds.values())clearTimer(state);
    for(const remove of removers.splice(0))remove();
    rounds.clear();
  }
  return {before,after,dispose,status};
}
