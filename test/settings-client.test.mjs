import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {SettingsPage, registerSettingsClient} from '../src/settings-client.mjs';
import {DEFAULTS, SETTINGS_SLOT_KEY} from '../src/settings-spec.mjs';

const h = React.createElement;
const snapshot = (overrides={}) => ({status:'ready', value:{...DEFAULTS,requireApproval:false}, base:{...DEFAULTS,requireApproval:false}, revision:7, writable:true, ...overrides});
const button = (tree,label) => tree.root.findAllByType('button').find(node=>node.children.includes(label));
const text = tree => JSON.stringify(tree.toJSON());
async function mount(t, state=snapshot(), mutate=async()=>true, renderCache) {
  let tree;
  const update = async(next=state) => {state=next; await act(async()=>tree.update(h(SettingsPage,{form:{state,mutate},renderCache})));};
  await act(async()=>{tree=Renderer.create(h(SettingsPage,{form:{state,mutate},renderCache}));});
  t.after(async()=>{await act(async()=>tree.unmount());});
  const change = async(name,value) => {await act(async()=>tree.root.findByProps({name}).props.onChange({target:{value:String(value),checked:value}}));};
  const submit = async() => {await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}));};
  return {tree,update,change,submit};
}

test('settings register at the official plugin-row key and render summaries without a form', async t => {
  let entry, component, injected;
  registerSettingsClient({slots:{inject(name,callback){injected=name;callback();},register(options,view){entry=options;component=view;}}});
  assert.equal(injected,'plugins.row.config');
  assert.equal(entry.key,SETTINGS_SLOT_KEY);
  assert.equal(component,SettingsPage);
  let tree; await act(async()=>{tree=Renderer.create(h(SettingsPage,{view:'summary'}));});
  assert.match(text(tree),/修复次数/);
  await act(async()=>tree.unmount());
});

test('editing and cancellation are local; saving sends one revision-fenced mutation', async t => {
  const calls=[];
  const ui=await mount(t,snapshot(),async(...args)=>{calls.push(args);return true;});
  await ui.change('guardMaxRepairAttempts',5);
  assert.equal(calls.length,0);
  await act(async()=>button(ui.tree,'取消草稿').props.onClick());
  assert.equal(ui.tree.root.findByProps({name:'guardMaxRepairAttempts'}).props.value,3);
  await ui.change('guardMaxRepairAttempts',0);
  await ui.change('knowledgeTimeoutMs',90);
  await ui.submit();
  assert.deepEqual(calls,[[[
    {op:'set',path:['guardMaxRepairAttempts'],value:0},
    {op:'set',path:['knowledgeTimeoutMs'],value:90000},
  ],7]]);
  assert.match(text(ui.tree),/设置已保存/);
  assert.match(text(ui.tree),/下一轮任务/);
});

test('restore defaults remains a draft and uses inherited values when saved', async t => {
  const calls=[];
  const ui=await mount(t,snapshot({value:{...DEFAULTS,guardMaxRepairAttempts:8}}),async(...args)=>{calls.push(args);return true;});
  await act(async()=>button(ui.tree,'恢复默认').props.onClick());
  assert.equal(calls.length,0);
  assert.equal(ui.tree.root.findByProps({name:'requireApproval'}).props.checked,false);
  assert.equal(ui.tree.root.findByProps({name:'guardMaxRepairAttempts'}).props.value,3);
  await ui.change('guardMaxErrors',9);
  await ui.submit();
  assert.ok(calls[0][0].some(op=>op.op==='unset'&&op.path[0]==='requireApproval'));
  assert.ok(calls[0][0].some(op=>op.op==='set'&&op.path[0]==='guardMaxErrors'&&op.value===9));
  assert.ok(calls[0][0].every(op=>!['port','stateDir','allowMcpDesktopInput'].includes(op.path[0])));
});

test('external revision changes preserve drafts and refuse stale saves until cancellation', async t => {
  const calls=[];
  const ui=await mount(t,snapshot(),async(...args)=>{calls.push(args);return true;});
  await ui.change('guardMaxErrors',19);
  await ui.update(snapshot({revision:8,value:{...DEFAULTS,guardMaxErrors:11}}));
  assert.equal(ui.tree.root.findByProps({name:'guardMaxErrors'}).props.value,19);
  assert.equal(button(ui.tree,'保存设置').props.disabled,true);
  assert.match(text(ui.tree),/其他窗口更新/);
  await ui.submit(); assert.equal(calls.length,0);
  await act(async()=>button(ui.tree,'取消草稿').props.onClick());
  assert.equal(ui.tree.root.findByProps({name:'guardMaxErrors'}).props.value,11);
  await ui.change('guardMaxErrors',12); await ui.submit();
  assert.equal(calls[0][1],8);
});

test('host refusal and transport failures preserve a draft and never claim successful persistence', async t => {
  for(const fail of [async()=>false,async()=>{throw new Error('transport failed');}]) {
    const ui=await mount(t,snapshot(),fail);
    await ui.change('guardMaxSteps',99); await ui.submit();
    assert.equal(ui.tree.root.findByProps({name:'guardMaxSteps'}).props.value,99);
    assert.match(text(ui.tree),/草稿已保留/);
    assert.doesNotMatch(text(ui.tree),/设置已保存/);
  }
});

test('invalid drafts, read-only forms and absent host state cannot save; cache extension is independent', async t => {
  const ui=await mount(t,snapshot(),async()=>{throw new Error('must not save');},()=>h('aside',null,'缓存扩展'));
  assert.match(text(ui.tree),/缓存扩展/);
  await ui.change('guardMaxRepeatedErrors',0);
  assert.equal(button(ui.tree,'保存设置').props.disabled,true);
  await ui.update(snapshot({writable:false}));
  assert.equal(ui.tree.root.findByProps({name:'allowWrites'}).props.disabled,true);
  assert.equal(button(ui.tree,'恢复默认').props.disabled,true);
  await ui.update(snapshot({status:'loading',value:undefined}));
  assert.match(text(ui.tree),/正在读取/);
  await ui.update(snapshot({status:'unavailable'}));
  assert.match(text(ui.tree),/暂不可用/);
});
