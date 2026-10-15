import path from "node:path";
import { summarizeDocument } from "./documentSummarizer.js";

export interface ExtractedPattern {
  id: string;
  title: string;
  status: "ok" | "missing_evidence";
  summary: string[];
}

export async function extractPatterns(sourcePath: string): Promise<ExtractedPattern[]> {
  const id = path.basename(sourcePath, path.extname(sourcePath));
  const summary = await summarizeDocument(sourcePath, id);
  return [
    {
      id,
      title: summary.title,
      status: summary.status,
      summary: summary.bullets
    }
  ];
}
