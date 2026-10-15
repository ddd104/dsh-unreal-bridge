import { loadProjectConfig, type LoadProjectConfigOptions } from "../config/loadProjectConfig.js";
import { createProjectGraphClient } from "../graph/projectGraphClient.js";
import { indexDocuments } from "../index/documentIndexer.js";
import { writeArchitectureRules } from "../memory/architectureRules.js";
import { buildImplementationMap } from "../memory/implementationMemory.js";
import { MemoryStore } from "../memory/memoryStore.js";
import { writePatternLibrary } from "../memory/patternLibrary.js";
import { writeProjectCapsule } from "../memory/projectCapsule.js";
import { writeSystemMemory } from "../memory/systemMemory.js";
import { writeUeCacheMemory } from "../memory/ueCacheMemory.js";
import { writeValidationMemory } from "../memory/validationMemory.js";
import type { CommandResult } from "../types/memoryTypes.js";

export interface BuildMemoryOptions extends LoadProjectConfigOptions {
  docsOnly?: boolean;
  capsule?: boolean;
  systems?: boolean;
  patterns?: boolean;
}

export async function buildMemory(options: BuildMemoryOptions = {}): Promise<CommandResult> {
  const loaded = await loadProjectConfig(options);
  const indexResult = await indexDocuments(loaded);
  const store = new MemoryStore(loaded.resolvedMemoryOutputRoot);
  await store.writeManifest(await store.createManifest(loaded, indexResult.sources));
  const noSpecificSummaryTarget = !options.docsOnly && !options.capsule && !options.systems && !options.patterns;
  const generatedFiles: string[] = [];
  const summaryWarnings: string[] = [];
  let implementationMapPath: string | undefined;
  let implementationFeatures = 0;
  let implementationPatterns = 0;

  if (!options.docsOnly && (options.capsule || noSpecificSummaryTarget)) {
    const capsule = await writeProjectCapsule(loaded);
    if (capsule.outputPath) generatedFiles.push(capsule.outputPath);
    if (capsule.status === "missing") summaryWarnings.push("ProjectKnowledge/overview/project_purpose.md is missing; project capsule was not generated.");
    if (capsule.status === "missing_evidence") summaryWarnings.push("Project capsule generated with TODO / missing evidence.");
    const architecture = await writeArchitectureRules(loaded);
    if (architecture) {
      generatedFiles.push(architecture.path);
    } else {
      summaryWarnings.push("ProjectKnowledge/architecture/architecture_rules.md is missing; architecture rules cache was not generated.");
    }
    const validation = await writeValidationMemory(loaded);
    generatedFiles.push(...validation.files.map((file) => file.path));
  }

  if (!options.docsOnly && (options.systems || noSpecificSummaryTarget)) {
    const systems = await writeSystemMemory(loaded);
    if (systems) {
      generatedFiles.push(systems.systemMap.path);
      generatedFiles.push(...systems.systems.map((system) => system.summaryPath));
      if (systems.systems.some((system) => system.status === "missing_evidence")) {
        summaryWarnings.push("One or more system summaries were generated with TODO / missing evidence.");
      }
    } else {
      summaryWarnings.push("ProjectKnowledge/systems/*.md is missing; system memory was not generated.");
    }
  }

  if (!options.docsOnly && (options.patterns || noSpecificSummaryTarget)) {
    const patterns = await writePatternLibrary(loaded);
    if (patterns) {
      generatedFiles.push(patterns.output.path);
      if (patterns.patterns.some((pattern) => pattern.status === "missing_evidence")) {
        summaryWarnings.push("One or more patterns were generated with TODO / missing evidence.");
      }
    } else {
      summaryWarnings.push("ProjectKnowledge/patterns/*.md is missing; pattern library was not generated.");
    }
  }

  if (!options.docsOnly && noSpecificSummaryTarget) {
    const ueCache = await writeUeCacheMemory(loaded);
    generatedFiles.push(ueCache.outputPath);
    summaryWarnings.push(...ueCache.warnings);
    const implementation = await buildImplementationMap(loaded, {
      graphClient: createProjectGraphClient(loaded)
    });
    generatedFiles.push(implementation.outputPath, implementation.latestPath);
    summaryWarnings.push(...implementation.warnings);
    implementationMapPath = implementation.outputPath;
    implementationFeatures = implementation.map.features.length;
    implementationPatterns = implementation.map.patterns.length;
  }

  return {
    command: "memory build",
    projectId: loaded.config.projectId,
    phase: "docs-index",
    message: options.docsOnly ? "Document-only memory index built." : "Project Memory cache built.",
    warnings: [
      ...indexResult.warnings,
      ...summaryWarnings
    ],
    data: {
      configPath: loaded.configPath,
      memoryOutputRoot: loaded.config.memoryOutputRoot,
      knowledgeRoots: loaded.config.knowledgeRoots,
      documentsIndexed: indexResult.documentsIndexed,
      changedSources: indexResult.changedSources.length,
      unchangedSources: indexResult.unchangedSources.length,
      removedSources: indexResult.removedSources.length,
      documentsPath: indexResult.documentsPath,
      ftsPath: indexResult.ftsPath,
      manifestPath: store.manifestPath(),
      generatedFiles,
      implementationMapPath,
      implementationFeatures,
      implementationPatterns
    }
  };
}
