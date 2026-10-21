const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));

/** Model-facing safety summary. Keep the full guard projection for state/UI. */
export function compactExecutionSafety(status,result){
  if(!status)return null;
  const summary=pick(status,['phase','halted','budgetExhausted','summaryOnly','exhaustedBy']);
  summary.remaining=pick(status.remaining,['toolCalls','steps','errors','timeMs','recoveryCalls']);
  if(status.reason)summary.reason=status.reason;
  if(status.warning&&status.warning!==status.reason)summary.warning=status.warning;
  const error=result?.ok===false?result.error:null;
  if(error){
    const details=error.details??{};
    summary.error={
      ...pick(error,['code']),
      ...pick(details,['requestId','rollback','recovery','recoveryConstraints','execution','retryable']),
    };
    // Repair-denial results carry their own problem. For a just-completed
    // failure the guard carries it, but never attach a previous unrelated one.
    const current=status.lastError?.code===error.code&&status.lastError?.message===error.message?status.lastError:null;
    const problem=details.problem??current?.problem;
    if(problem)summary.error.problem=pick(problem,['editorId','target','family','status','blockedBy','remainingAttempts']);
    for(const key of ['rollback','recovery','recoveryConstraints'])if(summary.error[key]===undefined&&current?.[key]!==undefined)summary.error[key]=current[key];
  }
  return summary;
}
