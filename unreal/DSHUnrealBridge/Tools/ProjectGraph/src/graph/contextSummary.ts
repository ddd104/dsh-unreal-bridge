import type { SearchResult } from "./search.js";
import type { NodeRecord } from "./schema.js";

export interface ContextSummary {
  filesToRead: string[];
  blueprintsToRead: string[];
  assetsToInspect: string[];
  importantSymbols: string[];
  architectureRules: string[];
  validationHints: string[];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function nodePathOrName(node: NodeRecord): string {
  return node.path || node.name;
}

export function summarizeNodes(nodes: NodeRecord[]): ContextSummary {
  const filesToRead = uniqueSorted(nodes.filter((node) => node.type === "File").map((node) => node.path));
  const blueprintsToRead = uniqueSorted(nodes.filter((node) => node.type === "Blueprint").map(nodePathOrName));
  const assetsToInspect = uniqueSorted(
    nodes
      .filter((node) => ["Asset", "Material", "DataAsset", "Widget", "Level"].includes(node.type))
      .map(nodePathOrName)
  );
  const importantSymbols = uniqueSorted(
    nodes
      .filter((node) => ["Module", "Class", "Struct", "Enum", "Function", "Property", "Variable", "Component", "Config"].includes(node.type))
      .map((node) => `${node.type}:${node.name}`)
  );

  return {
    filesToRead,
    blueprintsToRead,
    assetsToInspect,
    importantSymbols,
    architectureRules: [
      "State the owning system before implementation.",
      "Follow existing module boundaries and avoid unrelated refactors.",
      "Do not directly edit .uasset or .umap files; use UE MCP / patch tools for asset edits."
    ],
    validationHints: [
      "Compile the target project's Editor target after C++ or Build.cs changes.",
      "Rebuild ProjectGraph after code or UE cache export changes.",
      "For Blueprint, material, or asset work, inspect UE MCP warnings and compile affected Blueprints."
    ]
  };
}

export function summarizeSearchResults(results: SearchResult[]): ContextSummary {
  return summarizeNodes(results.map((result) => result.node));
}
