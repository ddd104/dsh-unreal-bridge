import type { LoadedProjectConfig, MemorySearchResult } from "../types/memoryTypes.js";
import { hybridSearch } from "./hybridSearch.js";

export async function findRelevantDocs(query: string, loaded: LoadedProjectConfig, maxDocs: number): Promise<{ docs: MemorySearchResult[]; warnings: string[] }> {
  const result = await hybridSearch(query, loaded, maxDocs * 3);
  return {
    docs: result.results.slice(0, maxDocs),
    warnings: result.warnings
  };
}
