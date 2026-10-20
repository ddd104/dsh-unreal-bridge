import test from 'node:test';
import assert from 'node:assert/strict';
import {RepairTracker,REPAIR_LIMIT_DEFAULTS,operationEvidence} from '../src/repair-tracker.mjs';

const operation=(extra={})=>operationEvidence({editorId:'UE-A',target:'/Game/Test/BP_Test',family:'blueprint_edit',kind:'write',...extra});
const error=(message='Pin type mismatch',code='VALIDATION_FAILED')=>({code,message,details:{execution:'not_started'}});
const tracker=config=>new RepairTracker({...REPAIR_LIMIT_DEFAULTS,...config});
function fail(subject,metadata=operation(),failure=error()){
  const ticket=subject.admit(metadata);subject.complete(ticket,failure);return ticket;
}

test('the first failure starts an issue and at most three later writes are admitted',()=>{
  const subject=tracker({guardMaxRepeatedErrors:20});
  fail(subject);
  assert.equal(subject.status().attemptsUsed,0);
  for(let attempt=1;attempt<=3;attempt++){
    fail(subject,operation(),error(`Corrected attempt ${attempt}`));
    assert.equal(subject.status().attemptsUsed,attempt);
  }
  assert.throws(()=>subject.admit(operation()),e=>e.code==='REPAIR_BUDGET_EXHAUSTED'&&e.details.scope==='problem');
  assert.equal(subject.status().blockedCount,1);
  assert.ok(subject.admit(operation({target:'/Game/Test/BP_Other'})));
  assert.ok(subject.admit(operation({family:'save'})));
  assert.ok(subject.admit(operation({editorId:'UE-B'})));
});

test('zero repair allowance stops correction after the initial failure',()=>{
  const subject=tracker({guardMaxRepairAttempts:0});
  fail(subject);
  assert.throws(()=>subject.admit(operation()),{code:'REPAIR_BUDGET_EXHAUSTED'});
  assert.equal(subject.admit(operation({kind:'read'})),null);
});

test('changing request identity or casing cannot reset a problem and identical UUID-bearing errors repeat',()=>{
  const subject=tracker();
  fail(subject,operation(),error('Cannot connect request 12345678-1234-1234-1234-123456789abc'));
  fail(subject,operation({target:'/game/test/bp_test',family:'BLUEPRINT_EDIT'}),error('Cannot connect request abcdefab-abcd-abcd-abcd-abcdefabcdef'));
  assert.equal(subject.status().total,1);
  assert.equal(subject.status().issues[0].blockedBy,'repeated_errors');
  assert.throws(()=>subject.admit(operation()),{code:'REPAIR_BUDGET_EXHAUSTED'});
});

test('previews and reads do not spend write attempts or clear a write failure streak',()=>{
  const subject=tracker();
  fail(subject);
  subject.complete(subject.admit(operation({kind:'read'})),null);
  subject.complete(subject.admit(operation({kind:'preview'})),null);
  assert.equal(subject.status().attemptsUsed,0);
  fail(subject);
  assert.equal(subject.status().issues[0].blockedBy,'repeated_errors');
  assert.equal(subject.status().attemptsUsed,1);
});

test('generic schema messages distinguish focused corrections but ignore unrelated request IDs',()=>{
  const subject=tracker();
  const failure=path=>({code:'MCP_INVALID_ARGUMENTS',message:'Arguments do not match schema',details:{requestId:Math.random().toString(),issues:[{path,keyword:'required',missingProperty:'value'}]}});
  fail(subject,operation(),failure('/first'));
  fail(subject,operation(),failure('/second'));
  assert.equal(subject.status().issues[0].repeatedErrors,1);
  fail(subject,operation(),failure('/second'));
  assert.equal(subject.status().issues[0].blockedBy,'repeated_errors');
});

test('failed validation previews create bounded problems without charging a future apply twice',()=>{
  const subject=tracker();
  fail(subject,operation({kind:'preview'}));
  subject.complete(subject.admit(operation({kind:'preview'})),null);
  assert.equal(subject.status().issues[0].repeatedErrors,0);
  subject.complete(subject.admit(operation()),null);
  assert.equal(subject.status().attemptsUsed,1);
  assert.equal(subject.status().resolvedCount,1);
  const repeated=tracker();
  fail(repeated,operation({kind:'preview'}));fail(repeated,operation({kind:'preview'}));
  assert.throws(()=>repeated.admit(operation({kind:'preview'})),{code:'REPAIR_BUDGET_EXHAUSTED'});
  assert.equal(repeated.status().attemptsUsed,0);
});

test('success resolves the current issue but cannot erase this turn repair usage',()=>{
  const subject=tracker({guardMaxRepairAttempts:1,guardMaxRepeatedErrors:20});
  fail(subject);
  subject.complete(subject.admit(operation()),null);
  assert.equal(subject.status().resolvedCount,1);
  assert.equal(subject.status().attemptsUsed,1);
  fail(subject,operation(),error('A later edit fails differently'));
  assert.throws(()=>subject.admit(operation()),{code:'REPAIR_BUDGET_EXHAUSTED'});
  assert.equal(subject.status().attemptsUsed,1);
});

test('parallel corrections reserve attempts atomically and completion can only be charged once',()=>{
  const subject=tracker({guardMaxRepairAttempts:2,guardMaxRepeatedErrors:20});
  fail(subject);
  const one=subject.admit(operation()),two=subject.admit(operation());
  assert.throws(()=>subject.admit(operation()),{code:'REPAIR_BUDGET_EXHAUSTED'});
  subject.complete(one,error('A'));subject.complete(one,error('A duplicate callback'));subject.complete(two,error('B'));
  assert.equal(subject.status().attemptsUsed,2);assert.equal(subject.status().failures,3);
});

test('unknown outcomes and unsafe state remain the responsibility of the editor write barrier',()=>{
  for(const code of ['TIMEOUT','CANCELLED','DISCONNECTED','OUTCOME_UNKNOWN','BUSY','EDITOR_BUSY','ROLLBACK_FAILED','EDITOR_WRITE_LOCKED']){
    const subject=tracker();fail(subject,operation(),error('Protected state',code));
    assert.equal(subject.status().total,0,code);
  }
  const subject=tracker({guardMaxRepairAttempts:0});fail(subject);
  assert.equal(subject.admit(operation({blocked:true})),null,'the original barrier can report its stronger reason');
});

test('permission denials and write-barrier races do not spend correction attempts',()=>{
  for(const code of ['OUTCOME_UNKNOWN','BUSY','EDITOR_BUSY','EDITOR_WRITE_LOCKED','READ_ONLY','PERMISSION_DENIED','APPROVAL_UNAVAILABLE']){
    const subject=tracker({guardMaxRepairAttempts:1});fail(subject);
    const correction=subject.admit(operation());subject.complete(correction,{code,message:'Not dispatched'});
    assert.equal(subject.status().attemptsUsed,0,code);
    assert.ok(subject.admit(operation()),code);
  }
});

test('a recovered successful write resolves its original issue without restoring spent attempts',()=>{
  const subject=tracker({guardMaxRepairAttempts:1});
  fail(subject);
  const requestId='12345678-1234-1234-1234-123456789abc';
  fail(subject,operation({requestId}),{code:'TIMEOUT',message:'Unknown write outcome'});
  const completed={status:'completed',response:{ok:true,result:{saved:true}}};
  subject.reconcile(operation({kind:'read',statusRequestId:requestId,editorId:'UE-B'}),completed);
  assert.equal(subject.status().resolvedCount,0,'another editor cannot resolve this request');
  subject.reconcile(operation({kind:'read',statusRequestId:requestId}),completed);
  assert.equal(subject.status().resolvedCount,1);assert.equal(subject.status().attemptsUsed,1);
  assert.ok(subject.admit(operation()),'normal work can continue after confirmed recovery');
  subject.reconcile(operation({kind:'read',statusRequestId:requestId}),completed);
  assert.equal(subject.status().attemptsUsed,1,'duplicate status does not alter counters');
});

test('UI summaries and retained problems are bounded without evicting spent allowances',()=>{
  const subject=tracker({guardMaxRepairAttempts:0});
  for(let index=0;index<512;index++)fail(subject,operation({target:`/Game/BP_${index}`}));
  const state=subject.status();
  assert.equal(state.total,512);assert.equal(state.issues.length,32);assert.equal(state.hiddenCount,480);
  assert.throws(()=>subject.admit(operation({target:'/Game/BP_0'})),{code:'REPAIR_BUDGET_EXHAUSTED'});
  assert.throws(()=>subject.admit(operation({target:'/Game/New'})),{code:'REPAIR_TRACKING_LIMIT'});
  assert.deepEqual(state,JSON.parse(JSON.stringify(state)));
});
