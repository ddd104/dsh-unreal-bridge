import test from 'node:test';
import assert from 'node:assert/strict';
import {compactExecutionSafety} from '../src/compact-safety.mjs';

const problem={editorId:'UE',target:'/game/m_test.m_test',family:'material_edit',status:'blocked',blockedBy:'repair_attempts',remainingAttempts:0,lastMessage:'A long repeated error',failures:4,repairAttempts:3};
const status=()=>({
  phase:'warning',halted:false,budgetExhausted:false,summaryOnly:false,exhaustedBy:null,
  warning:'Budget nearing its limit',remaining:{toolCalls:10,steps:5,errors:3,timeMs:2000,recoveryCalls:2},
  limits:{guardMaxToolCalls:300},repairs:{issues:Array(32).fill(problem)},lastError:{code:'MCP_TOOL_ERROR',message:'No output pin',rollback:'not_available',recovery:'stop_problem',problem},
});

test('model safety summaries omit repeated inventories and retain current error recovery evidence without mutating UI state',()=>{
  const state=status(),before=structuredClone(state);
  const result={ok:false,error:{code:'MCP_TOOL_ERROR',message:'No output pin',details:{requestId:'original-request',rollback:'not_available',execution:'completed',retryable:true}}};
  const summary=compactExecutionSafety(state,result);
  assert.deepEqual(summary.remaining,state.remaining);
  assert.deepEqual(summary.error,{code:'MCP_TOOL_ERROR',requestId:'original-request',rollback:'not_available',execution:'completed',retryable:true,recovery:'stop_problem',problem:{editorId:'UE',target:problem.target,family:'material_edit',status:'blocked',blockedBy:'repair_attempts',remainingAttempts:0}});
  assert.equal('limits' in summary,false);assert.equal('repairs' in summary,false);assert.equal('lastError' in summary,false);
  assert.ok(JSON.stringify(summary).length<JSON.stringify(state).length/5);
  assert.deepEqual(state,before);
  summary.remaining.toolCalls=0;assert.equal(state.remaining.toolCalls,10);
});

test('repair denial keeps its own problem and unrelated errors do not inherit stale material failures',()=>{
  const state=status();
  const recoveryConstraints={retainTarget:true,retainDiagnostics:true,prohibitedWorkarounds:['rename_target','duplicate_target','rebuild_replacement'],independentWork:'already_requested_unrelated_work',resumeSameProblem:'new_user_turn'};
  state.lastError.recoveryConstraints=recoveryConstraints;
  const initial=compactExecutionSafety(state,{ok:false,error:{code:'MCP_TOOL_ERROR',message:'No output pin'}});
  assert.deepEqual(initial.error.recoveryConstraints,recoveryConstraints);
  const denied=compactExecutionSafety(state,{ok:false,error:{code:'REPAIR_BUDGET_EXHAUSTED',details:{execution:'not_started',retryable:false,problem,recovery:'stop_problem',recoveryConstraints}}});
  assert.equal(denied.error.problem.target,problem.target);assert.equal(denied.error.code,'REPAIR_BUDGET_EXHAUSTED');
  assert.equal(denied.error.recovery,'stop_problem');assert.deepEqual(denied.error.recoveryConstraints,recoveryConstraints);
  const unrelated=compactExecutionSafety(state,{ok:false,error:{code:'TIMEOUT',message:'Query timed out',details:{requestId:'pending-request',recovery:'check_request_status'}}});
  assert.equal(unrelated.error.requestId,'pending-request');assert.equal(unrelated.error.recovery,'check_request_status');
  assert.equal('problem' in unrelated.error,false);assert.equal('rollback' in unrelated.error,false);assert.equal('recoveryConstraints' in unrelated.error,false);
  assert.equal('error' in compactExecutionSafety(state,{ok:true}),false);
});

test('unsafe state and exhausted recovery allowances remain explicit in compact summaries',()=>{
  const state={...status(),phase:'summary',budgetExhausted:true,summaryOnly:true,exhaustedBy:'unsafe_state',reason:'Rollback failed',warning:'Rollback failed'};
  const summary=compactExecutionSafety(state,{ok:false,error:{code:'EDITOR_WRITE_LOCKED',details:{requestId:'unsafe-request',rollback:'failed',recovery:'stop_writes',retryable:false}}});
  assert.equal(summary.exhaustedBy,'unsafe_state');assert.equal(summary.summaryOnly,true);
  assert.equal(summary.reason,'Rollback failed');assert.equal('warning' in summary,false);
  assert.equal(summary.error.rollback,'failed');assert.equal(summary.error.retryable,false);
  assert.equal(summary.error.recovery,'stop_writes');
  assert.equal(compactExecutionSafety(null,{ok:true}),null);
  assert.deepEqual(summary,JSON.parse(JSON.stringify(summary)));
});

test('material editor conflict recovery keeps the exact target and pending-edit constraints in compact output',()=>{
  const recoveryConstraints={target:'/game/m_useredits.m_useredits',retainPendingEdits:true,prohibitedWorkarounds:['apply_pending_edits','discard_pending_edits','close_editor','switch_tools','replace_asset'],independentWork:'reads_and_already_requested_unrelated_targets',resumeSameTarget:'after_editor_conflict_resolved_and_fresh_read'};
  const code='MATERIAL_EDITOR_CONFLICT',message='The material editor has unapplied changes';
  const state={...status(),lastError:{code,message,rollback:'not_needed',recovery:'resolve_editor_conflict',recoveryConstraints}};
  const summary=compactExecutionSafety(state,{ok:false,error:{code,message,details:{execution:'not_started',rollback:'not_needed',retryable:false}}});
  assert.equal(summary.error.recovery,'resolve_editor_conflict');
  assert.deepEqual(summary.error.recoveryConstraints,recoveryConstraints);
  assert.equal(summary.error.rollback,'not_needed');assert.equal(summary.error.execution,'not_started');
  assert.equal('problem' in summary.error,false);
  assert.equal('recoveryConstraints' in compactExecutionSafety(state,{ok:false,error:{code:'OTHER_ERROR',message:'Unrelated'}}).error,false);
});
