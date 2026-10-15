import path from "node:path";
import { GraphStore } from "../graph/graphStore.js";
import { summarizeSearchResults } from "../graph/contextSummary.js";
import { searchGraph } from "../graph/search.js";

export interface FindFeatureContextOptions {
  projectRoot: string;
  graphDir?: string;
  limit?: number;
}

export async function findFeatureContext(text: string, options: FindFeatureContextOptions) {
  const graphDir = path.resolve(options.projectRoot, options.graphDir ?? "Plugins/DSHUnrealBridge/Cache/Graph");
  const store = await GraphStore.loadJsonl(graphDir);
  const candidates = searchGraph(store, text, { limit: options.limit ?? 12 });
  const systems = [...new Set(candidates.map((result) => result.node.system).filter(Boolean))];
  const summary = summarizeSearchResults(candidates);
  return {
    query: text,
    owningSystem: systems[0] ?? "Unknown",
    owningSystemCandidate: systems[0] ? {name: systems[0], basis: "highest ranked graph hit", verified: false} : null,
    systems,
    candidates,
    ...summary
  };
}
