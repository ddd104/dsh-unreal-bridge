import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceEvidence } from "../summarizers/documentSummarizer.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import type { GeneratedMemoryFile } from "./projectCapsule.js";

export interface ValidationMemory {
  files: GeneratedMemoryFile[];
}

export async function writeValidationMemory(loaded: LoadedProjectConfig): Promise<ValidationMemory> {
  const validationDir = path.join(loaded.projectRoot, "ProjectKnowledge", "validation");
  if (!existsSync(validationDir)) return { files: [] };
  const entries = await readdir(validationDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(validationDir, entry.name))
    .sort();
  const outputDir = path.join(loaded.resolvedMemoryOutputRoot, "validation");
  await mkdir(outputDir, { recursive: true });
  const files: GeneratedMemoryFile[] = [];

  for (const file of jsonFiles) {
    const evidence = await sourceEvidence(loaded.projectRoot, [file]);
    let content: unknown;
    try {
      content = JSON.parse(await readFile(file, "utf8"));
    } catch {
      content = {
        status: "missing_evidence",
        warning: "Source JSON could not be parsed."
      };
    }
    const outputPath = path.join(outputDir, path.basename(file));
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          sourcePaths: evidence.sourcePaths,
          sourceHash: evidence.sourceHash,
          content
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    files.push({
      path: outputPath,
      sourcePaths: evidence.sourcePaths,
      sourceHash: evidence.sourceHash
    });
  }

  return { files };
}

export function createEmptyValidationMemory(): ValidationMemory {
  return {
    files: []
  };
}
