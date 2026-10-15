export const NODE_TYPES = [
  "File",
  "Module",
  "Class",
  "Struct",
  "Enum",
  "Function",
  "Macro",
  "Property",
  "Variable",
  "Component",
  "Config",
  "Blueprint",
  "Asset",
  "Material",
  "DataAsset",
  "Widget",
  "Level"
] as const;

export const EDGE_TYPES = [
  "DECLARES",
  "CONTAINS",
  "INCLUDES",
  "INHERITS",
  "CALLS",
  "HAS_PROPERTY",
  "HAS_VARIABLE",
  "HAS_FUNCTION",
  "HAS_MACRO",
  "HAS_COMPONENT",
  "USES_CONFIG",
  "REFERENCES_ASSET",
  "PARENT_CLASS",
  "USED_BY_BLUEPRINT",
  "INSTANCE_OF_MATERIAL",
  "DEPENDS_ON"
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];

export type Metadata = Record<string, unknown>;

export interface NodeRecord {
  id: string;
  type: NodeType;
  name: string;
  path: string;
  system: string;
  language: string;
  summary: string;
  metadata: Metadata;
}

export interface EdgeRecord {
  from: string;
  to: string;
  type: EdgeType;
  metadata: Metadata;
}

const NODE_TYPE_SET = new Set<string>(NODE_TYPES);
const EDGE_TYPE_SET = new Set<string>(EDGE_TYPES);

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && NODE_TYPE_SET.has(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === "string" && EDGE_TYPE_SET.has(value);
}

function isMetadata(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateNodeRecord(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["node must be an object"];
  }

  const node = value as Partial<NodeRecord>;
  for (const key of ["id", "name", "path", "system", "language", "summary"] as const) {
    if (typeof node[key] !== "string") {
      errors.push(`node.${key} must be a string`);
    }
  }
  if (!isNodeType(node.type)) {
    errors.push(`node.type must be one of ${NODE_TYPES.join(", ")}`);
  }
  if (!isMetadata(node.metadata)) {
    errors.push("node.metadata must be an object");
  }
  return errors;
}

export function validateEdgeRecord(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["edge must be an object"];
  }

  const edge = value as Partial<EdgeRecord>;
  if (typeof edge.from !== "string") {
    errors.push("edge.from must be a string");
  }
  if (typeof edge.to !== "string") {
    errors.push("edge.to must be a string");
  }
  if (!isEdgeType(edge.type)) {
    errors.push(`edge.type must be one of ${EDGE_TYPES.join(", ")}`);
  }
  if (!isMetadata(edge.metadata)) {
    errors.push("edge.metadata must be an object");
  }
  return errors;
}

export function assertNodeRecord(value: unknown): asserts value is NodeRecord {
  const errors = validateNodeRecord(value);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function assertEdgeRecord(value: unknown): asserts value is EdgeRecord {
  const errors = validateEdgeRecord(value);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}
