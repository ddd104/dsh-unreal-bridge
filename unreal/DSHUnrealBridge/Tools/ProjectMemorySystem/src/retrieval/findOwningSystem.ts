import type { GraphFeatureResult } from "../graph/projectGraphClient.js";
import type { EvidenceItem, OwningSystemContext } from "../types/contextPackTypes.js";

function tokenScore(query: string, text: string): number {
  const tokens: string[] = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const run of query.matchAll(/[\p{Script=Han}]{3,}/gu)) {
    for (let i = 0; i < run[0].length - 1; i += 1) tokens.push(run[0].slice(i, i + 2));
  }
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function findOwningSystem(query: string, systems: EvidenceItem[], graphFeature: GraphFeatureResult): OwningSystemContext {
  if (graphFeature.owningSystem && graphFeature.owningSystem !== "Unknown") {
    return {
      id: graphFeature.owningSystem,
      title: graphFeature.owningSystem,
      confidence: "low",
      sourcePaths: graphFeature.filesToRead,
      evidence: graphFeature.nodes.slice(0, 3).map((node) => node.summary ?? node.name)
    };
  }

  const scoredSystems = systems
    .map((system) => ({
      system,
      score: (system.score ?? 0) + tokenScore(query, `${system.title} ${system.excerpt ?? ""}`)
    }))
    .sort((a, b) => b.score - a.score);
  const best = scoredSystems[0];
  if (!best || best.score <= 0) {
    return {
      confidence: "none",
      sourcePaths: [],
      evidence: []
    };
  }

  return {
    id: best.system.id,
    title: best.system.title,
    confidence: best.score >= 3 ? "medium" : "low",
    sourcePaths: best.system.sourcePaths,
    sourceHash: best.system.sourceHash,
    evidence: best.system.excerpt ? [best.system.excerpt] : []
  };
}
