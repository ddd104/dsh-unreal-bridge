import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { summarizeUeCacheContent, type UeCacheSummary } from "../summarizers/ueAssetSummarizer.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";

export interface UeCacheMemoryEntry extends UeCacheSummary {
  schemaVersion: 1;
  generatedAt: string;
  sourcePaths: string[];
  sourceHash: string;
}

export interface UeCacheMemoryResult {
  outputPath: string;
  entries: UeCacheMemoryEntry[];
  warnings: string[];
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

async function walkJsonFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(fullPath)));
    } else if (entry.isFile() && [".json", ".jsonl"].includes(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function configuredUeCacheRoots(loaded: LoadedProjectConfig): string[] {
  const graph = loaded.config.graph as unknown as { ueCacheRoots?: Record<string, string> };
  return Object.values(graph.ueCacheRoots ?? {})
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(loaded.projectRoot, value));
}

export async function writeUeCacheMemory(loaded: LoadedProjectConfig): Promise<UeCacheMemoryResult> {
  const outputDir = path.join(loaded.resolvedMemoryOutputRoot, "ue-cache");
  const outputPath = path.join(outputDir, "summaries.jsonl");
  const generatedAt = new Date().toISOString();
  const entries: UeCacheMemoryEntry[] = [];
  const warnings: string[] = [];

  for (const root of configuredUeCacheRoots(loaded)) {
    if (!existsSync(root)) {
      warnings.push(`UE cache root not found: ${toProjectPath(loaded.projectRoot, root)}`);
      continue;
    }

    for (const filePath of await walkJsonFiles(root)) {
      const sourcePath = toProjectPath(loaded.projectRoot, filePath);
      try {
        const content = await readFile(filePath);
        const summary = summarizeUeCacheContent(filePath, content);
        entries.push({
          ...summary,
          schemaVersion: 1,
          generatedAt,
          sourcePaths: [sourcePath],
          sourceHash: createHash("sha256").update(content).digest("hex")
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`Skipped UE cache ${sourcePath}: ${reason}`);
      }
    }
  }

  entries.sort((a, b) => (a.assetPath ?? a.title).localeCompare(b.assetPath ?? b.title));
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}${entries.length ? "\n" : ""}`, "utf8");

  return {
    outputPath,
    entries,
    warnings
  };
}
