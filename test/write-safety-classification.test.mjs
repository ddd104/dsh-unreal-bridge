import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeError} from '../src/protocol.mjs';
import {isUnsafeWriteError} from '../src/write-safety.mjs';

test('legacy Blueprint rollback failures remain unsafe through supported result envelopes',()=>{
  const error=new BridgeError('ROLLBACK_FAILED','Original edit could not be restored');
  for(const value of [
    error,
    {ok:false,error},
    {isError:true,structuredContent:{error}},
    {info:{code:'ROLLBACK_FAILED'}},
    {details:{rollback:'not_available',ueResult:{error}}},
    {details:{rollback:'failed',retryable:true}},
  ])assert.equal(isUnsafeWriteError(value),true);
});

test('ordinary, restored and unstarted failures do not acquire a write lock',()=>{
  for(const value of [
    null,
    new Error('ROLLBACK_FAILED appears only in text'),
    {code:'APPLY_FAILED_ROLLED_BACK',details:{execution:'completed',rollback:'restored',retryable:true}},
    {code:'VALIDATION_FAILED',details:{execution:'not_started',rollback:'not_needed'}},
    {code:'MCP_TOOL_ERROR',details:{rollback:'not_available'}},
    {content:[{type:'text',text:'{"code":"ROLLBACK_FAILED"}'}]},
  ])assert.equal(isUnsafeWriteError(value),false);
});

test('envelope cycles cannot hang safety classification or hide explicit failure',()=>{
  const value={error:{}};value.error.info=value;
  assert.equal(isUnsafeWriteError(value),false);
  value.details={rollback:'failed'};
  assert.equal(isUnsafeWriteError(value),true);
});
