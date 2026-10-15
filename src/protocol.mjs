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
  z.object({op:z.literal('remove_node'), nodeId:node}).strict(),
  z.object({op:z.literal('set_pin_default'), nodeId:node, pin:id, value:z.string().max(8192)}).strict(),
  z.object({op:z.literal('move_node'), nodeId:node, position:point}).strict(),
  z.object({op:z.literal('connect'), from:endpoint, to:endpoint}).strict(),
  z.object({op:z.literal('disconnect'), from:endpoint, to:endpoint}).strict()
]);
export const patchSchema = z.object({assetPath, graph:id, baseRevision:id, operations:z.array(operation).min(1).max(100)}).strict();
export const createSchema = z.object({assetPath, parent:z.enum(['Actor','ActorComponent','Object']).default('Actor')}).strict();
export const readSchema = z.object({assetPath, graph:id.optional(), nodeIds:z.array(id).max(50).optional(), detail:z.enum(['summary','full']).default('summary')}).strict();
export const catalogSchema = z.object({query:z.string().max(100).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const helloSchema = z.object({type:z.literal('hello'), protocol:z.literal(VERSION), editorId:id, project:z.string().min(1).max(512), projectPath:z.string().max(2048), engineVersion:z.string().max(80), pid:z.number().int().positive(), capabilities:z.array(id).max(64)}).strict();
export const selectionSchema = z.object({assets:z.array(z.object({path:z.string().max(1024), class:z.string().max(256)}).strict()).max(256)}).strict();

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
