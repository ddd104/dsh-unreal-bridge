import { existsSync } from "node:fs";
import path from "node:path";
import { FullTextIndex } from "../index/fullTextIndex.js";
import { rerankSearchResults } from "./reranker.js";
import type { LoadedProjectConfig, MemorySearchResult } from "../types/memoryTypes.js";

export interface HybridSearchResult {
  query: string;
  results: MemorySearchResult[];
  warnings: string[];
}

export async function hybridSearch(query: string, loaded: LoadedProjectConfig, limit = 12): Promise<HybridSearchResult> {
  const ftsPath = path.join(loaded.resolvedMemoryOutputRoot, "index", "fts.sqlite");
  if (!existsSync(ftsPath)) {
    return {
      query,
      results: [],
      warnings: [`Project Memory full-text index not found at ${ftsPath}. Run memory build --docs-only.`]
    };
  }

  const index = FullTextIndex.open(ftsPath);
  try {
    const resultMap = new Map<string, MemorySearchResult>();
    for (const result of index.search(query, limit)) {
      resultMap.set(result.id, result);
    }
    const tokens = query.split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 1);
    for (const token of tokens) {
      for (const result of index.search(token, limit)) {
        const existing = resultMap.get(result.id);
        if (existing) {
          existing.score += result.score * 0.5;
          if (!existing.excerpt.includes(result.excerpt)) existing.excerpt = `${existing.excerpt}\n${result.excerpt}`;
        } else {
          resultMap.set(result.id, {
            ...result,
            score: result.score * 0.75
          });
        }
      }
    }
    return {
      query,
      results: rerankSearchResults([...resultMap.values()]).slice(0, limit),
      warnings: []
    };
  } finally {
    index.close();
  }
}
