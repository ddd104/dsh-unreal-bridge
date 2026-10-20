// Repair accounting uses host-selected operation families and UObject targets.
// This metadata grants no tool permissions and never changes bridge write safety.
const BLUEPRINT='editor_toolset.toolsets.blueprint.BlueprintTools';
const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
const OBJECT='editor_toolset.toolsets.object.ObjectTools';
const FAMILIES=new Map([[BLUEPRINT,'blueprint_edit'],[DATA_TABLE,'data_table_edit'],[OBJECT,'object_properties']]);
const DIAGNOSTICS=new Set([
  ...['get_default_object','get_graphs','get_nodes','get_node_infos'].map(name=>`${BLUEPRINT}.${name}`),
  ...['get_properties','get_class','get_metadata'].map(name=>`${OBJECT}.${name}`),
  ...['get_schema','list_rows','get_rows','search_row_structs'].map(name=>`${DATA_TABLE}.${name}`),
]);
const TARGET_KEYS=['blueprint','blueprintPath','blueprint_path','asset','assetPath','asset_path','data_table','dataTable','table','instance','object','object_path','objectPath','target','target_asset','targetAsset','graph','graph_ref','node','nodes','actor','component','material','material_or_function'];
const validPath=value=>typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\s\\'"\x00-\x1f]/.test(value)&&!value.includes('..');
const pathOf=value=>validPath(value)?value:validPath(value?.refPath)?value.refPath:null;

function canonicalTarget(value,collapseSubobjects=false){
  const path=pathOf(value);if(!path)return 'editor_scope';
  const [asset,...subobjects]=path.split(':');
  const object=asset.includes('.')?asset:`${asset}.${asset.split('/').at(-1)}`;
  return `${object}${!collapseSubobjects&&subobjects.length?`:${subobjects.join(':')}`:''}`.toLowerCase();
}

function targetOf(args,collapseSubobjects){
  const targets=new Set();
  for(const key of TARGET_KEYS){
    const values=Array.isArray(args?.[key])?args[key]:[args?.[key]];
    for(const value of values){
      const path=pathOf(value);if(path)targets.add(canonicalTarget(path,collapseSubobjects));
    }
  }
  // A malformed or multi-owner request has no trustworthy single target.
  // Changing arbitrary values or adding request IDs cannot create a new issue.
  return targets.size===1?[...targets][0]:'editor_scope';
}

function mcpOperation(name,args){
  let fullName='',inner=args?.arguments,toolset,tool;
  if(name==='unreal_mcp_call_toolset'){toolset=args?.toolsetName;tool=args?.toolName;}
  else if(typeof args?.name==='string'&&args.name.toLowerCase()==='call_tool'){
    toolset=inner?.toolset_name;tool=inner?.tool_name;inner=inner?.arguments;
  }else fullName=typeof args?.name==='string'?args.name:'';
  if(typeof toolset==='string'&&typeof tool==='string'){
    fullName=tool.startsWith(`${toolset}.`)?tool:`${toolset}.${tool}`;
  }
  const split=fullName.lastIndexOf('.');
  const owner=split<0?'':fullName.slice(0,split);
  const family=FAMILIES.get(owner)??'mcp_edit';
  return {kind:DIAGNOSTICS.has(fullName)?'read':'write',family,target:targetOf(inner,family==='blueprint_edit'||family==='data_table_edit')};
}

export function operationContext(bridge,sessionId,name,args={}){
  const editorId=bridge.sessions.get(sessionId);
  if(!editorId)return null;
  let kind='read',family=name,target=canonicalTarget(args?.assetPath);
  if(name==='unreal_preview_patch'||name==='unreal_preview_create'){
    kind='preview';family='blueprint_edit';target=canonicalTarget(args?.assetPath,true);
  }else if(name==='unreal_apply'){
    // The preview record is host-owned. A guessed/expired ID receives one
    // stable fallback identity; the actual operation still reports its error.
    let preview;
    try{preview=bridge.previewRecord(sessionId,args?.previewId);}catch{}
    kind='write';family='blueprint_edit';target=canonicalTarget(preview?.params?.assetPath,true);
  }else if(name==='unreal_data_table_copy_property'){
    kind='write';family='data_table_edit';target=canonicalTarget(args?.assetPath,true);
  }else if(name==='unreal_save'||name==='unreal_undo'||name==='unreal_knowledge_record'){
    kind='write';family=name;target=canonicalTarget(args?.assetPath,true);
  }else if(name==='unreal_mcp_call'||name==='unreal_mcp_call_toolset'){
    ({kind,family,target}=mcpOperation(name,args));
  }
  return {editorId,target,family,kind,
    ...(kind==='write'&&typeof args?.requestId==='string'?{requestId:args.requestId}:{}),
    ...(name==='unreal_request_status'&&typeof args?.requestId==='string'?{statusRequestId:args.requestId}:{}),
    blocked:bridge.config.allowWrites===false||bridge.writeLocks.has(editorId)||bridge.uncertain.has(sessionId)||!!bridge.editorWrites.get(editorId)};
}
