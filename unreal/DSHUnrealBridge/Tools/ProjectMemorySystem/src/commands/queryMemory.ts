import { stat } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, type LoadProjectConfigOptions } from "../config/loadProjectConfig.js";
import { FullTextIndex } from "../index/fullTextIndex.js";
import type { CommandResult } from "../types/memoryTypes.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function queryMemory(text: string, options: LoadProjectConfigOptions = {}): Promise<CommandResult> {
  if (!text.trim()) {
    throw new Error("memory query requires non-empty <text>.");
  }

  const loaded = await loadProjectConfig(options);
  const ftsPath = path.join(loaded.resolvedMemoryOutputRoot, "index", "fts.sqlite");
  if (!(await pathExists(ftsPath))) {
    throw new Error(`Project Memory full-text index not found at ${ftsPath}. Run: memory build --docs-only`);
  }

  const index = FullTextIndex.open(ftsPath);
  const results = index.search(text);
  index.close();

  return {
    command: "memory query",
    projectId: loaded.config.projectId,
    phase: "docs-index",
    message: "Project Memory full-text query completed.",
    warnings: [],
    data: {
      query: text,
      results
    }
  };
}
