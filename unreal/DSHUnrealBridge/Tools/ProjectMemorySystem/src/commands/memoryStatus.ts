import { stat } from "node:fs/promises";
import { loadProjectConfig, type LoadProjectConfigOptions } from "../config/loadProjectConfig.js";
import { MemoryStore } from "../memory/memoryStore.js";
import type { CommandResult } from "../types/memoryTypes.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function memoryStatus(options: LoadProjectConfigOptions = {}): Promise<CommandResult> {
  const loaded = await loadProjectConfig(options);
  const store = new MemoryStore(loaded.resolvedMemoryOutputRoot);
  const memory = await store.status(loaded);
  const roots = await Promise.all(
    loaded.config.knowledgeRoots.map(async (root, index) => ({
      root,
      resolvedPath: loaded.resolvedKnowledgeRoots[index],
      exists: await pathExists(loaded.resolvedKnowledgeRoots[index])
    }))
  );

  return {
    command: "memory status",
    projectId: loaded.config.projectId,
    phase: "docs-index",
    message: `Project Memory status: ${"status" in memory ? memory.status : "missing"}.`,
    warnings: "warnings" in memory ? memory.warnings : [],
    data: {
      memory,
      configPath: loaded.configPath,
      projectRoot: loaded.projectRoot,
      memoryOutputRoot: loaded.resolvedMemoryOutputRoot,
      graph: {
        enabled: loaded.config.graph.enabled,
        mode: loaded.config.graph.mode
      },
      knowledgeRoots: roots
    }
  };
}
