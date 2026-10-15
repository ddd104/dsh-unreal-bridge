import path from "node:path";
import { summarizeDocument, type MarkdownSummary } from "./documentSummarizer.js";

export interface SystemSummary extends MarkdownSummary {
  systemId: string;
}

export async function summarizeSystem(sourcePath: string): Promise<SystemSummary> {
  const systemId = path.basename(sourcePath, path.extname(sourcePath));
  return {
    systemId,
    ...(await summarizeDocument(sourcePath, systemId))
  };
}
