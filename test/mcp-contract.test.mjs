import test from 'node:test';
import assert from 'node:assert/strict';
import {shortToolName,describeTools,validateMcpArguments,isReadOnlyMcpCall,mcpFailure,MATERIAL_TOOLSET,MATERIAL_READ_TOOLS} from '../src/mcp-contract.mjs';

const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
const description=tools=>({content:[{type:'text',text:JSON.stringify({tools})}]});
const schema={
  type:'object',required:['refPath','limit'],properties:{
    refPath:{$ref:'#/$defs/refPath'},limit:{type:'integer',minimum:1},
    enabled:{type:'boolean',default:true},
  },
  $defs:{refPath:{type:'object',required:['path'],properties:{path:{type:'string',minLength:1}},additionalProperties:false}},
};
const tool={name:'get_schema',inputSchema:schema};
function invalid(args,keyword){
  assert.throws(()=>validateMcpArguments(tool,args),error=>{
    assert.equal(error.code,'MCP_INVALID_ARGUMENTS');
    assert.equal(error.details.execution,'not_started');assert.equal(error.details.retryable,true);
    assert.equal(error.details.issues.some(issue=>issue.keyword===keyword),true);
    return true;
  });
}

test('tool names accept short or one matching full prefix and reject foreign or repeated prefixes',()=>{
  assert.equal(shortToolName(DATA_TABLE,'get_schema'),'get_schema');
  assert.equal(shortToolName(DATA_TABLE,`${DATA_TABLE}.get_schema`),'get_schema');
  for(const name of ['',`${DATA_TABLE}.${DATA_TABLE}.get_schema`,'ObjectTools.get_schema','some.module.get_schema','get_schema.extra']){
    assert.throws(()=>shortToolName(DATA_TABLE,name),error=>error.code==='MCP_INVALID_TOOL_NAME'&&error.details.execution==='not_started');
  }
});

test('discovery exposes stable short and full names while preserving exact schemas and annotations',()=>{
  const source={name:`${DATA_TABLE}.get_schema`,description:'Get a schema',inputSchema:schema,annotations:{readOnlyHint:true}};
  const result=describeTools(description([source]),DATA_TABLE);
  assert.deepEqual(result.description.tools[0],{...source,name:'get_schema',fullName:`${DATA_TABLE}.get_schema`,toolsetName:DATA_TABLE});
  assert.deepEqual(result.description.tools[0].inputSchema,schema);
  assert.throws(()=>describeTools(description([source,{...source,name:'get_schema'}]),DATA_TABLE),{code:'MCP_DESCRIPTION_UNPARSEABLE'});
  assert.throws(()=>describeTools(description([{...source,name:'OtherToolset.get_schema'}]),DATA_TABLE),{code:'MCP_INVALID_TOOL_NAME'});
  for(const result of [{content:[]},{content:[{type:'text',text:'not JSON'}]},description({}),description([{inputSchema:schema}])]){
    assert.throws(()=>describeTools(result,DATA_TABLE),{code:'MCP_DESCRIPTION_UNPARSEABLE'});
  }
});

test('current schemas validate required parameters, nested references, and exact primitive types',()=>{
  validateMcpArguments(tool,{refPath:{path:'/Game/Data'},limit:6});
  invalid({refPath:{path:'/Game/Data'}},'required');
  invalid({refPath:'/Game/Data',limit:6},'type');
  invalid({refPath:{},limit:6},'required');
  invalid({refPath:{path:42},limit:6},'type');
  invalid({refPath:{path:'/Game/Data'},limit:'6'},'type');
  invalid({refPath:{path:'/Game/Data'},limit:6,enabled:'true'},'type');
  invalid({refPath:{path:'/Game/Data',unexpected:true},limit:6},'additionalProperties');
});

test('reflected parameter names reject unknown arguments without changing an explicit additionalProperties contract',()=>{
  invalid({refPath:{path:'/Game/Data'},limit:6,data_table:'/Game/Data'},'additionalProperties');
  const open={name:'open',inputSchema:{type:'object',properties:{known:{type:'string'}},additionalProperties:true}};
  validateMcpArguments(open,{known:'x',extra:{kept:true}});
  const typed={name:'typed',inputSchema:{type:'object',properties:{known:{type:'string'}},additionalProperties:{type:'number'}}};
  validateMcpArguments(typed,{known:'x',extra:1});
  assert.throws(()=>validateMcpArguments(typed,{known:'x',extra:'1'}),{code:'MCP_INVALID_ARGUMENTS'});
  assert.equal('additionalProperties' in schema,false);
});

test('validation never coerces input values or inserts schema defaults',()=>{
  const args={refPath:{path:'/Game/Data'},limit:6},before=structuredClone(args);
  validateMcpArguments(tool,args);assert.deepEqual(args,before);assert.equal('enabled' in args,false);
  const bad={...args,limit:'6'},badBefore=structuredClone(bad);
  invalid(bad,'type');assert.deepEqual(bad,badBefore);
  const needsDefault={name:'default',inputSchema:{type:'object',properties:{count:{type:'integer',default:6}},required:['count']}};
  assert.throws(()=>validateMcpArguments(needsDefault,{}),{code:'MCP_INVALID_ARGUMENTS'});
});

test('missing or invalid input schemas fail before execution rather than bypassing validation',()=>{
  for(const inputSchema of [undefined,null,[],{type:'not-a-json-schema-type'},{$ref:'#/$defs/missing'}]){
    assert.throws(()=>validateMcpArguments({name:'get_schema',inputSchema},{}),error=>error.code==='MCP_SCHEMA_UNAVAILABLE'&&error.details.execution==='not_started');
  }
});

test('read classification is restricted to audited exact names and ignores naming heuristics or annotations',()=>{
  for(const name of ['get_schema','list_rows','get_rows','search_row_structs']){
    assert.equal(isReadOnlyMcpCall({name:'call_tool',arguments:{toolset_name:DATA_TABLE,tool_name:name}}),true);
    assert.equal(isReadOnlyMcpCall({name:`${DATA_TABLE}.${name}`,arguments:{}}),true);
  }
  for(const call of [
    {name:'call_tool',arguments:{toolset_name:'DataTableTools',tool_name:'get_schema'}},
    {name:'call_tool',arguments:{toolset_name:DATA_TABLE,tool_name:'get_and_delete_rows'}},
    {name:'ObjectTools.get_properties',arguments:{},annotations:{readOnlyHint:true}},
    {name:'call_tool',arguments:{toolset_name:'UnknownToolset',tool_name:'get_schema',annotations:{readOnlyHint:true}}},
  ])assert.equal(isReadOnlyMcpCall(call),false);
});

test('UE errors retain their original text and result for read and writing failures',()=>{
  const result={isError:true,content:[{type:'text',text:'Unknown tool: DataTableTools.DataTableTools.get_schema'},{type:'text',text:'资产不存在：/Game/Missing'},{type:'image',data:'unused'}]};
  for(const readOnly of [true,false]){
    const error=mcpFailure(result,'request-id',readOnly);
    assert.equal(error.message,'Unknown tool: DataTableTools.DataTableTools.get_schema\n资产不存在：/Game/Missing');
    assert.equal(error.details.ueResult,result);assert.equal(error.details.requestId,'request-id');
    assert.equal(error.code,readOnly?'MCP_READ_ERROR':'MCP_TOOL_ERROR');
    assert.equal(error.details.rollback,readOnly?'not_needed':'not_available');
    assert.equal(error.details.retryable,true);
    assert.equal(error.details.recovery,readOnly?'correct_and_retry':'verify_before_retry');
  }
  assert.equal(mcpFailure({ok:false,error:{message:'原始错误'}}).message,'原始错误');
  assert.throws(()=>describeTools(result,DATA_TABLE),error=>error.code==='MCP_READ_ERROR'&&error.details.ueResult===result);
});

test('only audited MaterialTools queries bypass mutation coordination',()=>{
  assert.equal(MATERIAL_READ_TOOLS.length,8);
  for(const name of MATERIAL_READ_TOOLS){
    assert.equal(isReadOnlyMcpCall({name,arguments:{}}),true);
    assert.equal(isReadOnlyMcpCall({name:'call_tool',arguments:{toolset_name:MATERIAL_TOOLSET,tool_name:name.slice(MATERIAL_TOOLSET.length+1)}}),true);
  }
  for(const leaf of ['recompile','layout_expressions','delete_unused_expressions','rename_parameter_group','add_expression','connect_expressions','get_and_mutate']){
    assert.equal(isReadOnlyMcpCall({name:`${MATERIAL_TOOLSET}.${leaf}`,arguments:{readOnlyHint:true}}),false);
  }
  assert.equal(isReadOnlyMcpCall({name:'other.MaterialTools.get_expressions',arguments:{}}),false);
});

test('explicit rollback failures and write lock codes survive MCP error envelopes',()=>{
  const cases=[
    {ok:false,error:{message:'Restore failed',details:{rollback:'failed'}}},
    {isError:true,details:{rollback:'failed'}},
    {isError:true,structuredContent:{error:{details:{rollback:'failed'}}}},
    {ok:false,error:{code:'DATA_TABLE_ROLLBACK_FAILED',message:'Restore failed'}},
    {ok:false,error:{code:'ROLLBACK_FAILED',message:'Blueprint restore failed'}},
    {isError:true,structuredContent:{error:{code:'ROLLBACK_FAILED'}}},
    {ok:false,error:{code:'EDITOR_WRITE_LOCKED',message:'Editor is locked'}},
    {isError:true,structuredContent:{error:{code:'DATA_TABLE_ROLLBACK_FAILED'}}},
    {isError:true,structuredContent:{error:{code:'EDITOR_WRITE_LOCKED'}}},
  ];
  for(const result of cases){
    for(const readOnly of [false,true]){
      const error=mcpFailure(result,'unsafe-request',readOnly);
      assert.equal(error.code,readOnly?'MCP_READ_ERROR':'MCP_TOOL_ERROR');
      assert.equal(error.details.rollback,'failed',JSON.stringify(result));
      assert.equal(error.details.retryable,false);
      assert.equal(error.details.recovery,'stop_writes');
      assert.equal(error.details.requestId,'unsafe-request');
      assert.equal(error.details.ueResult,result);
    }
  }
});

test('an unknown write cannot gain rollback confidence from an unverified restored claim',()=>{
  for(const result of [
    {ok:false,error:{details:{rollback:'restored'}}},
    {isError:true,details:{rollback:'restored'}},
    {isError:true,structuredContent:{error:{details:{rollback:'restored'}}}},
  ]){
    const error=mcpFailure(result,'unknown-write');
    assert.equal(error.code,'MCP_TOOL_ERROR');
    assert.equal(error.details.rollback,'not_available');
    assert.equal(error.details.retryable,true);
    assert.equal(error.details.recovery,'verify_before_retry');
  }
});
