import { readFile } from "node:fs/promises";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import { readIndexedDocuments, summarizeMarkdown } from "./documentSummarizer.js";

export interface ProjectSummary {
  title: string;
  status: "ok" | "missing_evidence";
  bullets: string[];
  indexedDocumentCount: number;
}

export async function summarizeProject(loaded: LoadedProjectConfig, sourcePath: string): Promise<ProjectSummary> {
  const text = await readFile(sourcePath, "utf8");
  const indexedDocumentCount = (await readIndexedDocuments(loaded)).length;
  return {
    ...summarizeMarkdown(text, loaded.config.projectId),
    indexedDocumentCount
  };
}
