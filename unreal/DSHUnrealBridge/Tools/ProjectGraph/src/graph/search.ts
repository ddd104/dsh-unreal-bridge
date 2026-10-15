import type { GraphStore } from "./graphStore.js";
import type { NodeRecord } from "./schema.js";

export interface SearchResult {
  node: NodeRecord;
  score: number;
  reasons: string[];
}

export interface SearchOptions {
  limit?: number;
  types?: string[];
}

export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/i).filter(Boolean);
  for (const run of text.matchAll(/[\p{Script=Han}]{3,}/gu)) {
    for (let i = 0; i < Math.min(run[0].length - 1, 24); i += 1) tokens.push(run[0].slice(i, i + 2));
  }
  for (const part of text.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []) {
    if (part.length > 2) tokens.push(part.toLowerCase());
  }
  return [...new Set(tokens)];
}

function metadataText(node: NodeRecord): string {
  try {
    return JSON.stringify(node.metadata ?? {});
  } catch {
    return "";
  }
}

function scoreNode(node: NodeRecord, tokens: string[], rawQuery: string): SearchResult | undefined {
  const reasons: string[] = [];
  let score = 0;
  const name = node.name.toLowerCase();
  const path = node.path.toLowerCase();
  const system = node.system.toLowerCase();
  const summary = node.summary.toLowerCase();
  const metadata = metadataText(node).toLowerCase();
  const query = rawQuery.toLowerCase();

  if (name === query) {
    score += 80;
    reasons.push("exact name match");
  } else if (name.includes(query)) {
    score += 45;
    reasons.push("name contains query");
  }

  for (const token of tokens) {
    if (name.includes(token)) {
      score += 20;
      reasons.push(`name:${token}`);
    }
    if (path.includes(token)) {
      score += 10;
      reasons.push(`path:${token}`);
    }
    if (system.includes(token)) {
      score += 8;
      reasons.push(`system:${token}`);
    }
    if (summary.includes(token)) {
      score += 6;
      reasons.push(`summary:${token}`);
    }
    if (metadata.includes(token)) {
      score += 4;
      reasons.push(`metadata:${token}`);
    }
  }

  if (score <= 0) {
    return undefined;
  }
  return { node, score, reasons: [...new Set(reasons)] };
}

export function searchGraph(store: GraphStore, text: string, options: SearchOptions = {}): SearchResult[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const typeFilter = options.types ? new Set(options.types) : undefined;
  const results = store
    .nodes()
    .filter((node) => !typeFilter || typeFilter.has(node.type))
    .map((node) => scoreNode(node, tokens, text))
    .filter((result): result is SearchResult => Boolean(result))
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  return results.slice(0, options.limit ?? 20);
}
