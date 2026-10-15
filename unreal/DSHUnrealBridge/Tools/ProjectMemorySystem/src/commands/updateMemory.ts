import { loadProjectConfig, type LoadProjectConfigOptions } from "../config/loadProjectConfig.js";
import { createProjectGraphClient } from "../graph/projectGraphClient.js";
import { indexDocuments } from "../index/documentIndexer.js";
import { buildImplementationMap } from "../memory/implementationMemory.js";
import { MemoryStore } from "../memory/memoryStore.js";
import { writeUeCacheMemory } from "../memory/ueCacheMemory.js";
import type { CommandResult } from "../types/memoryTypes.js";

export async function updateMemory(options: LoadProjectConfigOptions = {}): Promise<CommandResult> {
  const loaded = await loadProjectConfig(options);
  const store = new MemoryStore(loaded.resolvedMemoryOutputRoot);
  const previousManifest = await store.readManifest();
  const indexResult = await indexDocuments(loaded, {
    incremental: true,
    previousSources: previousManifest?.sources ?? []
  });
  const ueCache = await writeUeCacheMemory(loaded);
  const implementation = await buildImplementationMap(loaded, {
    graphClient: createProjectGraphClient(loaded)
  });
  await store.writeManifest(await store.createManifest(loaded, indexResult.sources));

  return {
    command: "memory update",
    projectId: loaded.config.projectId,
    phase: "docs-index",
    message: previousManifest
      ? "Project Memory updated incrementally."
      : "Project Memory manifest was missing; performed a full document index rebuild.",
    warnings: [
      ...indexResult.warnings,
      ...ueCache.warnings,
      ...implementation.warnings
    ],
    data: {
      configPath: loaded.configPath,
      memoryOutputRoot: loaded.config.memoryOutputRoot,
      documentsIndexed: indexResult.documentsIndexed,
      changedSources: indexResult.changedSources,
      unchangedSources: indexResult.unchangedSources,
      removedSources: indexResult.removedSources,
      manifestPath: store.manifestPath(),
      ueCacheSummaries: ueCache.entries.length,
      ueCacheSummariesPath: ueCache.outputPath,
      implementationMapPath: implementation.outputPath,
      implementationFeatures: implementation.map.features.length,
      implementationPatterns: implementation.map.patterns.length
    }
  };
}
