import path from "node:path";
import { GraphStore } from "../graph/graphStore.js";
import { buildContextPack } from "../graph/contextPack.js";

export interface GetContextPackOptions {
  projectRoot: string;
  graphDir?: string;
  depth?: number;
}

export async function getContextPack(nodeId: string, options: GetContextPackOptions) {
  const graphDir = path.resolve(options.projectRoot, options.graphDir ?? "Plugins/DSHUnrealBridge/Cache/Graph");
  const store = await GraphStore.loadJsonl(graphDir);
  return buildContextPack(store, nodeId, {
    projectRoot: options.projectRoot,
    depth: options.depth ?? 1
  });
}
