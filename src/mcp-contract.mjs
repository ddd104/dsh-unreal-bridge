import Ajv from 'ajv';
import {BridgeError,fail} from './protocol.mjs';
import {isUnsafeWriteError} from './write-safety.mjs';

const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
// Audited UE 5.8 data_table.py queries. Unknown tools remain potential writes;
// a get_/list_ prefix or a caller-supplied annotation cannot establish safety.
const READS=new Set(['get_schema','list_rows','get_rows','search_row_structs'].map(name=>`${DATA_TABLE}.${name}`));
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
  const fullName=call.name==='call_tool'?`${call.arguments.toolset_name}.${call.arguments.tool_name}`:call.name;
  return READS.has(fullName);
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
