import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatedMarkdownHeader, sourceEvidence, toProjectPath } from "../summarizers/documentSummarizer.js";
import { summarizeSystem } from "../summarizers/systemSummarizer.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import type { GeneratedMemoryFile } from "./projectCapsule.js";

export interface SystemMemory {
  systemId: string;
  title: string;
  status: "ok" | "missing_evidence";
  sourcePaths: string[];
  sourceHash: string;
  summaryPath: string;
  notes: string[];
}

async function markdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return entry.isFile() && name.endsWith(".md") && name !== "readme.md";
    })
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export async function writeSystemMemory(loaded: LoadedProjectConfig): Promise<{ systemMap: GeneratedMemoryFile; systems: SystemMemory[] } | undefined> {
  const systemsDir = path.join(loaded.projectRoot, "ProjectKnowledge", "systems");
  const files = await markdownFiles(systemsDir);
  if (files.length === 0) return undefined;

  const summariesDir = path.join(loaded.resolvedMemoryOutputRoot, "summaries", "systems");
  await mkdir(summariesDir, { recursive: true });
  const systems: SystemMemory[] = [];

  for (const file of files) {
    const summary = await summarizeSystem(file);
    const evidence = await sourceEvidence(loaded.projectRoot, [file]);
    const outputPath = path.join(summariesDir, `${summary.systemId}.md`);
    const body = [
      generatedMarkdownHeader(evidence),
      `# System Summary: ${summary.title}`,
      "",
      `System ID: ${summary.systemId}`,
      `Status: ${summary.status}`,
      "",
      "## Notes",
      "",
      ...summary.bullets.map((bullet) => `- ${bullet}`),
      ""
    ].join("\n");
    await writeFile(outputPath, body, "utf8");
    systems.push({
      systemId: summary.systemId,
      title: summary.title,
      status: summary.status,
      sourcePaths: evidence.sourcePaths,
      sourceHash: evidence.sourceHash,
      summaryPath: toProjectPath(loaded.projectRoot, outputPath),
      notes: summary.bullets
    });
  }

  const mapEvidence = await sourceEvidence(loaded.projectRoot, files);
  const mapPath = path.join(loaded.resolvedMemoryOutputRoot, "system_map.json");
  await mkdir(path.dirname(mapPath), { recursive: true });
  await writeFile(
    mapPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sourcePaths: mapEvidence.sourcePaths,
        sourceHash: mapEvidence.sourceHash,
        systems
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    systemMap: {
      path: mapPath,
      sourcePaths: mapEvidence.sourcePaths,
      sourceHash: mapEvidence.sourceHash
    },
    systems
  };
}

export function createEmptySystemMemory(systemId: string): SystemMemory {
  return {
    systemId,
    title: systemId,
    status: "missing_evidence",
    sourcePaths: [],
    sourceHash: "",
    summaryPath: "",
    notes: []
  };
}
