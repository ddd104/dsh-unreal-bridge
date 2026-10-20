import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {ExecutionStatus} from '../src/execution-client.mjs';
import {CachePanel} from '../src/cache-client.mjs';

test('execution display distinguishes issue limits, deferred settings and editor-wide write protection',async()=>{
  let tree;
  const status={phase:'active',active:true,toolCalls:7,steps:4,errors:2,limits:{guardMaxToolCalls:100,guardMaxSteps:60,guardMaxErrors:30,guardMaxRepairAttempts:3,guardMaxRepeatedErrors:2},remaining:{toolCalls:93,steps:56,errors:28,timeMs:90000},repairs:{issues:[{target:'/Game/A.A',repairAttempts:1,status:'blocked'}]},lastError:{code:'MCP_TOOL_ERROR',message:'原始错误'}};
  await act(async()=>{tree=Renderer.create(React.createElement(ExecutionStatus,{state:{sessionId:'one',executionSafety:status,settings:{nextTurnPending:true},editorWrite:{sessionId:'two',phase:'pending',method:'apply_patch'}}}));});
  const text=JSON.stringify(tree.toJSON());
  for(const value of ['执行中','剩余 1 分 30 秒','单问题修复上限 3 次','修复 1/3','已达限制','其他对话','下一轮任务生效','原始错误'])assert.ok(text.includes(value),value);
  assert.equal(tree.root.findAllByType('progress').length,3);
  await act(async()=>{tree.update(React.createElement(ExecutionStatus,{state:{executionSafety:{...status,active:false,phase:'completed',startedAt:1,elapsedMs:2100},writeLock:{code:'ROLLBACK_FAILED'}}}));});
  const completed=JSON.stringify(tree.toJSON());
  assert.ok(completed.includes('本轮已结束'));assert.ok(completed.includes('写入已锁定'));
  assert.ok(!completed.includes('剩余 1 分 30 秒'));
  await act(async()=>tree.unmount());
});

test('cache page only cleans on explicit action and asks to confirm early evidence deletion',async()=>{
  let tree,reads=0;const calls=[];
  const read=async()=>{reads++;return{visual:{bytes:2048,entries:2,overBudgetBytes:0},audit:{bytes:512,archives:1}};};
  const cleanup=async options=>{calls.push(options);return {deleted:{bytes:1024,visualEntries:1,auditArchives:0}};};
  await act(async()=>{tree=Renderer.create(React.createElement(CachePanel,{read,cleanup}));});
  assert.equal(reads,1);assert.deepEqual(calls,[]);
  const button=label=>tree.root.findAllByType('button').find(node=>node.children.includes(label));
  await act(async()=>button('清空闲置证据和归档').props.onClick());
  assert.deepEqual(calls,[]);assert.match(JSON.stringify(tree.toJSON()),/旧截图编号将失效/);
  await act(async()=>button('取消').props.onClick());
  assert.deepEqual(calls,[]);
  await act(async()=>button('按已保存策略清理').props.onClick());
  assert.deepEqual(calls,[{mode:'policy'}]);assert.equal(reads,2);
  await act(async()=>button('清空闲置证据和归档').props.onClick());
  await act(async()=>button('确认清空闲置缓存').props.onClick());
  assert.deepEqual(calls,[{mode:'policy'},{mode:'all_idle'}]);
  assert.match(JSON.stringify(tree.toJSON()),/已释放/);
  await act(async()=>tree.unmount());
});
