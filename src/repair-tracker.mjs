import {createHash} from 'node:crypto';
import {BridgeError} from './protocol.mjs';
import {isUnsafeWriteError} from './write-safety.mjs';
import {DEFAULTS} from './settings-spec.mjs';

export const REPAIR_LIMIT_DEFAULTS=Object.freeze({guardMaxRepairAttempts:DEFAULTS.guardMaxRepairAttempts,guardMaxRepeatedErrors:DEFAULTS.guardMaxRepeatedErrors});
const MAX_ISSUES=512, DISPLAY_ISSUES=32;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DISPATCHED_ERRORS=new Set(['OUTCOME_UNKNOWN','IN_PROGRESS','BUSY','EDITOR_BUSY','EDITOR_WRITE_LOCKED','READ_ONLY','PERMISSION_DENIED','APPROVAL_UNAVAILABLE']);
const PROTECTED_ERRORS=new Set(['TIMEOUT','CANCELLED','DISCONNECTED',...NOT_DISPATCHED_ERRORS]);
const normalized=value=>value.trim().toLowerCase();
const fingerprint=error=>createHash('sha256').update(JSON.stringify([
  error.code??'ERROR',
  String(error.message??'').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'<id>').replace(/\s+/g,' ').trim(),
  // Schema errors often share one display message. Correcting a different
  // missing field is progress; unrelated request IDs and input values are not.
  (Array.isArray(error.details?.issues)?error.details.issues:[]).slice(0,20).map(issue=>JSON.stringify([
    issue.path??issue.instancePath??null,issue.keyword??null,issue.message??null,
    issue.missingProperty??null,issue.additionalProperty??null,
  ])).sort(),
])).digest('hex');

/** Only the host wrapper may supply this evidence; it is never read from tool arguments. */
export function operationEvidence(value){
  if(!value||!['read','preview','write'].includes(value.kind))throw new TypeError('Operation kind must be read, preview, or write');
  for(const key of ['editorId','target','family']){
    if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>2048)throw new TypeError(`Operation ${key} must be a nonempty bounded string`);
  }
  return Object.freeze({editorId:value.editorId,target:value.target,family:value.family,kind:value.kind,blocked:value.blocked===true,
    ...(typeof value.requestId==='string'&&UUID.test(value.requestId)?{requestId:value.requestId}:{}),
    ...(typeof value.statusRequestId==='string'&&UUID.test(value.statusRequestId)?{statusRequestId:value.statusRequestId}:{}),
  });
}

/** Per-turn problem budgets. Successful corrections retain the consumed allowance. */
export class RepairTracker{
  constructor(limits){
    this.limits=limits;
    this.issues=new Map();
    this.awaiting=new Map();
    this.sequence=0;
    this.overflow=false;
  }
  key(operation){return JSON.stringify([normalized(operation.editorId),normalized(operation.target),normalized(operation.family)]);}
  requestKey(editorId,requestId){return JSON.stringify([normalized(editorId),requestId.toLowerCase()]);}
  summary(issue){
    return {
      editorId:issue.editorId,target:issue.target,family:issue.family,status:issue.status,
      failures:issue.failures,repairAttempts:issue.repairAttempts,
      remainingAttempts:Math.max(0,this.limits.guardMaxRepairAttempts-issue.repairAttempts),
      repeatedErrors:issue.repeatedErrors,blockedBy:issue.blockedBy,lastCode:issue.lastCode,lastMessage:issue.lastMessage,
    };
  }
  issueFor(ticket){
    const issue=ticket?this.issues.get(ticket.key):null;
    return issue?this.summary(issue):null;
  }
  denied(issue){
    const reason=issue.blockedBy==='repeated_errors'
      ?`同一问题已连续出现 ${issue.repeatedErrors} 次相同错误`
      :`同一问题已用完 ${this.limits.guardMaxRepairAttempts} 次修复写入额度`;
    return new BridgeError('REPAIR_BUDGET_EXHAUSTED',`${reason}。停止重试这一项；可以继续读取诊断、查询原请求状态或处理其他目标和独立操作。`,{
      execution:'not_started',retryable:false,scope:'problem',canContinueIndependentWork:true,problem:this.summary(issue),
    });
  }
  admit(operation){
    if(operation.kind==='read'||operation.blocked)return null;
    const key=this.key(operation),issue=this.issues.get(key);
    if(issue?.status==='blocked')throw this.denied(issue);
    if(!issue&&this.issues.size>=MAX_ISSUES){
      this.overflow=true;
      throw new BridgeError('REPAIR_TRACKING_LIMIT','本轮问题记录已满；请保留当前结果并在新一轮继续新的修改。读取与已有问题的诊断仍可继续。',{execution:'not_started',retryable:false,scope:'problem_tracking'});
    }
    const ticket={key,operation,completed:false,charged:false};
    // Validation previews diagnose an intended edit. Only dispatching a writing
    // attempt consumes a repair allowance, so preview + apply costs at most one.
    if(operation.kind==='write'&&issue?.status==='needs_repair'){
      if(issue.repairAttempts>=this.limits.guardMaxRepairAttempts){
        issue.status='blocked';issue.blockedBy='repair_attempts';throw this.denied(issue);
      }
      issue.repairAttempts++;ticket.charged=true;
    }
    return ticket;
  }
  complete(ticket,error){
    if(!ticket||ticket.completed)return;
    ticket.completed=true;
    const {key,operation}=ticket;
    let issue=this.issues.get(key);
    if(!error){
      if(!issue)return;
      if(operation.kind==='write'){
        issue.status='resolved';issue.blockedBy=null;issue.repeatedErrors=0;issue.lastFingerprint=null;
      }else if(issue.lastFailureKind==='preview'){
        issue.repeatedErrors=0;issue.lastFingerprint=null;
      }
      return;
    }
    if(PROTECTED_ERRORS.has(error.code)||isUnsafeWriteError(error)){
      // Another conversation's lock or a declined approval is not a correction
      // attempt. A timeout after dispatch remains charged until its outcome is known.
      if(ticket.charged&&issue&&(NOT_DISPATCHED_ERRORS.has(error.code)||error.details?.execution==='not_started')){
        issue.repairAttempts--;
        if(issue.blockedBy==='repair_attempts'&&issue.repairAttempts<this.limits.guardMaxRepairAttempts){issue.status='needs_repair';issue.blockedBy=null;}
      }
      if(ticket.charged&&issue&&operation.requestId&&['TIMEOUT','CANCELLED','DISCONNECTED'].includes(error.code)&&error.details?.execution!=='not_started'){
        this.awaiting.set(this.requestKey(operation.editorId,operation.requestId),ticket);
      }
      return;
    }
    if(!issue){
      if(this.issues.size>=MAX_ISSUES){this.overflow=true;return;}
      issue={editorId:operation.editorId,target:operation.target,family:operation.family,failures:0,repairAttempts:0,repeatedErrors:0,lastFingerprint:null,lastCode:null,lastMessage:null,lastFailureKind:null,status:'needs_repair',blockedBy:null,sequence:++this.sequence};
      this.issues.set(key,issue);
    }
    const hash=fingerprint(error);
    issue.failures++;
    issue.repeatedErrors=hash===issue.lastFingerprint?issue.repeatedErrors+1:1;
    issue.lastFingerprint=hash;issue.lastCode=error.code??'ERROR';issue.lastMessage=String(error.message??'Tool execution failed').slice(0,400);
    issue.lastFailureKind=operation.kind;issue.status='needs_repair';issue.blockedBy=null;
    if(issue.repeatedErrors>=this.limits.guardMaxRepeatedErrors){issue.status='blocked';issue.blockedBy='repeated_errors';}
    else if(issue.repairAttempts>=this.limits.guardMaxRepairAttempts){issue.status='blocked';issue.blockedBy='repair_attempts';}
  }
  reconcile(operation,result){
    if(operation?.kind!=='read'||!operation.statusRequestId||result?.status!=='completed'||result.response?.ok!==true)return;
    const value=result.response.result;
    if(!value||typeof value!=='object'||value.isError===true||value.ok===false)return;
    const key=this.requestKey(operation.editorId,operation.statusRequestId),ticket=this.awaiting.get(key);
    if(!ticket)return;
    this.awaiting.delete(key);
    // Reconcile a known result; this is not another correction or a budget reset.
    ticket.completed=false;this.complete(ticket,null);
    return true;
  }
  status(){
    const all=[...this.issues.values()];
    const visible=all.slice().sort((a,b)=>(a.status==='blocked'?-1:0)-(b.status==='blocked'?-1:0)||b.sequence-a.sequence).slice(0,DISPLAY_ISSUES);
    return {issues:visible.map(issue=>this.summary(issue)),total:all.length,attemptsUsed:all.reduce((sum,issue)=>sum+issue.repairAttempts,0),failures:all.reduce((sum,issue)=>sum+issue.failures,0),activeCount:all.filter(issue=>issue.status==='needs_repair').length,blockedCount:all.filter(issue=>issue.status==='blocked').length,resolvedCount:all.filter(issue=>issue.status==='resolved').length,hiddenCount:Math.max(0,all.length-DISPLAY_ISSUES),capacityReached:this.overflow||all.length>=MAX_ISSUES};
  }
}
