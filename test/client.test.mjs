import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {UnrealDock,apply} from '../src/client.mjs';
test('client mounts the callable Remote namespace before registering the dock',async()=>{
  let definition;const calls=[];
  const ctx={remote:{$mount:async contribution=>{assert.equal(contribution.package,'dsh-unreal-bridge');await Promise.resolve();ctx.remote.unrealBridge={state:async s=>({ok:true,value:{sessionId:s}}),bind:async(s,id)=>{calls.push([s,id]);return{ok:true,value:{sessionId:s}};}};}},sessions:{using:async(s,_options,fn)=>fn({binding:{session:{getSnapshot:()=>({openState:'open'})}}})},slots:{inject:(_name,fn)=>fn(),register:d=>{assert.ok(ctx.remote.unrealBridge);definition=d;}}};
  ctx.inject=(keys,fn)=>{assert.deepEqual(keys,['remote.unrealBridge']);assert.ok(ctx.remote.unrealBridge);fn(ctx);};
  await apply(ctx);const ui=definition.inject('conversation-a');assert.deepEqual(await ui.read(),{sessionId:'conversation-a'});await ui.bind('editor-b');assert.deepEqual(calls,[['conversation-a','editor-b']]);
  ctx.remote.unrealBridge.state=async()=>({ok:false,error:{code:'DISCONNECTED',message:'The editor disconnected'}});await assert.rejects(ui.read(),/editor disconnected/);
});
test('conversation dock keeps assets collapsed, reveals a scrollable list, and binds through its session callback',async()=>{
  let tree;const choices=[];const state={version:1,editorId:'ue1',connected:true,editors:[{editorId:'ue1',project:'EHV',engineVersion:'5.8',pid:9}],selection:[{path:'/Game/BP_Demo.BP_Demo'}]};
  await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>state,bind:async id=>{choices.push(id);return{...state,version:2,editorId:id,connected:!!id};}}));});
  assert.match(JSON.stringify(tree.toJSON()),/EHV/);
  assert.match(JSON.stringify(tree.toJSON()),/已选择 1 个资产/);
  assert.equal(JSON.stringify(tree.toJSON()).includes('BP_Demo'),false);
  const toggle=tree.root.findByType('button');
  assert.equal(toggle.props['aria-expanded'],false);
  await act(async()=>toggle.props.onClick());
  assert.equal(tree.root.findByType('button').props['aria-expanded'],true);
  assert.match(JSON.stringify(tree.toJSON()),/BP_Demo/);
  const list=tree.root.findByType('ul');
  assert.equal(list.props.style.overflowY,'auto');
  assert.equal(list.props.style.maxHeight,160);
  await act(async()=>tree.root.findByType('button').props.onClick());
  assert.equal(JSON.stringify(tree.toJSON()).includes('BP_Demo'),false);
  await act(async()=>{await tree.root.findByType('select').props.onChange({target:{value:''}});});assert.deepEqual(choices,[null]);
  await act(async()=>tree.unmount());
});
test('old conversation responses cannot leak into a newly selected conversation',async()=>{
  let oldResolve;const readOld=()=>new Promise(r=>{oldResolve=r;});const fresh={version:1,editorId:null,connected:false,editors:[],selection:[]};let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:readOld,bind:async()=>fresh}));});
  await act(async()=>{tree.update(React.createElement(UnrealDock,{read:async()=>fresh,bind:async()=>fresh}));});
  await act(async()=>{oldResolve({...fresh,selection:[{path:'/Game/PreviousConversationSecret'}]});});
  assert.equal(JSON.stringify(tree.toJSON()).includes('PreviousConversationSecret'),false);await act(async()=>tree.unmount());
});

test('dock identifies level actors and components by label and shows the component owner',async()=>{
  const actor={kind:'actor',path:'/Game/Map.Map:PersistentLevel.Car_1',name:'Car_1',label:'测试车辆'};
  const component={kind:'component',path:actor.path+'.Mesh',name:'Mesh',ownerPath:actor.path,ownerLabel:actor.label};
  const template={kind:'component',source:'blueprint_editor',path:'/Game/BP_Car.BP_Car_C:Mesh_GEN_VARIABLE',label:'Mesh',ownerLabel:'BP_Car'};
  for(const [item,summary,title] of [[actor,'1 个Actor','Actor · 测试车辆'],[component,'1 个组件','组件 · Mesh'],[template,'1 个蓝图组件','蓝图组件 · Mesh']]){
    let tree;
    await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>({version:1,connected:true,editors:[],selection:[item]}),bind:async()=>{}}));});
    assert.match(JSON.stringify(tree.toJSON()),new RegExp(summary));
    await act(async()=>tree.root.findByType('button').props.onClick());
    const content=JSON.stringify(tree.toJSON());assert.ok(content.includes(title));assert.ok(content.includes(item.path));
    if(item.kind==='component')assert.ok(content.includes(item.source==='blueprint_editor'?'所属蓝图：BP_Car':'所属 Actor：测试车辆'));
    await act(async()=>tree.unmount());
  }
});
