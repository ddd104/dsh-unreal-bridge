import path from "node:path";
import { createFileNode, symbolNodeId } from "../graph/graphStore.js";
import type { GraphStore } from "../graph/graphStore.js";

export interface BuildCsIndexInput {
  relativePath: string;
  content: string;
  system: string;
}

function moduleNameFromPath(relativePath: string): string {
  const base = path.basename(relativePath);
  return base.replace(/\.Build\.cs$/, "").replace(/\.Target\.cs$/, "");
}

function addModule(store: GraphStore, name: string, relativePath: string, system: string, metadata: Record<string, unknown>) {
  return store.addNode({
    id: symbolNodeId("Module", name, "module"),
    type: "Module",
    name,
    path: relativePath,
    system,
    language: "CSharp",
    summary: `Unreal module ${name}`,
    metadata
  });
}

function extractDependencies(content: string): Array<{ name: string; scope: string; line: number }> {
  const deps: Array<{ name: string; scope: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  let scope: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const scopeMatch = line.match(/\b(PublicDependencyModuleNames|PrivateDependencyModuleNames|DynamicallyLoadedModuleNames|ExtraModuleNames)\b/);
    if (scopeMatch) {
      scope = scopeMatch[1];
    }
    if (scope) {
      for (const match of line.matchAll(/"([^"]+)"/g)) {
        deps.push({ name: match[1], scope, line: index + 1 });
      }
      if (line.includes(");") || line.includes("});")) {
        scope = undefined;
      }
    }
  }
  return deps;
}

export function indexBuildCsFile(input: BuildCsIndexInput, store: GraphStore): void {
  const fileNode = store.addNode(createFileNode(input.relativePath, input.system, "CSharp", `Unreal build rules ${input.relativePath}`));
  const moduleName = moduleNameFromPath(input.relativePath);
  const moduleNode = addModule(store, moduleName, input.relativePath, input.system, {
    kind: input.relativePath.endsWith(".Target.cs") ? "Target" : "BuildRules"
  });
  store.addEdge({ from: fileNode.id, to: moduleNode.id, type: "DECLARES", metadata: {} });

  for (const dep of extractDependencies(input.content)) {
    if (dep.name === moduleName) {
      continue;
    }
    const depNode = addModule(store, dep.name, "", dep.name, { kind: "ReferencedModule", confidence: "heuristic" });
    store.addEdge({
      from: moduleNode.id,
      to: depNode.id,
      type: "INCLUDES",
      metadata: {
        scope: dep.scope,
        line: dep.line,
        relation: "module_dependency"
      }
    });
  }
}
