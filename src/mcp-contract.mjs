import Ajv from 'ajv';
import {BridgeError,fail} from './protocol.mjs';
import {isUnsafeWriteError} from './write-safety.mjs';

const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
export const BLUEPRINT_TOOLSET='editor_toolset.toolsets.blueprint.BlueprintTools';
export const OBJECT_TOOLSET='editor_toolset.toolsets.object.ObjectTools';
// Audited blueprint.py/object.py and their native graph/property query paths.
// read_graph_dsl/get_node_type_pins temporarily add/remove live nodes: excluded.
export const BLUEPRINT_READ_TOOLS=Object.freeze(['get_default_object','list_graphs','find_nodes','get_node_infos'].map(name=>`${BLUEPRINT_TOOLSET}.${name}`));
export const OBJECT_READ_TOOLS=Object.freeze(['get_class','get_properties','list_properties'].map(name=>`${OBJECT_TOOLSET}.${name}`));
export const MATERIAL_TOOLSET='editor_toolset.toolsets.material.MaterialTools';
// Audited UE 5.8 material.py and its MaterialEditingLibrary query implementations.
// Keep the native IsAuditedMcpRead allowlist aligned with these exact names.
export const MATERIAL_READ_TOOLS=Object.freeze([
  'list_expression_classes','get_expressions','list_parameter_groups',
  'get_expression_input_names','get_expression_output_names','get_expression_inputs',
  'get_property_input','get_referencing_materials',
].map(name=>`${MATERIAL_TOOLSET}.${name}`));
// Audited UE 5.8 queries. Unknown tools remain potential writes;
// a get_/list_ prefix or a caller-supplied annotation cannot establish safety.
export const AUDITED_MCP_READS=Object.freeze([
  ...['get_schema','list_rows','get_rows','search_row_structs'].map(name=>`${DATA_TABLE}.${name}`),
  ...MATERIAL_READ_TOOLS,
  ...BLUEPRINT_READ_TOOLS,
  ...OBJECT_READ_TOOLS,
]);
const READS=new Set(AUDITED_MCP_READS);
const notStarted={execution:'not_started',retryable:true};

/** Accept a short name or one exact prefix belonging to the selected toolset. */
export function shortToolName(toolsetName,name){
  const short=name.startsWith(`${toolsetName}.`)?name.slice(toolsetName.length+1):name;
  if(!/^[A-Za-z0-9_-]+$/.test(short))fail('MCP_INVALID_TOOL_NAME','Use the function name from unreal_mcp_describe for this exact toolset',{...notStarted,toolsetName,toolName:name});
  return short;
}

/** Parse and normalize discovery without changing the editor's parameter schema. */
export function describeTools(result,toolsetName){
  if(result?.isError===true||result?.ok===false)throw mcpFailure(result,null,true);
  const block=result?.content?.find(item=>item.type==='text');
  let description;
  try{description=JSON.parse(block?.text);}catch{fail('MCP_DESCRIPTION_UNPARSEABLE','The editor did not return a JSON toolset description',{...notStarted,toolsetName});}
  if(!Array.isArray(description?.tools))fail('MCP_DESCRIPTION_UNPARSEABLE','The editor returned a toolset description without tools',{...notStarted,toolsetName});
  const tools=description.tools.map(tool=>{
    if(typeof tool?.name!=='string')fail('MCP_DESCRIPTION_UNPARSEABLE','The editor returned a tool without a name',{...notStarted,toolsetName});
    const name=shortToolName(toolsetName,tool.name);
    return {...tool,name,fullName:`${toolsetName}.${name}`,toolsetName};
  });
  if(new Set(tools.map(tool=>tool.name)).size!==tools.length)fail('MCP_DESCRIPTION_UNPARSEABLE','The editor returned duplicate tool names',{...notStarted,toolsetName});
  return {block,description:{...description,tools}};
}

/** Validate current UE schemas without coercing, defaulting, or rewriting data. */
export function validateMcpArguments(tool,args){
  const schema=tool?.inputSchema;
  if(!schema||typeof schema!=='object'||Array.isArray(schema))fail('MCP_SCHEMA_UNAVAILABLE','Read the exact input schema before calling this UE tool',{...notStarted,toolName:tool?.name??null});
  // Reflected UE functions have named parameters. Their generated schema omits
  // additionalProperties even though the callable does not accept extra names.
  const fixed=schema.type==='object'&&schema.properties&&!('additionalProperties' in schema)&&!schema.patternProperties&&!schema.anyOf&&!schema.oneOf&&!schema.allOf;
  let validate;
  try{validate=new Ajv({allErrors:true,strict:false,validateFormats:false}).compile(fixed?{...schema,additionalProperties:false}:schema);}
  catch(error){fail('MCP_SCHEMA_UNAVAILABLE',`The editor's input schema cannot be validated: ${error.message}`,{...notStarted,toolName:tool.name});}
  if(!validate(args))fail('MCP_INVALID_ARGUMENTS','Arguments do not match the current UE input schema; correct the reported fields before retrying',{
    ...notStarted,toolName:tool.name,issues:validate.errors.slice(0,20).map(({instancePath,keyword,message,params})=>({path:instancePath||'/',keyword,message,...params})),inputSchema:schema
  });
}

export function isReadOnlyMcpCall(call){
  return READS.has(mcpOperationToolName(call));
}

export function mcpOperationToolName(call){
  if(typeof call?.name!=='string')return '';
  if(call.name.toLowerCase()!=='call_tool')return call.name;
  const toolset=call.arguments?.toolset_name,tool=call.arguments?.tool_name;
  if(typeof tool!=='string')return '';
  return typeof toolset==='string'&&toolset&&!tool.startsWith(`${toolset}.`)?`${toolset}.${tool}`:tool;
}

export function requiresMcpOperationContext(call){
  const name=mcpOperationToolName(call);
  return typeof name==='string'&&[BLUEPRINT_TOOLSET,OBJECT_TOOLSET].some(toolset=>name.startsWith(`${toolset}.`));
}

/** Preserve UE evidence while allowing a state-aware correction, not blind replay. */
export function mcpFailure(result,requestId=null,readOnly=false){
  const text=(result?.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('\n')||result?.error?.message||result?.message||'The UE MCP tool reported failure';
  // Preserve explicit unsafe-state evidence through the MCP envelope. A
  // third-party "restored" claim alone must not establish rollback guarantees.
  const unsafe=isUnsafeWriteError(result);
  return new BridgeError(readOnly?'MCP_READ_ERROR':'MCP_TOOL_ERROR',text,{
    retryable:!unsafe,recovery:unsafe?'stop_writes':readOnly?'correct_and_retry':'verify_before_retry',readOnly,rollback:unsafe?'failed':readOnly?'not_needed':'not_available',requestId,ueResult:result
  });
}
