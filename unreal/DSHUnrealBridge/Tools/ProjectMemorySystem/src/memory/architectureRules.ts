import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatedMarkdownHeader, sourceEvidence, summarizeMarkdown } from "../summarizers/documentSummarizer.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import type { GeneratedMemoryFile } from "./projectCapsule.js";

export interface ArchitectureRuleMemory {
  id: string;
  title: string;
  sourcePaths: string[];
  sourceHash: string;
  status: "ok" | "missing_evidence";
  summary: string[];
}

export async function writeArchitectureRules(loaded: LoadedProjectConfig): Promise<GeneratedMemoryFile | undefined> {
  const sourcePath = path.join(loaded.projectRoot, "ProjectKnowledge", "architecture", "architecture_rules.md");
  if (!existsSync(sourcePath)) return undefined;

  const [evidence, text] = await Promise.all([
    sourceEvidence(loaded.projectRoot, [sourcePath]),
    readFile(sourcePath, "utf8")
  ]);
  const summary = summarizeMarkdown(text, "Architecture Rules");
  const outputPath = path.join(loaded.resolvedMemoryOutputRoot, "architecture_rules.md");
  const body = [
    generatedMarkdownHeader(evidence),
    `# Architecture Rules: ${summary.title}`,
    "",
    `Status: ${summary.status}`,
    "",
    "## Extracted Rules",
    "",
    ...summary.bullets.map((bullet) => `- ${bullet}`),
    ""
  ].join("\n");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, "utf8");
  return {
    path: outputPath,
    sourcePaths: evidence.sourcePaths,
    sourceHash: evidence.sourceHash
  };
}

export function emptyArchitectureRules(): ArchitectureRuleMemory[] {
  return [];
}
