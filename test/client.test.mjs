import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {UnrealDock,apply} from '../src/client.mjs';
test('client mounts the callable Remote namespace before registering the dock',async()=>{
  let definition;const calls=[];
  const ctx={remote:{$mount:async contribution=>{assert.equal(contribution.package,'dsh-unreal-bridge');await Promise.resolve();ctx.remote.unrealBridge={state:async s=>({ok:true,value:{sessionId:s}}),bind:async(s,id)=>{calls.push([s,id]);return{ok:true,value:{sessionId:s}};}};}},sessions:{using:async(s,_options,fn)=>fn({binding:{session:{getSnapshot:()=>({openState:'open'})}}})},slots:{inject:(_name,fn)=>fn(),register:d=>{if(d.name==='conversation.input.dock'){assert.ok(ctx.remote.unrealBridge);definition=d;}}}};
  ctx.inject=(keys,fn)=>{if(keys[0]==='configForms')return;assert.deepEqual(keys,['remote.unrealBridge']);assert.ok(ctx.remote.unrealBridge);fn(ctx);};
  await apply(ctx);const ui=definition.inject('conversation-a');assert.deepEqual(await ui.read(),{sessionId:'conversation-a'});await ui.bind('editor-b');assert.deepEqual(calls,[['conversation-a','editor-b']]);
  ctx.remote.unrealBridge.state=async()=>({ok:false,error:{code:'DISCONNECTED',message:'The editor disconnected'}});await assert.rejects(ui.read(),/editor disconnected/);
});

test('settings register while the bridge namespace is unavailable, independently of conversation controls',async()=>{
  const slots=[],injections=[];
  const ctx={remote:{$mount:async()=>{}},slots:{inject:(_name,fn)=>fn(),register:entry=>slots.push(entry)},inject:(keys)=>injections.push(keys)};
  await apply(ctx);
  assert.ok(slots.some(entry=>entry.name==='plugins.row.config'));
  assert.ok(injections.some(keys=>keys[0]==='configForms'));
  assert.ok(injections.some(keys=>keys[0]==='remote.unrealBridge'));
  assert.ok(!slots.some(entry=>entry.name==='conversation.input.dock'));
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

test('dock identifies PIE worlds and network instances and reports paused simulation',async()=>{
  const runtime={playSessionId:'play-a',worldId:'world-client-2',objectId:'actor-8',pieInstance:2,netMode:'client',status:'paused'};
  const actor={kind:'actor',path:'/Game/UEDPIE_2_Map.Map:PersistentLevel.Car_1',label:'运行车辆',worldPath:'/Game/UEDPIE_2_Map.Map',runtime};
  const state={version:1,editorId:'ue1',connected:true,editors:[],selection:[actor],runtime:{playSessionId:'play-a',status:'paused',isSimulating:true},runtimeSnapshots:[]};
  let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>state,bind:async()=>state}));});
  let content=JSON.stringify(tree.toJSON());
  assert.ok(content.includes('PIE 已暂停'));assert.ok(content.includes('模拟运行（SIE）'));assert.ok(content.includes('1 个运行 Actor'));
  await act(async()=>tree.root.findByType('button').props.onClick());
  content=JSON.stringify(tree.toJSON());
  assert.ok(content.includes('运行 Actor · 运行车辆'));assert.ok(content.includes('PIE 实例 2 · 客户端 · 已暂停'));assert.ok(content.includes('世界：/Game/UEDPIE_2_Map.Map'));
  await act(async()=>tree.unmount());
});

test('dock reports running and ended PIE without relabeling ordinary editor selection',async()=>{
  for(const [status,expected] of [['running','PIE 运行中'],['stopped','PIE 未开始 / 已结束']]){
    const state={version:1,editorId:'ue1',connected:true,editors:[],selection:[{kind:'actor',path:'/Game/Map.Map:PersistentLevel.Car_1',label:'编辑器车辆'}],runtime:{playSessionId:status==='stopped'?null:'play-a',status,isSimulating:false}};
    let tree;
    await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>state,bind:async()=>state}));});
    const content=JSON.stringify(tree.toJSON());assert.ok(content.includes(expected));assert.ok(content.includes('1 个Actor'));assert.equal(content.includes('1 个运行 Actor'),false);
    await act(async()=>tree.unmount());
  }
});

test('dock keeps destroyed, ended and offline captures visibly historical, with capture time and a bounded list',async()=>{
  const target={playSessionId:'old-play',worldId:'old-world',objectId:'old-actor',pieInstance:0,netMode:'standalone',status:'running'};
  const base={editorId:'ue1',project:'EHV',target,path:'/Game/Map.Map:PersistentLevel.Enemy_1',capturedAt:'2026-10-17T04:05:06.000Z',sampledFrame:123};
  const captures=[
    ...Array.from({length:20},(_,index)=>({...base,snapshotId:`extra-${index}`,label:`额外快照${index}`,status:'available'})),
    {...base,snapshotId:'d',label:'回收前现场',status:'expired',reason:'tracking_evicted'},
    {...base,snapshotId:'a',label:'销毁前现场',status:'expired',reason:'actor_destroyed'},
    {...base,snapshotId:'b',label:'结束前现场',status:'expired',reason:'pie_ended'},
    {...base,snapshotId:'c',label:'断线前现场',status:'disconnected'}
  ];
  const state={version:1,editorId:'ue1',connected:false,editors:[],selection:[],runtime:null,runtimeSnapshots:captures};
  let tree;
  await act(async()=>{tree=Renderer.create(React.createElement(UnrealDock,{read:async()=>state,bind:async()=>state}));});
  const content=JSON.stringify(tree.toJSON());
  assert.ok(content.includes('PIE 状态未知 · 编辑器已离线'));assert.ok(content.includes('运行历史快照'));assert.ok(content.includes('不随运行自动更新'));
  assert.ok(content.includes('Actor 已销毁'));assert.ok(content.includes('本次 PIE 已结束'));assert.ok(content.includes('编辑器已离线'));assert.ok(content.includes('跟踪句柄已回收'));assert.ok(content.includes('销毁前现场'));assert.ok(content.includes('帧 123'));
  const list=tree.root.findByProps({'aria-label':'最近采集的运行快照'});assert.equal(list.findAllByType('li').length,20);assert.equal(list.props.style.overflowY,'auto');
  assert.equal(tree.root.findAllByType('time')[0].props.dateTime,base.capturedAt);assert.equal(content.includes('额外快照0'),false);assert.ok(content.includes('额外快照19'));
  assert.equal(list.findAllByType('li')[0].findAllByType('div')[0].children[0],'断线前现场');
  assert.equal(tree.root.findAllByType('button').length,0);
  await act(async()=>tree.unmount());
});
