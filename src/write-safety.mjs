// Older editor bridges report only a code. Newer bridges also report rollback
// evidence, which takes precedence over retry hints or an outer read-only label.
const UNSAFE_WRITE_CODES=new Set(['ROLLBACK_FAILED','DATA_TABLE_ROLLBACK_FAILED','EDITOR_WRITE_LOCKED']);

/** Inspect supported error/result envelopes without interpreting message text. */
export function isUnsafeWriteError(error){
  const pending=[error],seen=new Set();
  while(pending.length){
    const value=pending.pop();
    if(!value||typeof value!=='object'||seen.has(value))continue;
    seen.add(value);
    if(UNSAFE_WRITE_CODES.has(value.code)||value.rollback==='failed')return true;
    for(const key of ['error','info','details','structuredContent','ueResult'])pending.push(value[key]);
  }
  return false;
}
