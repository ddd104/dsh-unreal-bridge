import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceItem } from "../types/contextPackTypes.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import { rerankEvidenceItems } from "./reranker.js";

function scoreText(query: string, text: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export async function findExistingPatterns(query: string, loaded: LoadedProjectConfig, maxPatterns: number): Promise<EvidenceItem[]> {
  const patternsPath = path.join(loaded.resolvedMemoryOutputRoot, "patterns", "patterns.jsonl");
  if (!existsSync(patternsPath)) return [];
  const lines = (await readFile(patternsPath, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items = lines.map((line) => {
    const parsed = JSON.parse(line) as {
      id: string;
      title: string;
      summary?: string[];
      sourcePaths?: string[];
      sourceHash?: string;
      status?: string;
    };
    const excerpt = (parsed.summary ?? []).join("\n");
    return {
      id: parsed.id,
      title: parsed.title,
      sourcePaths: parsed.sourcePaths ?? [],
      sourceHash: parsed.sourceHash,
      excerpt,
      score: scoreText(query, `${parsed.title} ${excerpt}`),
      status: parsed.status
    } satisfies EvidenceItem;
  });
  return rerankEvidenceItems(items.filter((item) => (item.score ?? 0) > 0 || item.sourcePaths.length > 0)).slice(0, maxPatterns);
}
