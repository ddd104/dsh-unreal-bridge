import path from "node:path";
import { GraphStore } from "../graph/graphStore.js";
import { searchGraph } from "../graph/search.js";

export interface QueryGraphOptions {
  projectRoot: string;
  graphDir?: string;
  limit?: number;
}

export async function queryGraph(text: string, options: QueryGraphOptions) {
  const graphDir = path.resolve(options.projectRoot, options.graphDir ?? "Plugins/DSHUnrealBridge/Cache/Graph");
  const store = await GraphStore.loadJsonl(graphDir);
  return searchGraph(store, text, { limit: options.limit ?? 20 });
}
