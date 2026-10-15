import type { MemorySearchResult } from "../types/memoryTypes.js";

export class VectorIndex {
  readonly enabled = false;

  search(_query: string): MemorySearchResult[] {
    return [];
  }
}
