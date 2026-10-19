import {BridgeError} from './protocol.mjs';

const DEFAULTS={guardMaxToolCalls:40,guardMaxSteps:40,guardMaxErrors:3,guardTimeoutMs:180000};
const FATAL_CODES=new Set(['MCP_POLICY_BLOCKED','MCP_TOOL_ERROR','DATA_TABLE_COPY_UNAVAILABLE','DATA_TABLE_VERIFICATION_FAILED','DATA_TABLE_ROLLBACK_FAILED','EDITOR_WRITE_LOCKED']);
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
  const limits={...DEFAULTS};
  for(const key of Object.keys(DEFAULTS)){
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
    const state={sessionId,turn,boundary,boundarySource,active:false,halted:false,reason:null,calls:0,errors:0,currentStep:0,activationStep:0,steps:0,roots:new Set(),failedRoots:new Set(),tokenRoots:new Map()};
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
    const root=rootOf(state,exec);executions.set(exec,{state,root});
    if(state.halted)throw haltedError(state);
    if(!state.active&&/^unreal_/.test(exec.name??''))activate(state);
    if(!state.active)return;
    if(Date.now()>=state.deadlineAt)halt(state,`Unreal 任务已超过 ${limits.guardTimeoutMs/1000} 秒，已停止本轮执行。`);
    if(!state.halted&&prohibitedInput(exec))halt(state,'Unreal 任务禁止通过终端调用真实鼠标或剪贴板接口；已停止本轮执行，请使用编辑器结构化工具。');
    if(!state.halted&&!state.roots.has(root)){
      state.roots.add(root);state.calls++;
      if(state.calls>limits.guardMaxToolCalls)halt(state,`Unreal 任务已达到 ${limits.guardMaxToolCalls} 次工具调用上限，已停止本轮执行，请检查当前结果后缩小任务范围。`);
    }
    if(state.halted)throw haltedError(state);
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
    const details=error?.details??body?.details;
    if(!state.failedRoots.has(root)){state.failedRoots.add(root);state.errors++;}
    if(FATAL_CODES.has(code)||details?.rollback==='failed'){
      const recovery=details?.rollback==='restored'?'工具已验证恢复到操作前的内存数据。':details?.rollback==='failed'?'回滚未能验证，编辑器写入已锁定。':details?.rollback==='not_available'?'该工具未提供回滚，资产修改状态尚未验证。':code==='MCP_POLICY_BLOCKED'||code==='DATA_TABLE_COPY_UNAVAILABLE'?'请求已在写入前拦截。':'请先检查修改与回滚结果。';
      halt(state,`Unreal 任务遇到不可继续的错误（${code??'回滚失败'}），已停止本轮执行。${recovery}`);
    }
    else if(state.errors>=limits.guardMaxErrors)halt(state,`Unreal 任务已累计 ${state.errors} 次工具错误，已停止本轮执行，请检查错误原因后重新发起任务。`);
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
        const state=rounds.get(session.id);if(state&&state.turn===event.data.turn)state.currentStep=event.data.step;
      }
    });
    on('tools/pre-execute',async(exec,next)=>{
      try{before(exec);}catch(error){if(error.code==='EXECUTION_HALTED')return {kind:'cancel'};throw error;}
      return next();
    });
    on('tools/post-execute',async(exec,result,next)=>{const decision=await next();after(exec,result);return decision;});
    on('agent/pre-step',async(payload,next)=>{
      const state=stateFor({agent:payload.agent});
      if(state){
        state.currentStep=payload.step;
        if(state.active){
          state.steps=payload.step-state.activationStep+1;
          if(state.steps>limits.guardMaxSteps)halt(state,`Unreal 任务已达到 ${limits.guardMaxSteps} 个模型步骤上限，已停止本轮执行。`);
          if(state.halted)return {kind:'reject'};
        }
      }
      return next();
    });
  }
  function status(sessionId){
    const state=rounds.get(sessionId);if(!state)return null;
    const {turn,boundarySource,active,halted,reason,calls,errors,steps,startedAt,deadlineAt}=state;
    return {turn,boundarySource,active,halted,reason,calls,toolCalls:calls,errors,steps,startedAt:startedAt??null,deadlineAt:deadlineAt??null,limits:{...limits},crossToolEnforcement:typeof ctx.on==='function'};
  }
  function dispose(){
    if(disposed)return;disposed=true;
    for(const state of rounds.values())clearTimer(state);
    for(const remove of removers.splice(0))remove();
    rounds.clear();
  }
  return {before,after,dispose,status};
}
