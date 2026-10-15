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
test('conversation dock displays selection and binds only through its session callback',async()=>{
  let tree;const choices=[];const state={version:1,editorId:'ue1',connected:true,editors:[{editorId:'ue1',project:'EHV',engineVersion:'5.8',pid:9}],selection:[{path:'/Game/BP_Demo.BP_Demo'}]};
  await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>state,bind:async id=>{choices.push(id);return{...state,version:2,editorId:id,connected:!!id};}}));});
  assert.match(JSON.stringify(tree.toJSON()),/EHV/);assert.match(JSON.stringify(tree.toJSON()),/BP_Demo/);
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
