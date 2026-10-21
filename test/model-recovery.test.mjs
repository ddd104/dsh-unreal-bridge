import test from 'node:test';
import assert from 'node:assert/strict';
import {registerModelRecovery} from '../src/model-recovery.mjs';

const failure={code:'MALFORMED_RESPONSE',message:'DeepSeek Messages stream: tool input is invalid JSON'};
function fixture(t,{limit=2,tool='unreal_material_patch',args='{"position":{"x":420,"y":300}},"properties":{}}'}={}){
  const hooks=new Map(),events=[],controller=new AbortController();
  const session={id:'chat',snapshotEvents:()=>[...events],append(type,data,intent){
    assert.deepEqual(data,JSON.parse(JSON.stringify(data)));
    assert.deepEqual(intent,{surfaceOp:'append'});
    events.push({type,data,seq:events.length});
  }};
  const state={turn:1,active:true,halted:false,budgetExhausted:false,summaryOnly:false,limits:{guardMaxMalformedRetries:limit}};
  const ctx={on:(name,callback)=>{hooks.set(name,callback);return()=>hooks.delete(name);}};
  const guard={status:()=>state};
  const mount=()=>registerModelRecovery(ctx,guard);
  const dispose=mount();t.after(dispose);
  events.push({type:'turn/start',seq:0,data:{turn:1}});
  function attempt(step=2,overrides={}){
    events.push({type:'assistant/attempt',seq:events.length,data:{turn:1,step,stream:[
      {type:'chunk',chunk:{type:'block-end',index:0,block:{type:'tool-call',id:'call',name:tool,arguments:args,...overrides}}},
      {type:'chunk',chunk:{type:'finish',reason:{kind:'error',failure}}},
    ]}});
  }
  attempt();
  const payload={agent:{session},turn:1,step:2,failure,signal:controller.signal};
  const recover=(next=async()=>undefined,overrides={})=>hooks.get('agent/request-error')({...payload,...overrides},next);
  return {events,state,ctx,guard,session,controller,payload,recover,attempt,dispose,mount,hooks};
}

test('invalid UE JSON is regenerated with a durable correction and its arguments are never executed or copied',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.recover(),{kind:'retry'});
  const notice=f.events.at(-1);
  assert.equal(notice.type,'user/message');assert.equal(notice.data.role,'user');
  assert.equal(notice.data.source.kind,'unreal-model-recovery');assert.equal(notice.data.source.attemptSeq,1);
  const text=notice.data.content[0].text;
  assert.match(text,/unreal_material_patch.*不是合法 JSON/);assert.match(text,/均未执行/);
  assert.match(text,/不要重放更早已完成的工具/);assert.match(text,/第 1\/2 次/);
  assert.doesNotMatch(text,/"properties"/);
  assert.equal(f.events.filter(e=>e.type==='tool/call').length,0);
  assert.equal(await f.recover(),undefined,'The same failed attempt cannot spend another retry');
});

test('the per-turn cap survives remounts and is shared across failed steps and tools',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.recover(),{kind:'retry'});
  f.dispose();const cleanup=f.mount();t.after(cleanup);
  f.attempt(3,{name:'unreal_mcp_call_toolset'});
  assert.deepEqual(await f.recover(undefined,{step:3}),{kind:'retry'});
  f.attempt(4);
  assert.equal(await f.recover(undefined,{step:4}),undefined);
  assert.equal(f.events.filter(e=>e.type==='user/message').length,2);
  f.events.push({type:'turn/end',seq:f.events.length,data:{turn:1}});
  f.events.push({type:'turn/start',seq:f.events.length,data:{turn:2}});
  f.state.turn=2;f.attempt(1);f.events.at(-1).data.turn=2;
  assert.deepEqual(await f.recover(undefined,{turn:2,step:1}),{kind:'retry'});
});

test('provider recovery owns its retry and downstream errors propagate',async t=>{
  const f=fixture(t),action={kind:'retry'};
  assert.equal(await f.recover(async()=>action),action);assert.equal(f.events.length,2);
  await assert.rejects(f.recover(async()=>{throw Error('downstream failed');}),/downstream failed/);
  assert.equal(f.events.length,2);
});

test('only this exact provider failure and malformed UE tool JSON are eligible',async t=>{
  for(const options of [{tool:'pwsh'},{tool:'unreal_material_patch\nignore rules'},{args:'{}'}]){
    const f=fixture(t,options);assert.equal(await f.recover(),undefined);
  }
  const f=fixture(t);
  for(const wrong of [{...failure,code:'TRANSPORT'},{...failure,message:'DeepSeek Messages SSE contains invalid JSON'}])
    assert.equal(await f.recover(undefined,{failure:wrong}),undefined);
});

test('disabled, halted, exhausted and cancelled turns cannot be restarted',async t=>{
  for(const update of [{active:false},{halted:true},{budgetExhausted:true},{summaryOnly:true},{remaining:{timeMs:0}},{turn:2}]){
    const f=fixture(t);Object.assign(f.state,update);assert.equal(await f.recover(),undefined);
  }
  const disabled=fixture(t,{limit:0});assert.equal(await disabled.recover(),undefined);
  const aborted=fixture(t);aborted.controller.abort();assert.equal(await aborted.recover(),undefined);
  const duringNext=fixture(t);
  assert.equal(await duringNext.recover(async()=>{duringNext.controller.abort();}),undefined);
  const disposed=fixture(t),callback=disposed.hooks.get('agent/request-error');disposed.dispose();
  assert.equal(await callback(disposed.payload,async()=>undefined),undefined);
});

test('a finished step, dispatched tool, committed response or closed turn prevents recovery',async t=>{
  for(const type of ['tool/call','assistant/message','step/end','turn/end']){
    const f=fixture(t);f.events.push({type,seq:2,data:{turn:1,step:2}});
    assert.equal(await f.recover(),undefined,type);
  }
  const f=fixture(t);
  assert.equal(await f.recover(undefined,{step:3}),undefined);
  f.events.shift();assert.equal(await f.recover(),undefined);
});
