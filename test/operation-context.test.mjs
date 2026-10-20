import test from 'node:test';
import assert from 'node:assert/strict';
import {operationContext} from '../src/operation-context.mjs';
import {RepairTracker,REPAIR_LIMIT_DEFAULTS} from '../src/repair-tracker.mjs';

const BLUEPRINT='editor_toolset.toolsets.blueprint.BlueprintTools';
const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
const OBJECT='editor_toolset.toolsets.object.ObjectTools';
const bridge=()=>({sessions:new Map([['chat','UE']]),config:{allowWrites:true},writeLocks:new Map(),uncertain:new Map(),editorWrites:new Map(),previewRecord:(_session,id)=>{if(id==='valid')return {params:{assetPath:'/Game/BP_Test'}};throw new Error('expired');}});
const context=(name,args,b=bridge())=>operationContext(b,'chat',name,args);
const call=(toolsetName,toolName,args,name='unreal_mcp_call_toolset')=>context(name,name==='unreal_mcp_call_toolset'?{toolsetName,toolName,arguments:args}:{name:'call_tool',arguments:{toolset_name:toolsetName,tool_name:toolName,arguments:args}});
const identity=operation=>[operation.editorId,operation.target,operation.family];

test('native preview/apply and MCP graph/node calls share the same Blueprint identity',()=>{
  const preview=context('unreal_preview_patch',{assetPath:'/Game/BP_Test'});
  const apply=context('unreal_apply',{previewId:'valid'});
  for(const value of [
    apply,
    call(BLUEPRINT,'create_node',{blueprint:{refPath:'/Game/BP_Test.BP_Test'},graph:{refPath:'/Game/BP_Test.BP_Test:EventGraph'}}),
    call(BLUEPRINT,'set_node_property',{node:{refPath:'/Game/BP_Test.BP_Test:EventGraph.K2Node_A'}}),
    call(BLUEPRINT,'set_node_property',{node:{refPath:'/game/bp_test.bp_test:EventGraph.K2Node_B'}}),
  ])assert.deepEqual(identity(value),identity(preview));
});

test('dispatch wrappers and qualified leaf aliases cannot create new problem families',()=>{
  const short=call(BLUEPRINT,'create_node',{graph:{refPath:'/Game/BP_Test.BP_Test:EventGraph'}});
  for(const value of [
    call(BLUEPRINT,`${BLUEPRINT}.create_node`,{graph:{refPath:'/Game/BP_Test.BP_Test:EventGraph'}}),
    call(BLUEPRINT,`${BLUEPRINT}.create_node`,{graph:{refPath:'/Game/BP_Test.BP_Test:EventGraph'}},'unreal_mcp_call'),
    context('unreal_mcp_call',{name:`${BLUEPRINT}.create_node`,arguments:{graph:{refPath:'/Game/BP_Test.BP_Test:EventGraph'}}}),
  ])assert.deepEqual(identity(value),identity(short));
});

test('DataTable and save package/object aliases are canonical',()=>{
  const native=context('unreal_data_table_copy_property',{assetPath:'/Game/Table'});
  assert.deepEqual(identity(native),identity(call(DATA_TABLE,'set_row_property',{data_table:{refPath:'/Game/Table.Table'}})));
  assert.deepEqual(identity(context('unreal_save',{assetPath:'/Game/BP_Test'})),identity(context('unreal_save',{assetPath:'/Game/BP_Test.BP_Test'})));
});

test('diagnostics require an exact known toolset and cannot clear setter repair usage',()=>{
  const read=call(OBJECT,'get_properties',{object:{refPath:'/Game/BP_Test.BP_Test:Part'}});
  const write=call(OBJECT,'set_properties',{object:{refPath:'/Game/BP_Test.BP_Test:Part'}});
  assert.equal(read.kind,'read');assert.equal(write.kind,'write');assert.deepEqual(identity(read),identity(write));
  const repairs=new RepairTracker(REPAIR_LIMIT_DEFAULTS);
  repairs.complete(repairs.admit(write),{code:'MCP_TOOL_ERROR',message:'Invalid property'});
  repairs.complete(repairs.admit(read),null);
  repairs.complete(repairs.admit(write),{code:'MCP_TOOL_ERROR',message:'Invalid property'});
  assert.equal(repairs.status().issues[0].blockedBy,'repeated_errors');
  assert.equal(call('fake.toolsets.object.ObjectTools','get_properties',{object:{refPath:'/Game/BP_Test'}}).kind,'write');
  assert.equal(call(OBJECT,'get_and_modify',{object:{refPath:'/Game/BP_Test'}}).kind,'write');
});

test('unknown tool names, invalid reference IDs and expired previews use stable fallbacks',()=>{
  for(const suffix of ['a','b']){
    const unknown=context('unreal_mcp_call',{name:`Unknown${suffix}`,arguments:{requestId:suffix,object:{refPath:suffix}}});
    assert.equal(unknown.target,'editor_scope');assert.equal(unknown.family,'mcp_edit');
    const invalid=call(BLUEPRINT,'create_node',{graph:{refPath:suffix},problemId:suffix,requestId:suffix});
    assert.equal(invalid.target,'editor_scope');assert.equal(invalid.family,'blueprint_edit');
    assert.equal(context('unreal_apply',{previewId:suffix}).target,'editor_scope');
  }
  assert.equal(call(BLUEPRINT,'create_node',{graph:{refPath:'/Game/../Other'}}).target,'editor_scope');
  assert.doesNotThrow(()=>context('unreal_mcp_call_toolset',{toolName:null,arguments:null}));
});

test('different real objects remain independent and ambiguous owners do not trust a chosen argument',()=>{
  const one=call(OBJECT,'set_properties',{object:{refPath:'/Game/Map.Map:PersistentLevel.ActorA'}});
  const two=call(OBJECT,'set_properties',{object:{refPath:'/Game/Map.Map:PersistentLevel.ActorB'}});
  assert.notEqual(one.target,two.target);
  const ambiguous=call(BLUEPRINT,'create_node',{blueprint:{refPath:'/Game/One.One'},graph:{refPath:'/Game/Two.Two:EventGraph'}});
  assert.equal(ambiguous.target,'editor_scope');
});

test('host barriers take precedence and never depend on caller read-only claims',()=>{
  const b=bridge();
  for(const block of [
    ()=>{b.config.allowWrites=false;},
    ()=>{b.config.allowWrites=true;b.writeLocks.set('UE',{});},
    ()=>{b.writeLocks.clear();b.uncertain.set('chat',{});},
    ()=>{b.uncertain.clear();b.editorWrites.set('UE',{});},
  ]){
    block();assert.equal(context('unreal_preview_patch',{assetPath:'/Game/BP_Test',blocked:false},b).blocked,true);
  }
  b.sessions.clear();assert.equal(context('unreal_apply',{previewId:'valid'},b),null);
});
