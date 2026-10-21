import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {SettingsPage, SettingsSection, registerSettingsClient} from '../src/settings-client.mjs';
import {DEFAULTS, FIELD_SPECS, SETTINGS_NAMESPACE, SETTINGS_SLOT_KEY} from '../src/settings-spec.mjs';

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

test('time inputs allow decimal human units and save integer milliseconds without fractional native steps', async t => {
  const calls=[];
  const ui=await mount(t,snapshot(),async(...args)=>{calls.push(args);return true;});
  for (const field of FIELD_SPECS.filter(field=>field.type==='number')) {
    const input=ui.tree.root.findByProps({name:field.key});
    assert.equal(input.props.step, field.scale===1 ? 1 : 'any', field.key);
    assert.equal(input.props['aria-invalid'],false,field.key);
  }
  const times=FIELD_SPECS.filter(field=>field.scale>1);
  for (const field of times) {
    await ui.change(field.key,'1.23456789');
    assert.equal(ui.tree.root.findByProps({name:field.key}).props['aria-invalid'],false,field.key);
  }
  await ui.submit();
  assert.deepEqual(calls,[[times.map(field=>({op:'set',path:[field.key],value:Math.round(1.23456789*field.scale)})),7]]);
});

test('settings register both official entries without depending on the editor remote', async t => {
  const entries=[],slotNames=[],namespaces=[];
  const configForm={},describe={},Cache=()=>null;
  let rowDisposed=0,sectionDisposed=0;
  const slots={
    inject(name,callback){slotNames.push(name);callback();return()=>{rowDisposed++;};},
    register(options,view){entries.push({options,view});},
  };
  const child={slots,configForms:{get(ns){namespaces.push(ns);return configForm;},describe(){return describe;}}};
  const dispose=registerSettingsClient({
    slots,
    get remote(){throw new Error('settings registration must not read the editor remote');},
    inject(names,callback){assert.deepEqual(names,['configForms']);callback(child);return{dispose(){sectionDisposed++;}};},
  },{renderCache:Cache});
  assert.deepEqual(slotNames,['plugins.row.config','settings.section']);
  assert.deepEqual(namespaces,[SETTINGS_NAMESPACE]);
  assert.equal(entries[0].options.key,SETTINGS_SLOT_KEY);
  assert.equal(entries[0].view,SettingsPage);
  assert.equal(entries[1].options.id,SETTINGS_NAMESPACE);
  assert.equal(entries[1].options.label(),'Unreal Bridge');
  assert.equal(entries[1].view,SettingsSection);
  assert.deepEqual(entries[1].options.inject(),{configForm,describe,renderCache:Cache});
  await dispose();
  assert.equal(rowDisposed,1);assert.equal(sectionDisposed,1);
  let tree; await act(async()=>{tree=Renderer.create(h(SettingsPage,{view:'summary'}));});
  assert.match(text(tree),/修复次数/);
  await act(async()=>tree.unmount());
});

function observable(value){
  return {
    value,listeners:new Set(),
    getSnapshot(){return this.value;},
    subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);},
    publish(next){this.value=next;for(const listener of this.listeners)listener();},
  };
}

test('global Settings subscribes to the shared form, saves with its revision and releases subscriptions', async t => {
  const configForm=observable(snapshot()),describe=observable({status:'ready',error:null}),calls=[];
  configForm.mutate=async function(ops,revision){
    assert.equal(this,configForm);calls.push({ops,revision});
    this.publish(snapshot({revision:8,value:{...this.value.value,guardMaxRepairAttempts:5}}));
    return true;
  };
  describe.load=async()=>{};
  let tree;await act(async()=>{tree=Renderer.create(h(SettingsSection,{configForm,describe}));});
  t.after(async()=>{await act(async()=>tree.unmount());});
  assert.match(text(tree),/Unreal Bridge/);
  assert.equal(configForm.listeners.size,1);assert.equal(describe.listeners.size,1);
  await act(async()=>tree.root.findByProps({name:'guardMaxRepairAttempts'}).props.onChange({target:{value:'5'}}));
  await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(calls,[{ops:[{op:'set',path:['guardMaxRepairAttempts'],value:5}],revision:7}]);
  assert.match(text(tree),/设置已保存/);
  assert.equal(tree.root.findByProps({name:'guardMaxRepairAttempts'}).props.value,5);
  await act(async()=>configForm.publish(snapshot({revision:9,value:{...DEFAULTS,guardMaxErrors:61}})));
  assert.equal(tree.root.findByProps({name:'guardMaxErrors'}).props.value,61);
  await act(async()=>tree.unmount());
  assert.equal(configForm.listeners.size,0);assert.equal(describe.listeners.size,0);
});

test('global Settings exposes loading, unavailable and read failures and can recover through the shared describe mirror', async t => {
  const configForm=observable(snapshot({status:'loading',value:undefined})),describe=observable({status:'loading',view:undefined,error:null});
  configForm.mutate=async()=>{throw new Error('unavailable settings cannot save');};
  let attempts=0;
  describe.load=async function(){
    assert.equal(this,describe);attempts++;
    if(attempts===1)throw new Error('retry transport failed');
    this.publish({status:'ready',view:{namespaces:[]},error:null});
    configForm.publish(snapshot({status:'unavailable',value:undefined}));
  };
  let tree;await act(async()=>{tree=Renderer.create(h(SettingsSection,{configForm,describe}));});
  t.after(async()=>{await act(async()=>tree.unmount());});
  assert.match(text(tree),/正在读取/);
  await act(async()=>describe.publish({status:'idle',view:undefined,error:'host offline'}));
  assert.match(text(tree),/读取设置失败：host offline/);
  assert.doesNotMatch(text(tree),/正在读取插件设置/);
  assert.equal(tree.root.findAllByType('form').length,0);
  await act(async()=>button(tree,'重新读取').props.onClick());
  assert.match(text(tree),/retry transport failed/);
  await act(async()=>button(tree,'重新读取').props.onClick());
  assert.match(text(tree),/暂不可用/);
  assert.equal(tree.root.findAllByProps({role:'alert'}).length,0);
  await act(async()=>configForm.publish(snapshot({writable:false})));
  assert.equal(button(tree,'保存设置').props.disabled,true);
  assert.match(text(tree),/当前配置不可写/);
});

test('global Settings keeps a dirty draft through read errors and rejected writes', async t => {
  const configForm=observable(snapshot()),describe=observable({status:'ready',error:null});
  configForm.mutate=async()=>{throw new Error('write transport failed');};
  describe.load=async()=>{};
  let tree;await act(async()=>{tree=Renderer.create(h(SettingsSection,{configForm,describe}));});
  t.after(async()=>{await act(async()=>tree.unmount());});
  await act(async()=>tree.root.findByProps({name:'guardMaxSteps'}).props.onChange({target:{value:'99'}}));
  await act(async()=>describe.publish({status:'ready',error:'refresh failed'}));
  assert.match(text(tree),/读取设置失败：refresh failed/);
  assert.equal(tree.root.findByProps({name:'guardMaxSteps'}).props.value,99);
  await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.match(text(tree),/保存失败，草稿已保留：write transport failed/);
  assert.equal(tree.root.findByProps({name:'guardMaxSteps'}).props.value,99);
  assert.doesNotMatch(text(tree),/设置已保存/);
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
