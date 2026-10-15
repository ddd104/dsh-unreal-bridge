import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphStore } from "./graphStore.js";
import type { EdgeRecord, NodeRecord } from "./schema.js";

export interface ContextPackFile {
  nodeId: string;
  path: string;
  system: string;
  language: string;
  summary: string;
  snippet?: string;
}

export interface ContextPack {
  root: NodeRecord;
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  files: ContextPackFile[];
  filesToRead: string[];
  blueprintsToRead: string[];
  assetsToInspect: string[];
  importantSymbols: string[];
  architectureRules: string[];
  validationHints: string[];
  systems: string[];
  warnings: string[];
}

export interface ContextPackOptions {
  projectRoot?: string;
  depth?: number;
  maxNodes?: number;
  includeSnippets?: boolean;
}

function adjacentNodeIds(edge: EdgeRecord, nodeId: string): string[] {
  if (edge.from === nodeId) return [edge.to];
  if (edge.to === nodeId) return [edge.from];
  return [];
}

async function readSnippet(projectRoot: string | undefined, relativePath: string): Promise<string | undefined> {
  if (!projectRoot || !relativePath) {
    return undefined;
  }
  const fullPath = path.resolve(projectRoot, relativePath);
  try {
    const text = await readFile(fullPath, "utf8");
    return text.split(/\r?\n/).slice(0, 80).join("\n");
  } catch {
    return undefined;
  }
}

export async function buildContextPack(
  store: GraphStore,
  nodeId: string,
  options: ContextPackOptions = {}
): Promise<ContextPack> {
  const root = store.getNode(nodeId);
  if (!root) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const maxNodes = options.maxNodes ?? 40;
  const depth = options.depth ?? 1;
  const selected = new Set<string>([root.id]);
  let frontier = new Set<string>([root.id]);

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const edge of store.adjacent(id)) {
        for (const adjacent of adjacentNodeIds(edge, id)) {
          if (selected.size >= maxNodes) break;
          if (!selected.has(adjacent) && store.getNode(adjacent)) {
            selected.add(adjacent);
            next.add(adjacent);
          }
        }
      }
    }
    frontier = next;
    if (frontier.size === 0 || selected.size >= maxNodes) {
      break;
    }
  }

  const nodes = [...selected].map((id) => store.getNode(id)).filter((node): node is NodeRecord => Boolean(node));
  const nodeSet = new Set(nodes.map((node) => node.id));
  const edges = store.edges().filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to));

  const fileNodes = nodes.filter((node) => node.type === "File");
  const files: ContextPackFile[] = [];
  for (const node of fileNodes) {
    files.push({
      nodeId: node.id,
      path: node.path,
      system: node.system,
      language: node.language,
      summary: node.summary,
      snippet: options.includeSnippets === false ? undefined : await readSnippet(options.projectRoot, node.path)
    });
  }

  const systems = [...new Set(nodes.map((node) => node.system).filter(Boolean))].sort();
  const filesToRead = fileNodes.map((node) => node.path).filter(Boolean).sort();
  const blueprintsToRead = nodes.filter((node) => node.type === "Blueprint").map((node) => node.path || node.name).filter(Boolean).sort();
  const assetsToInspect = nodes
    .filter((node) => ["Asset", "Material", "DataAsset", "Widget", "Level"].includes(node.type))
    .map((node) => node.path || node.name)
    .filter(Boolean)
    .sort();
  const importantSymbols = nodes
    .filter((node) => ["Class", "Struct", "Enum", "Function", "Macro", "Property", "Variable", "Component", "Module", "Config"].includes(node.type))
    .map((node) => `${node.type}:${node.name}`)
    .sort();
  const architectureRules = [
    "Use ProjectGraph results to identify the owning system before editing.",
    "Read the returned files and UE asset summaries before changing code.",
    "Do not edit .uasset or .umap files directly; use UE MCP / patch tools for asset changes."
  ];
  const validationHints = [
    "For C++ or Build.cs changes, compile the target project's Editor target.",
    "For Blueprint, material, or asset changes, use UE MCP read/dry-run/apply flows and inspect warnings.",
    "Rebuild ProjectGraph after changes that add files, symbols, assets, or UE cache exports."
  ];
  const warnings: string[] = [];
  if (selected.size >= maxNodes) {
    warnings.push(`Context pack reached maxNodes=${maxNodes}`);
  }

  return {
    root,
    nodes,
    edges,
    files,
    filesToRead,
    blueprintsToRead,
    assetsToInspect,
    importantSymbols,
    architectureRules,
    validationHints,
    systems,
    warnings
  };
}
