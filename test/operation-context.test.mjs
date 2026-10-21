import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operationContext,rememberMaterialRead,validateMcpOperationContext} from '../src/operation-context.mjs';
import {MATERIAL_TOOLSET,MATERIAL_READ_TOOLS,BLUEPRINT_READ_TOOLS,OBJECT_READ_TOOLS} from '../src/mcp-contract.mjs';
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

const materialPath='/Game/M_Test.M_Test';
const expressionPath=`${materialPath}:MaterialExpressionCustom_0`;
const materialArgs=(toolName,args)=>({toolsetName:MATERIAL_TOOLSET,toolName,arguments:args});
const materialCall=(toolName,args,b=bridge())=>context('unreal_mcp_call_toolset',materialArgs(toolName,args),b);
const expressionNode=(path=expressionPath)=>({id:'node-1',objectPath:path,ownerPath:materialPath,classPath:'/Script/Engine.MaterialExpressionCustom'});
const materialRead=(nodes=[expressionNode()],nodesComplete=true)=>({assetPath:materialPath,assetClass:'/Script/Engine.Material',nodesComplete,nodes});
const connectedBridge=()=>{const b=bridge();b.editors=new Map([['UE',{editorId:'UE'}]]);return b;};
const objectCall=(instance,b)=>context('unreal_mcp_call_toolset',{toolsetName:OBJECT,toolName:'set_properties',arguments:{instance:{refPath:instance},values:'{}'}},b);

test('material creation, expressions, output connections and native patches share one material identity',()=>{
  const expected=['UE',materialPath.toLowerCase(),'material_edit'];
  const args=materialArgs('connect_expressions',{from_expression:{refPath:expressionPath},to_expression:{refPath:`${materialPath}:Multiply_1`}});
  for(const operation of [
    context('unreal_mcp_call_toolset',args),
    context('unreal_mcp_call',{name:'call_tool',arguments:{toolset_name:args.toolsetName,tool_name:args.toolName,arguments:args.arguments}}),
    context('unreal_mcp_call',{name:`${MATERIAL_TOOLSET}.connect_expressions`,arguments:args.arguments}),
    materialCall('add_expression',{material_or_function:{refPath:'/Game/M_Test'}}),
    materialCall('connect_to_output',{expression:{refPath:expressionPath}}),
    materialCall('delete_expression',{material_or_function:{refPath:materialPath},expression:{refPath:expressionPath}}),
    materialCall('disconnect_from_output',{material:{refPath:materialPath}}),
    context('unreal_material_patch',{assetPath:'/Game/M_Test',dryRun:false}),
    context('unreal_material_read',{assetPath:materialPath}),
  ])assert.deepEqual(identity(operation),expected);
  assert.equal(context('unreal_material_patch',{assetPath:materialPath}).kind,'preview');
  assert.equal(context('unreal_material_patch',{assetPath:materialPath,dryRun:true}).kind,'preview');
  assert.equal(context('unreal_material_patch',{assetPath:materialPath,dryRun:false}).kind,'write');
  assert.equal(context('unreal_material_read',{assetPath:materialPath}).kind,'read');
  assert.equal(materialCall('connect_expressions',{from_expression:{refPath:expressionPath},to_expression:{refPath:'/Game/M_Other.M_Other:Node'}}).target,'editor_scope');
});

test('a blocked material connection blocks dependent node creation while audited reads and other materials remain usable',()=>{
  const repairs=new RepairTracker({...REPAIR_LIMIT_DEFAULTS,guardMaxRepairAttempts:0});
  const connection=materialCall('connect_expressions',{from_expression:{refPath:expressionPath},to_expression:{refPath:`${materialPath}:Multiply_1`}});
  repairs.complete(repairs.admit(connection),{code:'MCP_TOOL_ERROR',message:'No such output'});
  for(const operation of [
    materialCall('add_expression',{material_or_function:{refPath:materialPath}}),
    materialCall('connect_to_output',{expression:{refPath:expressionPath}}),
    context('unreal_material_patch',{assetPath:materialPath,dryRun:false}),
  ])assert.throws(()=>repairs.admit(operation),{code:'REPAIR_BUDGET_EXHAUSTED'});
  for(const fullName of MATERIAL_READ_TOOLS){
    const read=materialCall(fullName.slice(MATERIAL_TOOLSET.length+1),{material_or_function:{refPath:materialPath},expression:{refPath:expressionPath}});
    assert.equal(read.kind,'read');
    assert.equal(repairs.admit(read),null);
  }
  assert.equal(repairs.status().blockedCount,1);
  assert.ok(repairs.admit(materialCall('add_expression',{material_or_function:{refPath:'/Game/M_Other.M_Other'}})));
  assert.equal(materialCall('get_and_mutate',{material:{refPath:materialPath}}).kind,'write');
});

test('ObjectTools uses native material owner evidence but never caller-supplied class or path guesses',()=>{
  const b=connectedBridge();
  assert.equal(objectCall(expressionPath,b).family,'object_properties');
  const forged=context('unreal_mcp_call_toolset',{toolsetName:OBJECT,toolName:'set_properties',arguments:{instance:{refPath:expressionPath,classPath:'/Script/Engine.MaterialExpressionCustom',ownerPath:materialPath},values:'{}'}},b);
  assert.equal(forged.family,'object_properties');
  assert.equal(rememberMaterialRead(b,'chat',materialRead()),true);
  assert.deepEqual(identity(objectCall(expressionPath,b)),['UE',materialPath.toLowerCase(),'material_edit']);
  assert.deepEqual(identity(objectCall(materialPath,b)),['UE',materialPath.toLowerCase(),'material_edit']);
  assert.equal(objectCall(`${materialPath}:UnobservedNode`,b).family,'object_properties');
  const repairs=new RepairTracker({...REPAIR_LIMIT_DEFAULTS,guardMaxRepairAttempts:0});
  repairs.complete(repairs.admit(materialCall('connect_to_output',{expression:{refPath:expressionPath}},b)),{code:'MCP_TOOL_ERROR',message:'No such output'});
  assert.throws(()=>repairs.admit(objectCall(expressionPath,b)),{code:'REPAIR_BUDGET_EXHAUSTED'});
});

test('complete native reads replace ownership inventory and filtered reads update it without trusting malformed evidence',()=>{
  const b=connectedBridge(),second=`${materialPath}:Node2`;
  assert.equal(rememberMaterialRead(b,'chat',materialRead()),true);
  assert.equal(rememberMaterialRead(b,'chat',materialRead([expressionNode(second)],false)),true);
  assert.equal(objectCall(expressionPath,b).family,'material_edit');
  assert.equal(objectCall(second,b).family,'material_edit');
  for(const bad of [
    {...materialRead(),ok:false},
    {...materialRead(),assetClass:'/Script/Engine.Blueprint'},
    {...materialRead(),nodesComplete:undefined},
    materialRead([{...expressionNode(),ownerPath:'/Game/Other.Other'}]),
    materialRead([{...expressionNode(),objectPath:'/Game/Other.Other:Node'}]),
    materialRead([{...expressionNode(),classPath:'not-a-path'}]),
    materialRead([expressionNode(),expressionNode()]),
  ])assert.equal(rememberMaterialRead(b,'chat',bad),false);
  assert.equal(objectCall(expressionPath,b).family,'material_edit','invalid reads cannot erase a previous verified inventory');
  assert.equal(rememberMaterialRead(b,'chat',materialRead([expressionNode(second)])),true);
  assert.equal(objectCall(expressionPath,b).family,'object_properties');
  assert.equal(objectCall(second,b).family,'material_edit');
});

test('material owner evidence is isolated from rebindings and reconnects with the same editor ID',()=>{
  const b=connectedBridge();
  rememberMaterialRead(b,'chat',materialRead());
  const original=b.editors.get('UE');
  b.editors.set('UE',{editorId:'UE'});
  assert.equal(objectCall(expressionPath,b).family,'object_properties');
  b.editors.set('UE',original);
  b.editors.set('other',{editorId:'other'});
  b.sessions.set('chat','other');
  assert.equal(objectCall(expressionPath,b).family,'object_properties');
  b.sessions.delete('chat');
  assert.equal(rememberMaterialRead(b,'chat',materialRead()),false);
});

const blueprintPath='/Game/BP_Test.BP_Test';
const blueprintOwner=(path=blueprintPath,classPath='/Script/Engine.Blueprint')=>({path,classPath});
const preflight=(toolName,blueprintOwners=[blueprintOwner()])=>({verified:true,toolName,blueprintOwners,token:randomUUID()});
const nativeContext=(b,toolsetName,toolName,args,owners=[blueprintOwner()])=>operationContext(b,'chat','unreal_mcp_call_toolset',{
  toolsetName,toolName,arguments:args,
},{...preflight(`${toolsetName}.${toolName}`,owners),editor:b.editors.get(b.sessions.get('chat')),bindingVersion:b.bindingVersions?.get('chat')});
const pin=(node=`${blueprintPath}:EventGraph.K2Node_A`)=>({node:{refPath:node},index_id:0,direction:'EGPD_Output'});

test('native MCP ownership validates exact tool, bounded fields and unique Blueprint owners without guessing class ancestry',()=>{
  const name=`${BLUEPRINT}.connect_pins`,good=preflight(name);
  assert.deepEqual(validateMcpOperationContext(good,name),good);
  assert.equal(Object.isFrozen(validateMcpOperationContext(good,name).blueprintOwners[0]),true);
  assert.doesNotThrow(()=>validateMcpOperationContext(preflight(name,[blueprintOwner('/Game/Maps/L.L:PersistentLevel.ExactLevelScript','/Script/Engine.LevelScriptBlueprint')]),name));
  assert.doesNotThrow(()=>validateMcpOperationContext(preflight(name,[blueprintOwner(blueprintPath,'/Script/UMGEditor.WidgetBlueprint')]),name));
  assert.deepEqual(validateMcpOperationContext(preflight(name,[]),name).blueprintOwners,[]);
  for(const bad of [
    null,{...good,verified:false},{...good,token:'not-a-uuid'},{...good,token:undefined},{...good,toolName:`${BLUEPRINT}.create_node`},
    {...good,blueprintOwners:null},{...good,blueprintOwners:Array(1025).fill(blueprintOwner())},
    {...good,blueprintOwners:[blueprintOwner(),blueprintOwner(blueprintPath.toLowerCase())]},
    {...good,blueprintOwners:[blueprintOwner('/Game/../Different.Different')]},
    {...good,blueprintOwners:[blueprintOwner('/Game/BP_Test')]},
    {...good,blueprintOwners:[blueprintOwner(blueprintPath,'Blueprint')]},
  ])assert.throws(()=>validateMcpOperationContext(bad,name),{code:'MCP_OPERATION_CONTEXT_INVALID'});
});

test('a native Blueprint pin failure blocks additions, other subgraphs, property writes and native apply for the same Blueprint',()=>{
  const b=connectedBridge(),expected=['UE',blueprintPath.toLowerCase(),'blueprint_edit'];
  const connection=nativeContext(b,BLUEPRINT,'connect_pins',{output_pin:pin(),input_pin:{...pin(`${blueprintPath}:EventGraph.K2Node_B`),direction:'EGPD_Input'}});
  assert.deepEqual(identity(connection),expected);
  const repairs=new RepairTracker({...REPAIR_LIMIT_DEFAULTS,guardMaxRepairAttempts:0});
  repairs.complete(repairs.admit(connection),{code:'MCP_TOOL_ERROR',message:'Invalid pin connection'});
  for(const operation of [
    nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${blueprintPath}:EventGraph`}}),
    nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${blueprintPath}:OtherFunction`}}),
    nativeContext(b,BLUEPRINT,'set_pin_value',{pin:pin(),value:'2'}),
    nativeContext(b,BLUEPRINT,'set_node_position',{node:pin().node,pos:{x:0,y:0}}),
    nativeContext(b,OBJECT,'set_properties',{instance:pin().node,values:'{}'}),
    nativeContext(b,OBJECT,'reset_properties',{instance:pin(`${blueprintPath}:OtherFunction.K2Node_C`).node,properties:['node_comment']}),
    context('unreal_preview_patch',{assetPath:blueprintPath},b),
    context('unreal_apply',{previewId:'valid'},b),
  ]){
    assert.deepEqual(identity(operation),expected);
    assert.throws(()=>repairs.admit(operation),{code:'REPAIR_BUDGET_EXHAUSTED'});
  }
  assert.equal(repairs.admit(nativeContext(b,BLUEPRINT,'get_node_infos',{nodes:[pin().node]})),null);
  const independent='/Game/BP_Other.BP_Other';
  assert.ok(repairs.admit(nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${independent}:EventGraph`}},[blueprintOwner(independent)])));
});

test('native LevelScriptBlueprint ownership preserves its complete identity and separates owners inside one World',()=>{
  const b=connectedBridge(),level='/Game/Maps/L.L:PersistentLevel.ExactLevelScript';
  const owners=[blueprintOwner(level,'/Script/Engine.LevelScriptBlueprint')];
  const node={refPath:`${level}.EventGraph.K2Node_A`};
  const create=nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${level}.EventGraph`}},owners);
  const properties=nativeContext(b,OBJECT,'set_properties',{instance:node,values:'{}'},owners);
  assert.deepEqual(identity(create),['UE',level.toLowerCase(),'blueprint_edit']);
  assert.deepEqual(identity(properties),identity(create));
  assert.notEqual(create.target,'/game/maps/l.l');
  const other='/Game/Maps/L.L:OtherLevel.AnotherLevelScript';
  assert.notEqual(create.target,nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${other}.EventGraph`}},[blueprintOwner(other,'/Script/Engine.LevelScriptBlueprint')]).target);
});

test('native owner evidence is accepted through all supported dispatch wrappers and cannot come from caller metadata',()=>{
  const b=connectedBridge(),name=`${BLUEPRINT}.connect_pins`,args={output_pin:pin(),input_pin:pin()};
  const evidence={...preflight(name),editor:b.editors.get('UE'),bindingVersion:undefined};
  for(const wrapped of [
    {name,arguments:args},
    {name:'call_tool',arguments:{tool_name:name,arguments:args}},
    {name:'call_tool',arguments:{toolset_name:BLUEPRINT,tool_name:name,arguments:args}},
    {name:'call_tool',arguments:{toolset_name:BLUEPRINT,tool_name:'connect_pins',arguments:args}},
  ])assert.deepEqual(identity(operationContext(b,'chat','unreal_mcp_call',wrapped,evidence)),['UE',blueprintPath.toLowerCase(),'blueprint_edit']);
  const instance={...pin().node,classPath:'/Script/BlueprintGraph.K2Node',ownerPath:blueprintPath};
  const forged=context('unreal_mcp_call_toolset',{toolsetName:OBJECT,toolName:'set_properties',arguments:{instance,values:'{}',nativeEvidence:evidence}},b);
  assert.equal(forged.family,'object_properties');
  assert.equal(nativeContext(b,BLUEPRINT,'create_node',{graph:{refPath:`${blueprintPath}:EventGraph`}},[]).target,'editor_scope');
  const noOwner=nativeContext(b,OBJECT,'set_properties',{instance:pin().node,values:'{}'},[]);
  assert.equal(noOwner.family,'object_properties');
});

test('fresh native Blueprint evidence rejects replaced editor connections and changed binding versions',()=>{
  const b=connectedBridge();b.bindingVersions=new Map([['chat',1]]);
  const name=`${BLUEPRINT}.create_node`,args={name,arguments:{graph:{refPath:`${blueprintPath}:EventGraph`}}};
  const evidence={...preflight(name),editor:b.editors.get('UE'),bindingVersion:1};
  b.bindingVersions.set('chat',2);
  assert.throws(()=>operationContext(b,'chat','unreal_mcp_call',args,evidence),{code:'INSTANCE_CHANGED'});
  b.bindingVersions.set('chat',1);b.editors.set('UE',{editorId:'UE'});
  assert.throws(()=>operationContext(b,'chat','unreal_mcp_call',args,evidence),{code:'INSTANCE_CHANGED'});
  assert.throws(()=>operationContext(b,'chat','unreal_mcp_call',args,preflight(name)),{code:'INSTANCE_CHANGED'});
});

test('multiple verified owners are allowed for diagnostics but cannot split a modifying call across Blueprint repair budgets',()=>{
  const b=connectedBridge(),other='/Game/BP_Other.BP_Other',owners=[blueprintOwner(),blueprintOwner(other)];
  const nodes=[pin().node,pin(`${other}:EventGraph.K2Node_B`).node];
  const read=nativeContext(b,BLUEPRINT,'get_node_infos',{nodes},owners);
  assert.equal(read.kind,'read');assert.equal(read.target,'editor_scope');
  assert.throws(()=>nativeContext(b,BLUEPRINT,'arrange_nodes',{nodes},owners),{code:'MCP_TARGET_OWNER_MISMATCH'});
  assert.throws(()=>nativeContext(b,OBJECT,'set_properties',{instance:pin().node,values:'{}'},owners),{code:'MCP_TARGET_OWNER_MISMATCH'});
});

test('nested PinID inputs have stable preflight-error fallback identities without becoming trusted ownership evidence',()=>{
  const expected=['UE',blueprintPath.toLowerCase(),'blueprint_edit'];
  for(const operation of [
    call(BLUEPRINT,'connect_pins',{output_pin:pin(),input_pin:pin()}),
    call(BLUEPRINT,'break_pins',{output_pin:pin(),input_pin:pin()}),
    call(BLUEPRINT,'set_pin_value',{pin:pin(),value:'1'}),
  ])assert.deepEqual(identity(operation),expected);
  assert.equal(call(BLUEPRINT,'connect_pins',{output_pin:pin(),input_pin:pin('/Game/Other.Other:Graph.Node')}).target,'editor_scope');
  assert.equal(call(BLUEPRINT,'set_pin_value',{pin:{node:{refPath:'not-an-object'}},value:'1'}).target,'editor_scope');
});

test('Blueprint and Object diagnostics use the exact audited read list, excluding unavailable and graph-mutating queries',()=>{
  const b=connectedBridge();
  for(const [toolset,names] of [[BLUEPRINT,BLUEPRINT_READ_TOOLS],[OBJECT,OBJECT_READ_TOOLS]]){
    for(const fullName of names){
      const name=fullName.slice(toolset.length+1);
      assert.equal(nativeContext(b,toolset,name,{instance:pin().node,nodes:[pin().node]}).kind,'read',fullName);
    }
  }
  for(const name of ['get_graphs','get_nodes','read_graph_dsl','get_node_type_pins'])
    assert.equal(nativeContext(b,BLUEPRINT,name,{graph:{refPath:`${blueprintPath}:EventGraph`}}).kind,'write',name);
  assert.equal(nativeContext(b,OBJECT,'get_metadata',{instance:pin().node}).kind,'write');
});
