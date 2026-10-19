import { z } from 'zod';

export const VERSION = 1;
export const PACKAGE = 'dsh-unreal-bridge';
export const id = z.string().min(1).max(160);
export const assetPath = z.string().max(512).regex(/^\/Game\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/, 'Use a /Game/ package or object path');
const node = id;
const point = z.object({x:z.number().int().min(-100000).max(100000), y:z.number().int().min(-100000).max(100000)}).strict();
const endpoint = z.object({node, pin:id}).strict();
export const operation = z.discriminatedUnion('op', [
  z.object({op:z.literal('add_node'), nodeId:node, kind:z.enum(['call_function','event']), functionPath:z.string().max(512).regex(/^\/Script\/[A-Za-z0-9_]+\.[A-Za-z0-9_]+:[A-Za-z0-9_]+$/), position:point.optional()}).strict(),
  z.object({op:z.literal('add_custom_event'), nodeId:node, eventName:z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), position:point.optional()}).strict(),
  z.object({op:z.literal('remove_node'), nodeId:node}).strict(),
  z.object({op:z.literal('set_pin_default'), nodeId:node, pin:id, value:z.string().max(8192)}).strict(),
  z.object({op:z.literal('move_node'), nodeId:node, position:point}).strict(),
  z.object({op:z.literal('connect'), from:endpoint, to:endpoint}).strict(),
  z.object({op:z.literal('disconnect'), from:endpoint, to:endpoint}).strict()
]);
export const patchSchema = z.object({assetPath, graph:id, baseRevision:id, operations:z.array(operation).min(1).max(100)}).strict();
export const createSchema = z.object({assetPath, parent:z.enum(['Actor','ActorComponent','Object']).default('Actor')}).strict();
export const readSchema = z.object({assetPath, graph:id.optional(), nodeIds:z.array(id).max(50).optional(), detail:z.enum(['summary','full']).default('summary')}).strict();
export const focusSchema = z.object({assetPath:z.string().max(512).regex(/^\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)+(?:\.[A-Za-z0-9_]+)?$/), graph:id.optional(), nodeIds:z.array(id).max(50).optional()}).strict();
export const catalogSchema = z.object({query:z.string().max(100).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const mcpToolName = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.-]+$/);
export const mcpArguments = z.record(z.string(),z.json());
export const mcpDescribeSchema = z.object({toolsetName:mcpToolName,query:z.string().min(1).max(100).optional(),includeSchema:z.boolean().default(true)}).strict();
export const mcpCallSchema = z.object({name:mcpToolName,arguments:mcpArguments.default({}),requestId:z.string().uuid()}).strict();
export const mcpToolsetCallSchema = z.object({toolsetName:mcpToolName,toolName:mcpToolName,arguments:mcpArguments.default({}),requestId:z.string().uuid()}).strict();
export const dataTableCopySchema = z.object({assetPath,sourceRow:z.string().min(1).max(1024),propertyName:z.string().min(1).max(160).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),targetRows:z.array(z.string().min(1).max(1024)).min(1).max(4096).optional(),requestId:z.string().uuid()}).strict();
export const knowledgeSchema = z.object({tool:z.enum(['project_status','project_context','project_search','graph_query','graph_feature','graph_impact','read_source','validate_evidence','read_asset_snapshot','search_asset_snapshots','asset_snapshot','inspect_asset','experience_lookup']),arguments:mcpArguments.default({})}).strict();
export const knowledgeRecordSchema = z.object({tool:z.enum(['remember_evidence','experience_save','experience_feedback']),arguments:mcpArguments,requestId:z.string().uuid()}).strict();
export const imageRegionSchema=z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().min(1).max(16384),height:z.number().int().min(1).max(16384)}).strict();
export const visualCaptureSchema=z.object({source:z.literal('editor').default('editor'),targetPath:z.string().min(1).max(1024).optional(),region:imageRegionSchema.optional(),fullViewport:z.boolean().default(false),padding:z.number().int().min(0).max(256).default(8)}).strict().superRefine((value,ctx)=>{
  if(Number(!!value.targetPath)+Number(!!value.region)+Number(value.fullViewport)>1)ctx.addIssue({code:'custom',message:'Choose targetPath, region, or fullViewport, not several capture targets'});
});
export const visualThresholdsSchema=z.object({minSsim:z.number().min(-1).max(1).optional(),maxMeanDeltaE:z.number().min(0).max(200).optional(),maxChangedPixelRatio:z.number().min(0).max(1).optional(),pixelDeltaE:z.number().min(0).max(200).optional(),maxEdgeDistancePx:z.number().min(0).max(16384).optional(),maxMissingEdgeRatio:z.number().min(0).max(1).optional(),edgeTolerancePx:z.number().min(0).max(256).optional(),edgeThreshold:z.number().min(0).max(255).optional()}).strict();
export const visualCompareSchema=z.object({referencePath:z.string().min(1).max(2048),captureId:z.string().uuid().optional(),capture:visualCaptureSchema.optional(),mode:z.enum(['regression','assessment']).default('assessment'),analysis:z.enum(['spatial','color_distribution']).default('spatial'),alignmentConfirmed:z.boolean().default(false),referenceRegion:imageRegionSchema.optional(),currentRegion:imageRegionSchema.optional(),checks:z.array(z.enum(['color','structure','edges','pixels'])).min(1).max(4).optional(),thresholds:visualThresholdsSchema.optional()}).strict().superRefine((value,ctx)=>{
  if(value.captureId&&value.capture)ctx.addIssue({code:'custom',message:'Use captureId or capture options, not both'});
  if(value.checks&&new Set(value.checks).size!==value.checks.length)ctx.addIssue({code:'custom',message:'checks must contain unique check names'});
  if(value.analysis==='color_distribution'&&value.checks?.some(check=>check!=='color'))ctx.addIssue({code:'custom',message:'color_distribution supports only color checks; omit checks or use ["color"]'});
});
export const runtimeTargetSchema=z.object({playSessionId:id,worldId:id,objectId:id}).strict();
export const runtimeMetadataSchema=runtimeTargetSchema.extend({pieInstance:z.number().int(),netMode:z.enum(['standalone','client','listen_server','dedicated_server']),status:z.enum(['running','paused'])}).strict();
export const runtimeInvalidationSchema=runtimeTargetSchema.extend({reason:z.enum(['actor_destroyed','object_destroyed','world_unloaded','pie_ended','tracking_evicted'])}).strict();
export const runtimeChangedSchema=z.object({playSessionId:id.nullable(),status:z.enum(['running','paused','stopped']),isSimulating:z.boolean(),invalidated:z.array(runtimeInvalidationSchema).max(4096)}).strict().superRefine((value,ctx)=>{
  if((value.status==='stopped')!==(value.playSessionId===null))ctx.addIssue({code:'custom',message:'Stopped PIE has a null playSessionId; active PIE requires its playSessionId'});
});
export const runtimeSnapshotSchema=z.object({target:runtimeTargetSchema.optional(),properties:z.array(z.string().min(1).max(256)).max(100).optional(),maxProperties:z.number().int().min(1).max(200).default(80),includeComponents:z.boolean().default(true),maxComponents:z.number().int().min(1).max(32).default(16),collectionOffset:z.number().int().min(0).max(1000000).default(0),collectionLimit:z.number().int().min(1).max(100).default(20)}).strict().superRefine((value,ctx)=>{
  if(value.properties&&value.properties.length>value.maxProperties)ctx.addIssue({code:'custom',message:'properties cannot contain more entries than maxProperties'});
});
export const runtimeHistorySchema=z.object({snapshotId:z.string().uuid().optional()}).strict();
export const runtimeSnapshotResultSchema=z.object({target:runtimeMetadataSchema,path:z.string().min(1).max(1024),class:z.string().min(1).max(1024),worldPath:z.string().max(1024),name:z.string().max(1024),label:z.string().max(1024),kind:z.enum(['actor','component']),blueprintPath:z.string().max(1024).optional(),ownerBlueprintPath:z.string().max(1024).optional(),capturedAt:z.iso.datetime({offset:true}),sampledFrame:z.string().min(1).max(80),paused:z.boolean(),runtimeEvidence:z.literal(true),object:z.record(z.string(),z.json()),components:z.array(z.record(z.string(),z.json())).max(32)}).catchall(z.json());
export const helloSchema = z.object({type:z.literal('hello'), protocol:z.literal(VERSION), editorId:id, project:z.string().min(1).max(512), projectPath:z.string().max(2048), engineVersion:z.string().max(80), pid:z.number().int().positive(), capabilities:z.array(id).max(64)}).strict();
const selectionBase = {path:z.string().min(1).max(1024), class:z.string().min(1).max(1024)};
const levelSelection = {...selectionBase, name:z.string().max(1024), label:z.string().max(1024), worldPath:z.string().max(1024), blueprintPath:z.string().max(1024).optional()};
export const selectionSchema = z.object({assets:z.array(z.union([
  z.object({...selectionBase, kind:z.literal('asset').optional()}).strict(),
  z.object({...levelSelection, kind:z.literal('actor'), runtime:runtimeMetadataSchema.optional()}).strict(),
  z.object({...levelSelection, kind:z.literal('component'), ownerPath:z.string().min(1).max(1024), ownerLabel:z.string().max(1024), ownerBlueprintPath:z.string().max(1024).optional(), runtime:runtimeMetadataSchema.optional()}).strict(),
  z.object({...selectionBase, kind:z.literal('component'), source:z.literal('blueprint_editor'), name:z.string().max(1024), label:z.string().max(1024), componentVariableName:z.string().max(1024), ownerLabel:z.string().max(1024), ownerBlueprintPath:z.string().min(1).max(1024), isInherited:z.boolean(), blueprintPath:z.string().max(1024).optional()}).strict()
])).max(256)}).strict();

export class BridgeError extends Error {
  constructor(code,message,details={}) { super(message); this.name='BridgeError'; this.code=code; this.details=details; }
}
export function fail(code,message,details) { throw new BridgeError(code,message,details); }
export function errorResult(e) { return {ok:false, error:{code:e.code ?? 'INVALID_REQUEST', message:e.message, ...(e.details ? {details:e.details}: {})}}; }
export function jsonSchema(schema) {
  // DSH enforces a small JSON Schema subset. Zod still validates every constraint
  // in execute(); the advertised schema keeps only keywords DSH accepts.
  const adapt=value=>{
    if(Array.isArray(value))return value.map(adapt);
    if(value===null||typeof value!=='object')return value;
    const out={};
    const allowed=new Set(['type','properties','required','additionalProperties','items','enum','const','oneOf','description','title','default','examples']);
    for(const [key,v] of Object.entries(value)){
      if(key==='properties')out.properties=Object.fromEntries(Object.entries(v).map(([k,s])=>[k,adapt(s)]));
      else if(key==='anyOf')out.oneOf=adapt(v);
      else if(allowed.has(key))out[key]=adapt(v);
    }
    return out;
  };
  return adapt(JSON.parse(JSON.stringify(z.toJSONSchema(schema))));
}
