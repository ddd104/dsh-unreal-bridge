import type { GraphStore } from "./graphStore.js";
import type { EdgeRecord, NodeRecord } from "./schema.js";

export interface ImpactItem {
  node: NodeRecord;
  direction: "incoming" | "outgoing";
  edge: EdgeRecord;
  reason: string;
}

export interface ImpactAnalysis {
  root: NodeRecord;
  impacted: ImpactItem[];
  systems: string[];
  risk: "low" | "medium" | "high";
  summary: string;
}

function reasonFor(edge: EdgeRecord, direction: "incoming" | "outgoing"): string {
  if (direction === "incoming") {
    return `${edge.from} ${edge.type} this node`;
  }
  return `this node ${edge.type} ${edge.to}`;
}

export function analyzeImpact(store: GraphStore, nodeId: string): ImpactAnalysis {
  const root = store.getNode(nodeId);
  if (!root) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const impacted: ImpactItem[] = [];
  for (const edge of store.incoming(nodeId)) {
    const node = store.getNode(edge.from);
    if (node) {
      impacted.push({ node, direction: "incoming", edge, reason: reasonFor(edge, "incoming") });
    }
  }
  for (const edge of store.outgoing(nodeId)) {
    const node = store.getNode(edge.to);
    if (node) {
      impacted.push({ node, direction: "outgoing", edge, reason: reasonFor(edge, "outgoing") });
    }
  }

  const systems = [...new Set([root.system, ...impacted.map((item) => item.node.system)].filter(Boolean))].sort();
  const risk = impacted.length > 25 || systems.length > 3 ? "high" : impacted.length > 8 || systems.length > 1 ? "medium" : "low";
  const summary = `${root.type} ${root.name} touches ${impacted.length} adjacent node(s) across ${systems.length} system(s).`;

  return { root, impacted, systems, risk, summary };
}
