// Repair accounting uses host-selected operation families and UObject targets.
// This metadata grants no tool permissions and never changes bridge write safety.
import {MATERIAL_TOOLSET,AUDITED_MCP_READS} from './mcp-contract.mjs';
import {fail} from './protocol.mjs';

const BLUEPRINT='editor_toolset.toolsets.blueprint.BlueprintTools';
const DATA_TABLE='editor_toolset.toolsets.data_table.DataTableTools';
const OBJECT='editor_toolset.toolsets.object.ObjectTools';
const FAMILIES=new Map([[BLUEPRINT,'blueprint_edit'],[DATA_TABLE,'data_table_edit'],[OBJECT,'object_properties'],[MATERIAL_TOOLSET,'material_edit']]);
const DIAGNOSTICS=new Set(AUDITED_MCP_READS);
const TARGET_KEYS=['blueprint','blueprintPath','blueprint_path','asset','assetPath','asset_path','data_table','dataTable','table','instance','object','object_path','objectPath','target','target_asset','targetAsset','graph','graph_ref','node','nodes','actor','component','material','material_or_function'];
const MATERIAL_TARGET_KEYS=[...TARGET_KEYS,'expression','from_expression','to_expression','material_function'];
const MATERIAL_CLASSES=new Set(['/Script/Engine.Material','/Script/Engine.MaterialFunction']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_CLASS=/^\/Script\/[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
// This evidence is populated only from a successful native read, never from
// caller-provided type names. An editor reconnect gets a fresh WeakMap key.
const materialReads=new WeakMap();
const validPath=value=>typeof value==='string'&&value.startsWith('/')&&value.length<=2048&&!/[\s\\'"\x00-\x1f]/.test(value)&&!value.includes('..');
const pathOf=value=>validPath(value)?value:validPath(value?.refPath)?value.refPath:null;

function canonicalTarget(value,collapseSubobjects=false){
  const path=pathOf(value);if(!path)return 'editor_scope';
  const [asset,...subobjects]=path.split(':');
  const object=asset.includes('.')?asset:`${asset}.${asset.split('/').at(-1)}`;
  return `${object}${!collapseSubobjects&&subobjects.length?`:${subobjects.join(':')}`:''}`.toLowerCase();
}

function targetOf(args,collapseSubobjects,keys=TARGET_KEYS){
  const targets=new Set();
  for(const key of keys){
    const values=Array.isArray(args?.[key])?args[key]:[args?.[key]];
    for(const value of values){
      const path=pathOf(value);if(path)targets.add(canonicalTarget(path,collapseSubobjects));
    }
  }
  // A malformed or multi-owner request has no trustworthy single target.
  // Changing arbitrary values or adding request IDs cannot create a new issue.
  return targets.size===1?[...targets][0]:'editor_scope';
}

function currentEditor(bridge,sessionId){
  return bridge.editors?.get(bridge.sessions.get(sessionId));
}

/** Validate native evidence before attaching host-owned connection identity.
 * Class ancestry and graph inventories are verified by the native preflight;
 * class-name spelling or caller-supplied metadata cannot establish ownership.
 */
export function validateMcpOperationContext(result,expectedToolName){
  const invalid=()=>fail('MCP_OPERATION_CONTEXT_INVALID','The editor did not return consistent native MCP operation ownership',{execution:'not_started',retryable:false});
  if(!result||Array.isArray(result)||result.verified!==true||typeof expectedToolName!=='string'||!expectedToolName||expectedToolName.length>512||result.toolName!==expectedToolName||
    typeof result.token!=='string'||!UUID.test(result.token)||!Array.isArray(result.blueprintOwners)||result.blueprintOwners.length>1024)invalid();
  const seen=new Set(),blueprintOwners=[];
  for(const owner of result.blueprintOwners){
    if(!owner||!validPath(owner.path)||!owner.path.split(':')[0].includes('.')||typeof owner.classPath!=='string'||owner.classPath.length>512||!NATIVE_CLASS.test(owner.classPath))invalid();
    const target=canonicalTarget(owner.path);
    if(seen.has(target))invalid();
    seen.add(target);blueprintOwners.push(Object.freeze({path:owner.path,classPath:owner.classPath}));
  }
  return Object.freeze({verified:true,toolName:result.toolName,token:result.token,blueprintOwners:Object.freeze(blueprintOwners)});
}

function nativeBlueprintTarget(bridge,sessionId,fullName,kind,evidence){
  const native=validateMcpOperationContext(evidence,fullName);
  if(!evidence.editor||currentEditor(bridge,sessionId)!==evidence.editor||bridge.bindingVersions?.get(sessionId)!==evidence.bindingVersion)
    fail('INSTANCE_CHANGED','The editor binding changed after MCP ownership preflight',{execution:'not_started',retryable:true});
  if(native.blueprintOwners.length>1){
    if(kind!=='read')fail('MCP_TARGET_OWNER_MISMATCH','A modifying MCP operation must have one verified Blueprint owner',{execution:'not_started',retryable:true});
    return 'editor_scope';
  }
  // Preserve the complete LevelScriptBlueprint object path; its World package
  // is not the owning Blueprint. Ordinary Blueprint paths canonicalize alike.
  return native.blueprintOwners.length?canonicalTarget(native.blueprintOwners[0].path):null;
}

function blueprintFallbackTarget(args){
  // This only groups input/schema failures that occur before native preflight.
  // Successful dispatch uses fresh native evidence, never this path inference.
  const references={...args};
  const pins=[args?.pin,args?.output_pin,args?.input_pin,...(Array.isArray(args?.context_pins)?args.context_pins:[])];
  references.nodes=[...(Array.isArray(args?.nodes)?args.nodes:[]),...pins.map(pin=>pin?.node)];
  return targetOf(references,true);
}

/** Call only after a native material_read succeeds and its binding is rechecked. */
export function rememberMaterialRead(bridge,sessionId,result){
  const editor=currentEditor(bridge,sessionId);
  if(!editor||!result||result.ok===false||!MATERIAL_CLASSES.has(result.assetClass)||!validPath(result.assetPath)||result.assetPath.includes(':')||!Array.isArray(result.nodes)||typeof result.nodesComplete!=='boolean')return false;
  const owner=canonicalTarget(result.assetPath),nodes=new Map();
  for(const node of result.nodes){
    if(!node||!validPath(node.objectPath)||!node.objectPath.includes(':')||!validPath(node.ownerPath)||node.ownerPath.includes(':')||!validPath(node.classPath)||
      canonicalTarget(node.ownerPath)!==owner||canonicalTarget(node.objectPath,true)!==owner)return false;
    const path=canonicalTarget(node.objectPath);
    if(nodes.has(path))return false;
    // The native reader verifies IsA<UMaterialExpression> and actual Outer.
    // Class paths are stored as evidence, not inferred from spelling.
    nodes.set(path,Object.freeze({owner,classPath:node.classPath}));
  }
  let owners=materialReads.get(editor);
  if(!owners){owners=new Map();materialReads.set(editor,owners);}
  const previous=owners.get(owner);
  const known=result.nodesComplete?nodes:new Map([...(previous?.nodes??[]),...nodes]);
  owners.set(owner,{assetClass:result.assetClass,nodes:known});
  return true;
}

function knownMaterialOwner(bridge,sessionId,target){
  const editor=currentEditor(bridge,sessionId),owners=editor&&materialReads.get(editor);
  if(!owners||target==='editor_scope')return null;
  const owner=canonicalTarget(target,true),record=owners.get(owner);
  if(!record||!MATERIAL_CLASSES.has(record.assetClass))return null;
  if(target===owner)return owner;
  const node=record.nodes.get(target);
  return node?.owner===owner?owner:null;
}

function mcpOperation(bridge,sessionId,name,args,evidence){
  let fullName='',inner=args?.arguments,toolset,tool;
  if(name==='unreal_mcp_call_toolset'){toolset=args?.toolsetName;tool=args?.toolName;}
  else if(typeof args?.name==='string'&&args.name.toLowerCase()==='call_tool'){
    toolset=inner?.toolset_name;tool=inner?.tool_name;inner=inner?.arguments;
  }else fullName=typeof args?.name==='string'?args.name:'';
  if(typeof tool==='string'){
    fullName=typeof toolset==='string'&&toolset?(tool.startsWith(`${toolset}.`)?tool:`${toolset}.${tool}`):tool;
  }
  const split=fullName.lastIndexOf('.');
  const owner=split<0?'':fullName.slice(0,split);
  const kind=DIAGNOSTICS.has(fullName)?'read':'write';
  let family=FAMILIES.get(owner)??'mcp_edit';
  let target=family==='blueprint_edit'?blueprintFallbackTarget(inner):targetOf(inner,['data_table_edit','material_edit'].includes(family),family==='material_edit'?MATERIAL_TARGET_KEYS:TARGET_KEYS);
  if(evidence!==undefined&&evidence!==null){
    const nativeTarget=nativeBlueprintTarget(bridge,sessionId,fullName,kind,evidence);
    if(nativeTarget!==null)return {kind,family:'blueprint_edit',target:nativeTarget};
    // An empty verified Blueprint inventory overrides a caller's path guess.
    if(owner===BLUEPRINT)target='editor_scope';
  }
  if(owner===OBJECT&&['set_properties','get_properties','get_class','get_metadata'].includes(fullName.slice(split+1))){
    const materialOwner=knownMaterialOwner(bridge,sessionId,target);
    if(materialOwner){family='material_edit';target=materialOwner;}
  }
  return {kind,family,target};
}

export function operationContext(bridge,sessionId,name,args={},nativeEvidence){
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
  }else if(name==='unreal_material_read'||name==='unreal_material_patch'){
    kind=name==='unreal_material_read'?'read':args?.dryRun===false?'write':'preview';
    family='material_edit';target=canonicalTarget(args?.assetPath,true);
  }else if(name==='unreal_save'||name==='unreal_undo'||name==='unreal_knowledge_record'){
    kind='write';family=name;target=canonicalTarget(args?.assetPath,true);
  }else if(name==='unreal_mcp_call'||name==='unreal_mcp_call_toolset'){
    ({kind,family,target}=mcpOperation(bridge,sessionId,name,args,nativeEvidence));
  }
  return {editorId,target,family,kind,
    ...(kind==='write'&&typeof args?.requestId==='string'?{requestId:args.requestId}:{}),
    ...(name==='unreal_request_status'&&typeof args?.requestId==='string'?{statusRequestId:args.requestId}:{}),
    blocked:bridge.config.allowWrites===false||bridge.writeLocks.has(editorId)||bridge.uncertain.has(sessionId)||!!bridge.editorWrites.get(editorId)};
}
